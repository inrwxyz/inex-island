// WebRTC Direct P2P Link & Peer File Transfer (no server, direct browser-to-browser data channel)
import { appState } from '../../core/state.js';
import { loadSettings } from '../../core/settings.js';
import { bus } from '../../core/bus.js';
import { invokeTauri } from '../../core/tauri.js';
import { syncPopupSize } from '../bluetooth/index.js';
import { updateCompactStateClasses } from '../../core/views.js';
import { updateTimerChip } from '../timer/index.js';
import { updateDropTile, updateDropRailBadge } from './rail.js';
import { dropActive } from './quick-share.js';
import type { TrayFileItem } from '../../../types/models.js';

export type DirectPhase = 'standby' | 'generating' | 'offer-ready' | 'joining' | 'reply-ready' | 'connecting' | 'connected';

export interface DirectUiState {
  phase: DirectPhase;
  code?: string;
  replyCode?: string;
  expiresAt?: number;
  replyCopied?: boolean;
  peerName?: string;
}

export interface PeerSendState {
  files: TrayFileItem[];
  accepted: boolean;
  active: boolean;
  cancelled: boolean;
  completed: boolean;
  sent: number;
  total: number;
}

export interface PeerRecvCur {
  id: string;
  buf: Uint8Array[];
  bufBytes: number;
}

export interface PeerRecvState {
  files: Array<{ name: string; size?: number }>;
  fromName: string;
  accepted: boolean;
  active: boolean;
  total: number;
  got: number;
  cur: PeerRecvCur | null;
}

export interface RtcPeerEntry {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  name: string;
  rx: Promise<void>;
  lastSeen: number;
  hb: ReturnType<typeof setInterval> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  connTimer: ReturnType<typeof setTimeout> | null;
  offerTimer: ReturnType<typeof setTimeout> | null;
  pendingIce: RTCIceCandidateInit[];
  send: PeerSendState | null;
  recv: PeerRecvState | null;
  isDirect: boolean;
}

interface HostSession {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  sid: string;
  code: string;
  expiresAt: number;
}

interface JoinSession {
  pc: RTCPeerConnection;
  replyCode: string;
  expiresAt: number;
}

interface XferStatsState {
  bytes: number;
  lastBytes: number;
  lastT: number;
  route: string;
  speed: number;
  pctT: number;
  timer: ReturnType<typeof setInterval> | null;
}

interface CodecApi {
  parseSdp: (sdp: string) => unknown;
  toSdp: (info: unknown, kind: 'offer' | 'answer') => string;
  randomCode: () => string;
  nowMinutes: () => number;
  encode: (payload: Record<string, unknown>) => string;
  decode: (code: string) => { type: string; code: string; minutes: number; info: unknown };
}

export const CODE_TTL_MS = 3 * 60 * 1000; // 3 minutes validity
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export const CHUNK = 128 * 1024;
export const READ_BLOCK = 4 * 1024 * 1024;
export const HIGH_WATER = 4 * 1024 * 1024;
export const LOW_WATER = 1024 * 1024;
export const FLUSH_BYTES = 4 * 1024 * 1024;
export const P2P_IMG_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;

export const rtcPeers = new Map<string, RtcPeerEntry>();
export const myPeerId = 'PC-' + Math.floor(10000 + Math.random() * 89999);
export function getMyDeviceName(): string {
  const SET = loadSettings();
  return SET.share?.deviceName || localStorage.getItem('island_pc_name') || myPeerId;
}

export let directHostSession: HostSession | null = null;
export let directJoinSession: JoinSession | null = null;
export let directTimer: ReturnType<typeof setTimeout> | null = null;
export let directTick: ReturnType<typeof setInterval> | null = null;
export let directGenSeq = 0;
export let p2pScanning = false;
export let directUi: DirectUiState = { phase: 'standby' };

const ESC_P2P_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function escHtml(s: unknown): string {
  return String(s || '').replace(/[&<>"]/g, (c) => ESC_P2P_MAP[c] || c);
}

export function showP2PToast(icon: string, title: string, ms?: number): void {
  bus.emit('toast:show', { icon, title, ms });
  if (typeof window.showToast === 'function') {
    try { window.showToast(icon, title, ms); } catch { /* ignore */ }
  }
}

export function playP2PSound(category: string, kind: string): void {
  bus.emit('sound:play', { category, kind });
  if (typeof window.playStatusSound === 'function') {
    try { window.playStatusSound(category, kind); } catch { /* ignore */ }
  }
}

export function waitCandidatesGathered(pc: RTCPeerConnection, maxWaitMs = 4500): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    let softTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      if (softTimer) clearTimeout(softTimer);
      resolve();
    };
    if (pc.iceGatheringState === 'complete') return resolve();

    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        finish();
      } else {
        const c = e.candidate;
        const isSrflx = c.type === 'srflx' || /\btyp\s+srflx\b/i.test(c.candidate || '');
        if (isSrflx && !softTimer) softTimer = setTimeout(finish, 600);
      }
    };
    setTimeout(finish, maxWaitMs);
  });
}

export function directSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function setDirectState(state?: DirectUiState): void {
  directUi = state || { phase: 'standby' };
  renderP2PView();
}

export function clearDirectExpiry(): void {
  if (directTimer) clearTimeout(directTimer);
  directTimer = null;
}

export function armDirectExpiry(expiresAt: number): void {
  clearDirectExpiry();
  directTimer = setTimeout(() => {
    directTimer = null;
    if (rtcPeers.has('direct-peer')) return;
    closeDirectSessions();
    setDirectState({ phase: 'standby' });
    showP2PToast('lock', 'Code expired', 1800);
  }, Math.max(1000, expiresAt - Date.now()));
}

export function closeDirectSessions(): void {
  clearDirectExpiry();
  if (directHostSession) {
    try { directHostSession.pc.close(); } catch (err) { console.warn('P2P host pc close error:', err); }
    directHostSession = null;
  }
  if (directJoinSession) {
    try { directJoinSession.pc.close(); } catch (err) { console.warn('P2P join pc close error:', err); }
    directJoinSession = null;
  }
}

export function releaseDirectSessions(): void {
  clearDirectExpiry();
  directHostSession = null;
  directJoinSession = null;
}

export function directPhaseLabel(): string {
  switch (directUi.phase) {
    case 'generating': return 'Generating\u2026';
    case 'offer-ready': return 'Waiting for friend';
    case 'joining': return 'Joining\u2026';
    case 'reply-ready': return 'Send reply back';
    case 'connecting': return 'Connecting\u2026';
    default: return 'Standby';
  }
}

export function p2pHintText(): string {
  switch (directUi.phase) {
    case 'generating': return 'Creating code\u2026';
    case 'offer-ready': return 'Click QR to copy, then paste reply.';
    case 'joining': return 'Joining\u2026';
    case 'reply-ready': return directUi.replyCopied ? 'Reply copied. Send it back.' : 'Click QR to copy reply, send back.';
    case 'connecting': return 'Connecting\u2026';
    default: return 'Generate or paste a QR.';
  }
}

export function updateDirectCountdown(): void {
  const el = document.getElementById('p2p-expiry-timer');
  if (!el || !directUi.expiresAt) return;
  const rem = Math.max(0, Math.floor((directUi.expiresAt - Date.now()) / 1000));
  el.textContent = `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
}

export function drawP2PQr(canvas: HTMLCanvasElement, text: string): void {
  const t = String(text).toUpperCase();
  const qrFactory = (window.qrcode || window.QRCode) as unknown as ((n: number, lvl: string) => {
    addData: (data: string, mode?: string) => void;
    make: () => void;
    getModuleCount: () => number;
    isDark: (r: number, c: number) => boolean;
  }) | undefined;
  if (!qrFactory) return;
  let qr: ReturnType<typeof qrFactory>;
  try {
    qr = qrFactory(0, 'L');
    qr.addData(t, 'Alphanumeric');
    qr.make();
  } catch {
    qr = qrFactory(0, 'L');
    qr.addData(t, 'Byte');
    qr.make();
  }
  const n = qr.getModuleCount();
  const quiet = 4;
  const px = 10;
  const size = (n + quiet * 2) * px;
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) g.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
    }
  }
}

const copySlotTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export async function copyP2PQr(fallbackCode = ''): Promise<boolean> {
  const slot = document.getElementById('code-display-box');
  const cv = document.getElementById('p2p-qr-canvas') as HTMLCanvasElement | null;
  if (!slot || !cv || cv.classList.contains('hidden')) return false;
  let copiedKind = '';
  try {
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
    if (blob && window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
      copiedKind = 'image';
    }
  } catch {
    copiedKind = '';
  }
  if (!copiedKind) {
    try {
      const g = cv.getContext('2d', { willReadFrequently: true });
      const img = g && g.getImageData(0, 0, cv.width, cv.height);
      if (img && img.data) {
        const ok = await invokeRaw('set_clipboard_image', new Uint8Array(img.data.buffer), {
          'x-width': String(cv.width),
          'x-height': String(cv.height)
        });
        if (ok) copiedKind = 'image';
      }
    } catch {
      copiedKind = '';
    }
  }
  if (!copiedKind && fallbackCode) {
    try {
      const ok = await invokeTauri('set_clipboard_text', { text: String(fallbackCode) });
      if (ok) copiedKind = 'text';
    } catch {
      copiedKind = '';
    }
  }
  if (!copiedKind) return false;
  const toast = document.getElementById('p2p-qr-toast');
  if (toast) toast.textContent = copiedKind === 'text' ? 'Code copied \u2713' : 'Copied \u2713';
  slot.classList.add('copied');
  const prevT = copySlotTimers.get(slot);
  if (prevT) clearTimeout(prevT);
  copySlotTimers.set(slot, setTimeout(() => slot.classList.remove('copied'), 1200));
  return true;
}

let jsQrLoading: Promise<void> | null = null;
export function loadJsQr(): Promise<void> {
  if (typeof window.jsQR === 'function') return Promise.resolve();
  if (!jsQrLoading) {
    jsQrLoading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'jsqr.js';
      el.onload = () => resolve();
      el.onerror = () => {
        jsQrLoading = null;
        el.remove();
        reject(new Error('QR reader missing (run npm install)'));
      };
      document.head.appendChild(el);
    });
  }
  return jsQrLoading;
}

export async function decodeP2PImage(blob: Blob): Promise<string | null> {
  await loadJsQr();
  const bmp = await window.createImageBitmap(blob);
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!g || !window.jsQR) {
    try { bmp.close(); } catch { /* ignore */ }
    return null;
  }
  const base = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  for (const k of [1, 0.6, 0.4]) {
    const w = Math.max(60, Math.round(bmp.width * base * k));
    const h = Math.max(60, Math.round(bmp.height * base * k));
    cv.width = w;
    cv.height = h;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    const hit = window.jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (hit && hit.data) {
      try { bmp.close(); } catch { /* ignore */ }
      return hit.data;
    }
  }
  try { bmp.close(); } catch { /* ignore */ }
  return null;
}

export function setP2PScanning(v: boolean): void {
  p2pScanning = v;
  renderP2PView();
}

export async function handleP2PImage(blob: Blob | null | undefined): Promise<void> {
  const ph = directUi.phase;
  if (!blob || p2pScanning || ph === 'generating' || ph === 'joining' || ph === 'connecting' || appState.peers.length > 0) return;
  setP2PScanning(true);
  let text: string | null = null;
  let err: unknown = null;
  const minShow = directSleep(600);
  try {
    text = await decodeP2PImage(blob);
  } catch (e) {
    err = e;
  }
  await minShow;
  setP2PScanning(false);
  if (err) {
    showP2PToast('lock', (err as Error)?.message || 'Could not read the image', 2600);
    return;
  }
  if (!text) {
    showP2PToast('lock', 'No QR found in that image', 2200);
    return;
  }
  handleDirectCodeInput(text);
}

export async function handleP2PPath(path: string): Promise<void> {
  try {
    const buf = await invokeTauri<ArrayBuffer | Uint8Array | number[] | null>('read_image_file', { path });
    if (buf) {
      const part = buf instanceof ArrayBuffer ? buf : new Uint8Array(buf);
      await handleP2PImage(new Blob([part]));
    }
  } catch {
    showP2PToast('lock', 'Could not read that file', 2200);
  }
}

export function p2pViewActive(): boolean {
  const v = document.getElementById('view-p2p');
  return !!(v && v.classList.contains('active'));
}

export function p2pNativeDrop(p: { type: string; paths?: string[] } | null | undefined): boolean {
  if (!p2pViewActive() || !p) return false;
  const slot = document.getElementById('code-display-box');
  if (p.type === 'enter' || p.type === 'over') {
    slot?.classList.add('drop-over');
    return true;
  }
  if (p.type === 'leave') {
    slot?.classList.remove('drop-over');
    return true;
  }
  if (p.type === 'drop') {
    slot?.classList.remove('drop-over');
    const img = (p.paths || []).find((x) => P2P_IMG_EXT.test(x));
    if (img) void handleP2PPath(img);
    else showP2PToast('lock', 'Drop a QR image here', 2000);
    return true;
  }
  return false;
}

export function renderP2PView(): void {
  const get = (id: string): HTMLElement | null => document.getElementById(id);
  const gen = get('btn-gen-code');
  if (!gen) return;
  const ph = directUi.phase;
  const connected = appState.peers.length > 0;
  const hosting = !connected && ph === 'offer-ready';
  const replying = !connected && ph === 'reply-ready';

  const slot = get('code-display-box');
  const cv = get('p2p-qr-canvas') as HTMLCanvasElement | null;
  const idle = get('p2p-slot-idle');
  const code = hosting ? (directUi.code || '') : (replying ? (directUi.replyCode || '') : '');
  if (slot) {
    slot.classList.toggle('hidden', connected || ph === 'connecting');
    slot.classList.toggle('has-qr', !!code);
    slot.classList.toggle('scanning', p2pScanning || ph === 'joining');
  }
  if (cv) cv.classList.toggle('hidden', !code);
  if (idle) idle.classList.toggle('hidden', !!code);
  gen.classList.toggle('hidden', !(ph === 'standby' || ph === 'generating'));
  gen.classList.toggle('busy', ph === 'generating');
  gen.textContent = ph === 'generating' ? 'Generating\u2026' : 'Generate';
  if (slot && cv && code) {
    if (slot.dataset.shown !== code) {
      slot.dataset.shown = code;
      drawP2PQr(cv, code);
      slot.classList.remove('pop');
      void slot.offsetWidth;
      slot.classList.add('pop');
    }
  } else if (slot) {
    slot.dataset.shown = '';
    slot.classList.remove('copied');
  }

  get('btn-exit-room')?.classList.toggle('hidden', connected || ph === 'standby');

  const timerEl = get('p2p-expiry-timer');
  const showTimer = hosting || replying;
  if (timerEl) timerEl.classList.toggle('hidden', !showTimer);
  if (showTimer) {
    updateDirectCountdown();
    if (!directTick) directTick = setInterval(updateDirectCountdown, 1000);
  } else if (directTick) {
    clearInterval(directTick);
    directTick = null;
  }

  if (!connected) {
    const hint = document.querySelector('#p2p-peers-list .empty-hint');
    if (hint) hint.textContent = p2pHintText();
  }
  refreshStatusPill();
}

export function registerDirectPeer(pc: RTCPeerConnection, dc: RTCDataChannel, name: string): RtcPeerEntry {
  const entry: RtcPeerEntry = {
    pc, dc, name,
    rx: Promise.resolve(), lastSeen: Date.now(),
    hb: null, graceTimer: null, connTimer: null, offerTimer: null,
    pendingIce: [], send: null, recv: null,
    isDirect: true
  };
  rtcPeers.set('direct-peer', entry);
  setupDataChannel('direct-peer', dc);

  entry.connTimer = setTimeout(() => {
    if (rtcPeers.get('direct-peer') === entry && dc.readyState !== 'open') {
      cleanupPeer('direct-peer');
      showP2PToast('lock', 'Connection failed', 2200);
    }
  }, 30000);

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    } else if (st === 'disconnected') {
      if (!entry.graceTimer) {
        entry.graceTimer = setTimeout(() => {
          if (rtcPeers.get('direct-peer') === entry && pc.connectionState !== 'connected') cleanupPeer('direct-peer');
        }, 5000);
      }
    } else if (st === 'failed' || st === 'closed') {
      if (rtcPeers.get('direct-peer') === entry) cleanupPeer('direct-peer');
    }
  };

  dc.addEventListener('open', () => {
    if (rtcPeers.get('direct-peer') === entry) setDirectState({ phase: 'connected', peerName: entry.name });
  });

  releaseDirectSessions();
  setDirectState({ phase: 'connecting' });
  return entry;
}

export async function handleDirectGenOffer(): Promise<void> {
  if (rtcPeers.has('direct-peer')) return;
  if (directUi.phase === 'generating' || directUi.phase === 'joining') return;
  closeDirectSessions();
  const tok = ++directGenSeq;
  setDirectState({ phase: 'generating' });
  let pc: RTCPeerConnection | null = null;
  try {
    const C = window.inexIslandCodec as unknown as CodecApi | undefined;
    if (!C) throw new Error('P2P codec not loaded.');
    pc = new window.RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('inex-p2p', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await Promise.all([waitCandidatesGathered(pc, 4500), directSleep(450)]);
    if (tok !== directGenSeq) {
      try { pc.close(); } catch (err) { console.warn('P2P pc close error:', err); }
      return;
    }

    const info = C.parseSdp(pc.localDescription!.sdp);
    const sid = C.randomCode();
    const code = C.encode({ type: 'offer', code: sid, minutes: C.nowMinutes(), info });
    const expiresAt = Date.now() + CODE_TTL_MS;
    directHostSession = { pc, dc, sid, code, expiresAt };
    armDirectExpiry(expiresAt);
    setDirectState({ phase: 'offer-ready', code, expiresAt });
  } catch (err) {
    try { if (pc) pc.close(); } catch (e) { console.warn('P2P pc close err:', e); }
    if (tok === directGenSeq) {
      setDirectState({ phase: 'standby' });
      showP2PToast('lock', (err as Error)?.message || 'Could not create code', 2400);
    }
  }
}

export async function handleDirectJoinOffer(hostCode: string): Promise<void> {
  if (rtcPeers.has('direct-peer')) return;
  closeDirectSessions();
  const tok = ++directGenSeq;
  setDirectState({ phase: 'joining' });
  let pc: RTCPeerConnection | null = null;
  try {
    const C = window.inexIslandCodec as unknown as CodecApi | undefined;
    if (!C) throw new Error('P2P codec not loaded.');
    const dec = C.decode(hostCode);
    if (dec.type !== 'offer') throw new Error('This is not a host code.');
    if (C.nowMinutes() - dec.minutes > Math.ceil(CODE_TTL_MS / 60000)) throw new Error('Code expired. Ask for a new one.');

    const capturedPc = new window.RTCPeerConnection(RTC_CONFIG);
    pc = capturedPc;
    capturedPc.ondatachannel = (e) => registerDirectPeer(capturedPc, e.channel, 'Direct Host');
    await capturedPc.setRemoteDescription(new window.RTCSessionDescription({ type: 'offer', sdp: C.toSdp(dec.info, 'offer') }));
    await capturedPc.setLocalDescription(await capturedPc.createAnswer());
    await Promise.all([waitCandidatesGathered(capturedPc, 4500), directSleep(450)]);
    if (tok !== directGenSeq) {
      try { capturedPc.close(); } catch (err) { console.warn('P2P pc close error:', err); }
      return;
    }

    const replyCode = C.encode({ type: 'answer', code: dec.code, info: C.parseSdp(capturedPc.localDescription!.sdp) });
    const expiresAt = Date.now() + CODE_TTL_MS;
    directJoinSession = { pc: capturedPc, replyCode, expiresAt };
    armDirectExpiry(expiresAt);
    setDirectState({ phase: 'reply-ready', replyCode, expiresAt, replyCopied: false });
    await directSleep(60);
    const copied = await copyP2PQr(replyCode);
    if (directUi.phase === 'reply-ready' && directUi.replyCode === replyCode) {
      setDirectState({ phase: 'reply-ready', replyCode, expiresAt, replyCopied: !!copied });
    }
    if (copied) showP2PToast('done', 'Reply QR copied', 1600);
    else showP2PToast('info', 'Click QR to copy reply', 2200);
  } catch (err) {
    try { if (pc) pc.close(); } catch (e) { console.warn('P2P pc close err:', e); }
    if (tok === directGenSeq) {
      setDirectState({ phase: 'standby' });
      showP2PToast('lock', (err as Error)?.message || 'Could not join', 2600);
    }
  }
}

export async function handleDirectAcceptReply(replyCode: string): Promise<void> {
  const s = directHostSession;
  if (!s) {
    showP2PToast('lock', 'Generate a code first', 2200);
    return;
  }
  const C = window.inexIslandCodec as unknown as CodecApi | undefined;
  let dec: ReturnType<CodecApi['decode']>;
  try {
    if (!C) throw new Error('P2P codec not loaded.');
    dec = C.decode(replyCode);
    if (dec.type !== 'answer') throw new Error('Paste the reply code from your friend.');
    if (dec.code !== s.sid) throw new Error('This reply is for a different code.');
  } catch (err) {
    showP2PToast('lock', (err as Error)?.message || 'Invalid reply code', 2600);
    return;
  }
  directHostSession = null;
  clearDirectExpiry();
  try {
    await s.pc.setRemoteDescription(new window.RTCSessionDescription({ type: 'answer', sdp: C!.toSdp(dec.info, 'answer') }));
    registerDirectPeer(s.pc, s.dc, 'Direct Partner');
  } catch {
    try { s.pc.close(); } catch (e) { console.warn('P2P pc close error:', e); }
    setDirectState({ phase: 'standby' });
    showP2PToast('lock', 'Could not connect. Try a new code', 2600);
  }
}

export function handleDirectCodeInput(raw: unknown): boolean {
  const text = String(raw || '').trim();
  if (!text) return false;
  const ph = directUi.phase;
  if (ph === 'generating' || ph === 'joining' || ph === 'connecting') return false;
  const C = window.inexIslandCodec as unknown as CodecApi | undefined;
  if (!C) {
    showP2PToast('lock', 'P2P codec not loaded', 2200);
    return false;
  }
  let dec: ReturnType<CodecApi['decode']>;
  try {
    dec = C.decode(text);
  } catch (err) {
    showP2PToast('lock', (err as Error)?.message || 'Invalid code', 2400);
    return false;
  }
  if (dec.type === 'offer') {
    if (ph === 'offer-ready') {
      showP2PToast('lock', 'You made a code. Paste the reply code, or Cancel first', 3000);
      return false;
    }
    void handleDirectJoinOffer(text);
  } else {
    void handleDirectAcceptReply(text);
  }
  return true;
}

export function handleDirectDisconnect(): void {
  directGenSeq++;
  closeDirectSessions();
  if (rtcPeers.has('direct-peer')) {
    disconnectPeer('direct-peer');
    return;
  }
  setDirectState({ phase: 'standby' });
}

export function setupDataChannel(peerId: string, dc: RTCDataChannel): void {
  const entry = rtcPeers.get(peerId);
  if (!entry) return;
  entry.dc = dc;
  dc.binaryType = 'arraybuffer';

  dc.onopen = () => {
    entry.lastSeen = Date.now();
    if (entry.connTimer) clearTimeout(entry.connTimer);
    dc.send(JSON.stringify({ type: 'hello', name: getMyDeviceName() }));
    entry.hb = setInterval(() => {
      if (dc.readyState !== 'open') return;
      if (Date.now() - entry.lastSeen > 9000) {
        cleanupPeer(peerId);
        return;
      }
      try { dc.send('{"type":"ping"}'); } catch (err) { console.warn('P2P ping err:', err); }
    }, 2000);
    syncConnectedPeersList();
  };

  dc.onclose = () => {
    if (rtcPeers.get(peerId) === entry) cleanupPeer(peerId);
  };

  dc.onmessage = (e) => {
    entry.lastSeen = Date.now();
    const data = e.data;
    entry.rx = entry.rx
      .then(() => onPeerData(peerId, entry, data))
      .catch((err) => console.warn('P2P rx error:', err));
  };
}

export async function onPeerData(peerId: string, entry: RtcPeerEntry, data: string | ArrayBuffer): Promise<void> {
  if (typeof data === 'string') {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    await handlePeerMessage(peerId, entry, msg);
  } else {
    await handleIncomingChunk(peerId, entry, data);
  }
}

export function syncConnectedPeersList(): void {
  const list: Array<{ id: string; name: string }> = [];
  for (const [id, entry] of rtcPeers.entries()) {
    if (entry.dc && entry.dc.readyState === 'open') {
      list.push({ id, name: entry.name || id });
    }
  }
  appState.peers = list.slice(0, 5);

  const sel = appState.traySelect;
  if (sel && !appState.peers.some((p) => p.id === sel.peerId)) {
    appState.traySelect = null;
    bus.emit('tray:update');
  }
  renderPeersUI();
}

export function dropTransferState(entry: RtcPeerEntry): void {
  if (entry.send) {
    entry.send.cancelled = true;
    entry.send = null;
  }
  if (entry.recv) {
    if (entry.recv.cur) void tryInvoke('recv_abort', { id: entry.recv.cur.id });
    entry.recv = null;
  }
}

export function cleanupPeer(peerId: string): void {
  const entry = rtcPeers.get(peerId);
  if (entry) {
    rtcPeers.delete(peerId);
    if (entry.hb) clearInterval(entry.hb);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    if (entry.connTimer) clearTimeout(entry.connTimer);
    if (entry.offerTimer) clearTimeout(entry.offerTimer);
    dropTransferState(entry);
    try {
      if (entry.dc) {
        entry.dc.onclose = null;
        entry.dc.close();
      }
    } catch (err) {
      console.warn('P2P dc close err:', err);
    }
    try {
      if (entry.pc) entry.pc.close();
    } catch (err) {
      console.warn('P2P pc close err:', err);
    }
  }
  if (peerId === 'direct-peer') {
    closeDirectSessions();
    setDirectState({ phase: 'standby' });
  }
  syncConnectedPeersList();
  refreshTransferUI();
}

export function disconnectPeer(peerId: string): void {
  const entry = rtcPeers.get(peerId);
  if (entry && entry.dc && entry.dc.readyState === 'open') {
    try { entry.dc.send(JSON.stringify({ type: 'bye', peerId: myPeerId })); } catch (err) {
      console.warn('P2P bye send error:', err);
    }
  }
  cleanupPeer(peerId);
  showP2PToast('unlock', 'Disconnected', 1400);
}

export async function tryInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try { return await invokeTauri<T>(cmd, args); } catch (e) { console.warn(cmd, e); return null; }
}

export async function invokeRaw(cmd: string, bytes: Uint8Array, headers: Record<string, string>): Promise<unknown> {
  if (window.__TAURI__ && window.__TAURI__.core) {
    const rawInvoke = window.__TAURI__.core.invoke as unknown as (c: string, b: Uint8Array, opts: { headers: Record<string, string> }) => Promise<unknown>;
    return await rawInvoke(cmd, bytes, { headers });
  }
  return null;
}

export function waitBuffered(dc: RTCDataChannel, limit: number): Promise<void> {
  return new Promise((resolve) => {
    if (dc.readyState !== 'open' || dc.bufferedAmount <= limit) return resolve();
    dc.bufferedAmountLowThreshold = limit;
    let t: ReturnType<typeof setInterval> | null = null;
    const done = (): void => {
      dc.removeEventListener('bufferedamountlow', done);
      if (t) clearInterval(t);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    t = setInterval(() => {
      if (dc.readyState !== 'open' || dc.bufferedAmount <= limit) done();
    }, 200);
  });
}

export function offerFilesToPeer(peerId: string, files: TrayFileItem[]): void {
  const entry = rtcPeers.get(peerId);
  if (!entry || !entry.dc || entry.dc.readyState !== 'open' || files.length === 0) return;
  if (entry.send || entry.recv) return;

  entry.send = {
    files: [...files],
    accepted: false,
    active: false,
    cancelled: false,
    completed: false,
    sent: 0,
    total: files.reduce((a, f) => a + (f.size || 0), 0)
  };
  entry.dc.send(JSON.stringify({
    type: 'file-offer',
    files: files.map((f) => ({ name: f.name, size: f.size })),
    fromName: getMyDeviceName()
  }));
  entry.offerTimer = setTimeout(() => {
    if (entry.send && !entry.send.active) abortTransfer(peerId, true);
  }, 120000);
  refreshTransferUI();
}

export function acceptPeerFileOffer(peerId: string): void {
  const entry = rtcPeers.get(peerId);
  const r = entry && entry.recv;
  if (!entry || !r || r.accepted || !entry.dc || entry.dc.readyState !== 'open') return;
  r.accepted = true;
  r.active = true;
  beginTransferStats(entry);
  entry.dc.send('{"type":"file-accept"}');
  refreshTransferUI();
}

export function declinePeerFileOffer(peerId: string): void {
  const entry = rtcPeers.get(peerId);
  if (entry && entry.dc && entry.dc.readyState === 'open') {
    try { entry.dc.send('{"type":"file-decline"}'); } catch (err) { console.warn('P2P file-decline err:', err); }
  }
  if (entry) entry.recv = null;
  refreshTransferUI();
}

export function abortTransfer(peerId: string, notify?: boolean): void {
  const entry = rtcPeers.get(peerId);
  if (entry) {
    if (notify && entry.dc && entry.dc.readyState === 'open') {
      try { entry.dc.send('{"type":"cancel"}'); } catch (err) { console.warn('P2P cancel err:', err); }
    }
    if (entry.offerTimer) clearTimeout(entry.offerTimer);
    dropTransferState(entry);
  }
  refreshTransferUI();
}

export function cancelAllActiveTransfers(notify = true): void {
  let cancelledAny = false;
  for (const [peerId, entry] of rtcPeers.entries()) {
    if ((entry.send && entry.send.active) || (entry.recv && entry.recv.active)) {
      abortTransfer(peerId, notify);
      cancelledAny = true;
    }
  }
  if (cancelledAny) {
    showP2PToast('unlock', 'Transfer cancelled', 1500);
  }
  refreshTransferUI();
}

export async function flushCur(cur: PeerRecvCur): Promise<boolean> {
  if (cur.bufBytes === 0) return true;
  const out = new Uint8Array(cur.bufBytes);
  let p = 0;
  for (const b of cur.buf) {
    out.set(b, p);
    p += b.byteLength;
  }
  cur.buf = [];
  cur.bufBytes = 0;
  try {
    await invokeRaw('recv_chunk', out, { 'x-id': String(cur.id) });
    return true;
  } catch (e) {
    console.warn('recv_chunk failed', e);
    return false;
  }
}

export async function handleIncomingChunk(peerId: string, entry: RtcPeerEntry, ab: ArrayBuffer): Promise<void> {
  const r = entry.recv;
  if (!r || !r.accepted || !r.cur) return;
  const cur = r.cur;
  const u8 = new Uint8Array(ab);
  cur.buf.push(u8);
  cur.bufBytes += u8.byteLength;
  r.got += u8.byteLength;
  noteProgress(r.got, r.total);
  if (cur.bufBytes >= FLUSH_BYTES) {
    const ok = await flushCur(cur);
    if (!ok && entry.recv === r) abortTransfer(peerId, true);
  }
}

export async function streamFiles(peerId: string): Promise<void> {
  const entry = rtcPeers.get(peerId);
  const s = entry && entry.send;
  if (!entry || !s || s.active || !entry.dc) return;
  const dc = entry.dc;
  s.active = true;
  beginTransferStats(entry);
  refreshTransferUI();

  let failed = false;
  try {
    for (const f of s.files) {
      const fSize = f.size || 0;
      if (s.cancelled || dc.readyState !== 'open') break;
      dc.send(JSON.stringify({ type: 'file-start', name: f.name, size: fSize }));
      let offset = 0;
      while (offset < fSize) {
        if (s.cancelled || dc.readyState !== 'open') break;
        const want = Math.min(READ_BLOCK, fSize - offset);
        let rawBuf: ArrayBuffer | Uint8Array | number[] | null = null;
        try {
          rawBuf = await invokeTauri<ArrayBuffer | Uint8Array | number[]>('read_file_chunk', { path: f.path, offset, len: want });
        } catch (err) {
          console.warn('read_file_chunk err:', err);
        }
        const ab = rawBuf instanceof ArrayBuffer ? rawBuf : rawBuf ? new Uint8Array(rawBuf).buffer : null;
        if (!ab || ab.byteLength === 0) {
          failed = true;
          break;
        }
        for (let p = 0; p < ab.byteLength; p += CHUNK) {
          if (s.cancelled || dc.readyState !== 'open') break;
          if (dc.bufferedAmount > HIGH_WATER) await waitBuffered(dc, LOW_WATER);
          dc.send(new Uint8Array(ab, p, Math.min(CHUNK, ab.byteLength - p)));
          s.sent += Math.min(CHUNK, ab.byteLength - p);
          noteProgress(Math.max(0, s.sent - dc.bufferedAmount), s.total);
          if (((p / CHUNK) & 3) === 0) {
            await new Promise<void>((r) => setTimeout(r, 0));
          }
        }
        offset += ab.byteLength;
      }
      if (failed || s.cancelled || dc.readyState !== 'open') break;
      dc.send('{"type":"file-end"}');
    }
    if (!failed && !s.cancelled && dc.readyState === 'open') {
      await waitBuffered(dc, 0);
      if (!s.cancelled && dc.readyState === 'open') {
        dc.send('{"type":"all-done"}');
        s.completed = true;
        noteProgress(s.total, s.total);
      }
    }
  } catch (e) {
    console.warn('P2P send error:', e);
    failed = true;
  }

  if (entry.send !== s) return;
  if (failed || !s.completed) {
    abortTransfer(peerId, true);
    return;
  }
  entry.send = null;
  appState.trayFiles = appState.trayFiles.filter((t) => !s.files.includes(t));
  bus.emit('tray:update');
  refreshTransferUI();
}

export async function handlePeerMessage(peerId: string, entry: RtcPeerEntry, msg: Record<string, unknown>): Promise<void> {
  switch (msg.type) {
    case 'ping':
      return;
    case 'hello':
      if (msg.name) {
        entry.name = String(msg.name);
        syncConnectedPeersList();
      }
      return;
    case 'bye':
      cleanupPeer(peerId);
      return;
    case 'file-offer': {
      const files = Array.isArray(msg.files)
        ? (msg.files as Array<{ name: string; size?: number }>).filter((f) => f && f.name).slice(0, 200)
        : [];
      if (files.length === 0) return;
      if (entry.recv || entry.send) {
        try { entry.dc.send('{"type":"file-decline"}'); } catch (err) { console.warn('P2P decline err:', err); }
        return;
      }
      entry.recv = {
        files,
        fromName: String(msg.fromName || entry.name),
        accepted: false,
        active: false,
        total: files.reduce((a, f) => a + (Number(f.size) || 0), 0),
        got: 0,
        cur: null
      };
      refreshTransferUI();
      return;
    }
    case 'file-accept':
      if (entry.send && !entry.send.active) {
        if (entry.offerTimer) clearTimeout(entry.offerTimer);
        entry.send.accepted = true;
        void streamFiles(peerId);
      }
      return;
    case 'file-decline':
      if (entry.send && !entry.send.active) {
        if (entry.offerTimer) clearTimeout(entry.offerTimer);
        entry.send = null;
        refreshTransferUI();
      }
      return;
    case 'cancel':
      abortTransfer(peerId, false);
      return;
    case 'file-start': {
      const r = entry.recv;
      if (!r || !r.accepted) return;
      const id = await tryInvoke<string>('recv_begin', { fileName: String(msg.name || 'Shared_File') });
      if (entry.recv !== r) {
        if (id) void tryInvoke('recv_abort', { id });
        return;
      }
      if (!id) {
        abortTransfer(peerId, true);
        return;
      }
      r.cur = { id, buf: [], bufBytes: 0 };
      return;
    }
    case 'file-end': {
      const r = entry.recv;
      if (!r || !r.cur) return;
      const cur = r.cur;
      const ok = await flushCur(cur);
      if (entry.recv !== r) return;
      if (!ok) {
        abortTransfer(peerId, true);
        return;
      }
      r.cur = null;
      const saved = await tryInvoke('recv_end', { id: cur.id });
      if (!saved && entry.recv === r) abortTransfer(peerId, true);
      return;
    }
    case 'all-done':
      if (entry.recv && entry.recv.accepted) {
        playP2PSound('transfer', 'transfer');
        entry.recv = null;
        refreshTransferUI();
      }
      return;
    default:
  }
}

interface StatReportLike {
  id: string;
  type: string;
  selectedCandidatePairId?: string;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
}

export async function getRouteLabel(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await pc.getStats();
    const byId: Record<string, StatReportLike> = {};
    let pairId: string | null = null;
    stats.forEach((raw) => {
      const r = raw as StatReportLike;
      byId[r.id] = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    let pair: StatReportLike | null = pairId ? byId[pairId] : null;
    if (!pair) {
      stats.forEach((raw) => {
        const r = raw as StatReportLike;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      });
    }
    if (!pair) return '';
    const types = [pair.localCandidateId ? byId[pair.localCandidateId] : undefined, pair.remoteCandidateId ? byId[pair.remoteCandidateId] : undefined]
      .map((c) => c && c.candidateType);
    if (types.includes('relay')) return 'Relay';
    if (types.every((t) => t === 'host')) return 'LAN';
    return 'Internet';
  } catch {
    return '';
  }
}

export function beginTransferStats(entry: RtcPeerEntry): void {
  if (appState.xfer) return;
  const x: XferStatsState = { bytes: 0, lastBytes: 0, lastT: Date.now(), route: '', speed: 0, pctT: 0, timer: null };
  appState.xfer = x as unknown as Record<string, unknown>;
  void getRouteLabel(entry.pc).then((l) => { x.route = l; });
  x.timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - x.lastT) / 1000 || 1;
    x.speed = Math.max(0, (x.bytes - x.lastBytes) / dt / 1048576);
    x.lastBytes = x.bytes;
    x.lastT = now;
    const pill = document.getElementById('p2p-status-pill');
    if (pill) {
      pill.textContent = `${x.route ? x.route + ' \u00B7 ' : ''}${x.speed.toFixed(1)} MB/s`;
    }
  }, 1000);
}

export function endTransferStats(): void {
  const x = appState.xfer as unknown as XferStatsState | null;
  if (x) {
    if (x.timer) clearInterval(x.timer);
    appState.xfer = null;
  }
}

let lastReportedPct = -1;
export function noteProgress(done: number, total: number): void {
  const x = appState.xfer as unknown as XferStatsState | null;
  if (!x) return;
  x.bytes = done;
  const now = Date.now();
  if (now - x.pctT < 120 && done < total) return;
  x.pctT = now;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
  if (pct !== lastReportedPct) {
    lastReportedPct = pct;
    if (typeof window.updateCompactTransferPct === 'function') {
      window.updateCompactTransferPct(pct);
    }
    bus.emit('transfer:progress', { pct });
  }
}

export function anyTransferActive(): boolean {
  for (const e of rtcPeers.values()) {
    if ((e.send && e.send.active) || (e.recv && e.recv.active)) return true;
  }
  return false;
}

export function updateOfferGlow(): void {
  let pending = false;
  for (const e of rtcPeers.values()) {
    if (e.recv && !e.recv.accepted) pending = true;
  }
  document.getElementById('c-peer-badge')?.classList.toggle('offer', pending);
  document.getElementById('tile-p2p')?.classList.toggle('offer', pending);
  document.getElementById('rail-p2p')?.classList.toggle('offer', pending);
  document.getElementById('tile-drop')?.classList.toggle('offer', pending);
  document.getElementById('deck-tile-drop')?.classList.toggle('offer', pending);
}

export function refreshStatusPill(): void {
  if (anyTransferActive()) return;
  const pill = document.getElementById('p2p-status-pill');
  if (!pill) return;
  pill.textContent = appState.peers.length > 0 ? `${appState.peers.length} Connected` : directPhaseLabel();
}

export function refreshTransferUI(): void {
  if (anyTransferActive()) {
    if (!appState.transferring) {
      let s = false;
      let r = false;
      for (const e of rtcPeers.values()) {
        if (e.send && e.send.active) s = true;
        if (e.recv && e.recv.active) r = true;
      }
      appState.xferDir = s && r ? 'both' : r ? 'recv' : 'send';
      bus.emit('transfer:start', { dir: appState.xferDir });
    }
  } else if (appState.transferring) {
    bus.emit('transfer:finish', { ok: true });
  }
  updateOfferGlow();
  renderPeersUI();
  refreshStatusPill();
}

export function renderPeersUI(): void {
  const count = appState.peers.length;
  updateDropRailBadge(count);
  renderP2PView();
  const listEl = document.getElementById('p2p-peers-list');
  const badge = document.getElementById('c-peer-badge');
  const countSpan = document.getElementById('c-peer-count');
  const tileP2P = document.getElementById('tile-p2p') || document.getElementById('tile-drop');

  const p2pSub = document.getElementById('tile-p2p-sub') || document.getElementById('tile-drop-sub');
  if (p2pSub && !dropActive) {
    p2pSub.textContent = count > 0 ? (rtcPeers.has('direct-peer') ? 'Direct 1:1' : `${count}/5 Peers`) : 'Off';
  }
  const p2pCap = document.getElementById('p2p-cap') || document.getElementById('drop-cap');
  if (p2pCap) {
    p2pCap.textContent = count > 0 ? (rtcPeers.has('direct-peer') ? '1 direct peer' : `${count} peer${count > 1 ? 's' : ''}`) : '';
  }
  if (tileP2P && !dropActive) tileP2P.classList.toggle('active', count > 0);
  updateDropTile();

  if (count > 0) {
    badge?.classList.remove('hidden');
    if (countSpan) countSpan.textContent = String(count);
  } else {
    badge?.classList.add('hidden');
  }
  updateCompactStateClasses();

  if (!listEl) return;
  listEl.innerHTML = '';
  listEl.classList.toggle('is-empty', count === 0);
  if (count === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = p2pHintText();
    listEl.appendChild(hint);
    return;
  }

  appState.peers.forEach((peer) => {
    const entry = rtcPeers.get(peer.id);
    const r = entry && entry.recv;
    const s = entry && entry.send;
    const row = document.createElement('div');
    row.className = 'list-row-item on';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'row-name';
    nameSpan.textContent = `\uD83D\uDDA5\uFE0F ${peer.name}`;
    row.appendChild(nameSpan);

    if (r && !r.accepted) {
      const label = r.files.length === 1 ? r.files[0].name : `${r.files.length} files`;
      const actBox = document.createElement('div');
      actBox.className = 'peer-file-actions';
      actBox.innerHTML = `
        <span class="peer-file-tag" title="${escHtml(label)}">${escHtml(label)}</span>
        <button class="inc-icon-btn accept" title="Accept">
          <svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <button class="inc-icon-btn decline" title="Decline">
          <svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;
      actBox.querySelector('.accept')?.addEventListener('click', (e) => {
        e.stopPropagation();
        acceptPeerFileOffer(peer.id);
      });
      actBox.querySelector('.decline')?.addEventListener('click', (e) => {
        e.stopPropagation();
        declinePeerFileOffer(peer.id);
      });
      row.appendChild(actBox);
    } else if (r || s) {
      const cancel = document.createElement('small');
      cancel.style.color = '#f87171';
      cancel.textContent = s && !s.active ? 'Waiting\u2026 Cancel' : 'Cancel';
      cancel.addEventListener('click', (e) => {
        e.stopPropagation();
        abortTransfer(peer.id, true);
      });
      row.appendChild(cancel);
    } else {
      const actionsWrap = document.createElement('div');
      actionsWrap.style.display = 'flex';
      actionsWrap.style.alignItems = 'center';
      actionsWrap.style.gap = '8px';

      const sendBtn = document.createElement('button');
      sendBtn.className = 'peer-send-btn';
      sendBtn.title = `Send tray files to ${peer.name}`;
      sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2.2" fill="none"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg><span>Send</span>`;
      sendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const selIds = appState.traySelectedIds as Set<number> | undefined;
        let toSend = appState.trayFiles.filter((f) => selIds && selIds.has(Number(f.id)));
        if (toSend.length === 0 && appState.trayFiles.length > 0) toSend = [...appState.trayFiles];
        if (toSend.length > 0) {
          if (typeof window.sendTrayFiles === 'function') window.sendTrayFiles(peer.id, toSend);
          else offerFilesToPeer(peer.id, toSend);
        } else {
          showP2PToast('info', 'Drop files into tray first');
        }
      });

      const disc = document.createElement('small');
      disc.style.color = '#f87171';
      disc.style.cursor = 'pointer';
      disc.textContent = 'Disconnect';
      disc.addEventListener('click', (e) => {
        e.stopPropagation();
        disconnectPeer(peer.id);
      });

      actionsWrap.append(sendBtn, disc);
      row.appendChild(actionsWrap);
    }

    listEl.appendChild(row);
  });
}

export function renderCenter(): void {
  const island = document.getElementById('island');
  if (!island) return;
  const toast = !!appState.toast;
  const isPrompt = !!(appState.prompting || appState.lockerPrompting);
  const busy = appState.transferring || isPrompt || toast;
  const xferLive = !!(appState.transferring && !isPrompt && !toast);
  island.classList.toggle('transferring', busy);
  island.classList.toggle('xfer-live', xferLive);
  syncPopupSize(busy);
  document.getElementById('c-clock')?.classList.toggle('hidden', busy);
  document.getElementById('c-transfer-anim')?.classList.toggle('hidden', !xferLive);
  document.getElementById('c-toast')?.classList.toggle('hidden', !toast);
  updateCompactStateClasses();
  updateTimerChip();
}

export function initP2P(): void {
  const get = (id: string): HTMLElement | null => document.getElementById(id);
  bus.on<string>('drop:mode-switched', (mode) => {
    if (mode !== 'qs') return;
    if (rtcPeers.size === 0 && !directHostSession && !directJoinSession && directUi.phase === 'standby') return;
    for (const id of [...rtcPeers.keys()]) disconnectPeer(id);
    handleDirectDisconnect();
  });
  get('btn-gen-code')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void handleDirectGenOffer();
  });
  get('btn-exit-room')?.addEventListener('click', handleDirectDisconnect);

  const slot = get('code-display-box');
  slot?.addEventListener('animationend', () => slot.classList.remove('pop'));
  slot?.addEventListener('mousedown', () => {
    invokeTauri('focus_island').catch(() => {});
  });
  slot?.addEventListener('click', async () => {
    invokeTauri('focus_island').catch(() => {});
    slot.focus({ preventScroll: true });
    if (!slot.classList.contains('has-qr')) return;
    const code = directUi.phase === 'reply-ready' ? directUi.replyCode : directUi.code;
    if (!(await copyP2PQr(code || ''))) showP2PToast('lock', 'Copy failed', 1500);
  });

  document.addEventListener('paste', async (e) => {
    if (!p2pViewActive()) return;
    const cd = e.clipboardData || (window as unknown as { clipboardData?: DataTransfer }).clipboardData;
    if (!cd) return;
    const items = Array.from(cd.items || []);
    const imgItem = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (imgItem) {
      e.preventDefault();
      void handleP2PImage(imgItem.getAsFile());
      return;
    }
    const text = (cd.getData('text/plain') || '').trim();
    if (text) {
      e.preventDefault();
      handleDirectCodeInput(text);
      return;
    }
    e.preventDefault();
    try {
      const paths = (await invokeTauri<string[]>('get_clipboard_files')) || [];
      const img = paths.find((x) => P2P_IMG_EXT.test(x));
      if (img) void handleP2PPath(img);
      else showP2PToast('lock', 'Nothing to paste', 1600);
    } catch (err) {
      console.warn('Tauri get_clipboard_files failed:', err);
    }
  });

  const body = get('p2p-body');
  const hasPayload = (e: DragEvent): boolean => {
    const t = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    return t.includes('Files') || t.includes('text/plain');
  };
  (['dragenter', 'dragover'] as const).forEach((n) => body?.addEventListener(n, (ev) => {
    if (!hasPayload(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    slot?.classList.add('drop-over');
  }));
  body?.addEventListener('dragleave', (ev) => {
    if (!body.contains(ev.relatedTarget as Node | null)) slot?.classList.remove('drop-over');
  });
  body?.addEventListener('drop', (ev) => {
    slot?.classList.remove('drop-over');
    if (!hasPayload(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const f = Array.from(ev.dataTransfer?.files || []).find((x) => /^image\//.test(x.type));
    if (f) {
      void handleP2PImage(f);
      return;
    }
    const t = ev.dataTransfer?.getData('text/plain');
    if (t) handleDirectCodeInput(t);
  });

  document.getElementById('c-transfer-cancel-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    cancelAllActiveTransfers(true);
    void invokeTauri('control_quick_share', { cmd: 'c' });
    const tSub = document.getElementById('qs-xfer-sub');
    if (tSub) tSub.textContent = 'Cancelling...';
    const btnCancel = document.getElementById('btn-qs-cancel') as HTMLButtonElement | null;
    if (btnCancel) btnCancel.disabled = true;
  });

  window.addEventListener('beforeunload', () => {
    for (const entry of rtcPeers.values()) {
      try {
        if (entry.dc && entry.dc.readyState === 'open') entry.dc.send('{"type":"bye"}');
      } catch (err) {
        console.warn('P2P beforeunload error:', err);
      }
    }
  });
}
