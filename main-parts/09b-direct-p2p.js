// ==================== 09b. P2P LINK: DIRECT 1-ON-1, NO SERVER ====================
// Nothing runs (no RTCPeerConnection, no timer, no network) until you press Generate or paste a code.
// Handshake = two QR images, one slot in the P2P menu does everything:
//   HOST   : Generate -> the QR appears in the slot (click it = the QR image is copied) -> send it to the friend
//   FRIEND : paste (Ctrl+V) / drop the QR on the same slot -> a scan animation -> the reply QR replaces it (and is copied)
//   HOST   : paste / drop the reply QR on the same slot -> connected
// (a plain text code pasted instead of an image still works)
// A code is valid for 3 minutes (CODE_TTL_MS) and is dead as soon as the link is up.
// (var + functions on purpose: other parts call these before this part has run)

var directHostSession = null;   // { pc, dc, sid, code, expiresAt }
var directJoinSession = null;   // { pc, replyCode, expiresAt }
var directTimer = null;         // 3-minute expiry of the code that is waiting
var directTick = null;          // 1 s countdown in the header
var directGenSeq = 0;           // Cancel bumps it, so a half-made code is thrown away
var p2pScanning = false;        // an image is being decoded: scan animation on the slot
var directUi = { phase: 'standby' };   // standby | generating | offer-ready | joining | reply-ready | connecting | connected

function waitCandidatesGathered(pc, maxWaitMs = 4500) {
  return new Promise((resolve) => {
    let resolved = false;
    let softTimer = null;
    const finish = () => {
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
        // Once we get a public candidate, wait 600ms more for extra candidates
        if (!softTimer) softTimer = setTimeout(finish, 600);
      }
    };
    setTimeout(finish, maxWaitMs);
  });
}

function directSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- state + sessions ----------
function setDirectState(state) {
  directUi = state || { phase: 'standby' };
  renderP2PView();
}

function clearDirectExpiry() {
  clearTimeout(directTimer);
  directTimer = null;
}

function armDirectExpiry(expiresAt) {
  clearDirectExpiry();
  directTimer = setTimeout(() => {
    directTimer = null;
    if (rtcPeers.has('direct-peer')) return;
    closeDirectSessions();
    setDirectState({ phase: 'standby' });
    showToast('lock', 'Code expired', 1800);
  }, Math.max(1000, expiresAt - Date.now()));
}

// throw the waiting code away and close its connection
function closeDirectSessions() {
  clearDirectExpiry();
  if (directHostSession) { try { directHostSession.pc.close(); } catch (_) {} directHostSession = null; }
  if (directJoinSession) { try { directJoinSession.pc.close(); } catch (_) {} directJoinSession = null; }
}

// the connection moved into rtcPeers: forget the code but keep the connection
function releaseDirectSessions() {
  clearDirectExpiry();
  directHostSession = null;
  directJoinSession = null;
}

function directPhaseLabel() {
  switch (directUi.phase) {
    case 'generating': return 'Generating…';
    case 'offer-ready': return 'Waiting for friend';
    case 'joining': return 'Joining…';
    case 'reply-ready': return 'Send reply back';
    case 'connecting': return 'Connecting…';
    default: return 'Standby';
  }
}

function p2pHintText() {
  switch (directUi.phase) {
    case 'generating': return 'Creating code…';
    case 'offer-ready': return 'Click QR to copy, then paste reply.';
    case 'joining': return 'Joining…';
    case 'reply-ready': return 'Reply copied. Send it back.';
    case 'connecting': return 'Connecting…';
    default: return 'Generate or paste a QR.';
  }
}

function updateDirectCountdown() {
  const el = document.getElementById('p2p-expiry-timer');
  if (!el || !directUi.expiresAt) return;
  const rem = Math.max(0, Math.floor((directUi.expiresAt - Date.now()) / 1000));
  el.textContent = `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
}

// ---------- QR: draw / copy / read ----------
// black on white, 4-module quiet zone, 10 px per module: still scans after a chat app recompresses it
function drawP2PQr(canvas, text) {
  const t = String(text).toUpperCase();   // the codec alphabet is A-Z 2-9 and "-": alphanumeric mode = the smallest QR
  let qr;
  try { qr = qrcode(0, 'L'); qr.addData(t, 'Alphanumeric'); qr.make(); }
  catch (_) { qr = qrcode(0, 'L'); qr.addData(t, 'Byte'); qr.make(); }
  const n = qr.getModuleCount(), quiet = 4, px = 10;
  const size = (n + quiet * 2) * px;
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.isDark(r, c)) g.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
  }
}

async function copyP2PQr() {
  const slot = document.getElementById('code-display-box');
  const cv = document.getElementById('p2p-qr-canvas');
  if (!slot || !cv || cv.classList.contains('hidden')) return false;
  try {
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch (_) { return false; }
  const toast = document.getElementById('p2p-qr-toast');
  if (toast) toast.textContent = 'Copied \u2713';
  slot.classList.add('copied');
  clearTimeout(slot._copyT);
  slot._copyT = setTimeout(() => slot.classList.remove('copied'), 1200);
  return true;
}

// jsQR (~130 KB) is loaded the first time an image is read, not at startup: zero cost while the island sits idle
var jsQrLoading = null;
function loadJsQr() {
  if (typeof jsQR === 'function') return Promise.resolve();
  if (!jsQrLoading) {
    jsQrLoading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'jsqr.js';
      el.onload = resolve;
      el.onerror = () => { jsQrLoading = null; el.remove(); reject(new Error('QR reader missing (run npm install)')); };
      document.head.appendChild(el);
    });
  }
  return jsQrLoading;
}

// image -> text of the QR in it. null = no QR found
async function decodeP2PImage(blob) {
  await loadJsQr();
  const bmp = await createImageBitmap(blob);
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d', { willReadFrequently: true });
  const base = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  for (const k of [1, 0.6, 0.4]) {            // big screenshots: a smaller copy often reads better
    const w = Math.max(60, Math.round(bmp.width * base * k)), h = Math.max(60, Math.round(bmp.height * base * k));
    cv.width = w; cv.height = h;
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    const hit = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (hit && hit.data) { try { bmp.close(); } catch (_) {} return hit.data; }
  }
  try { bmp.close(); } catch (_) {}
  return null;
}

function setP2PScanning(v) { p2pScanning = v; renderP2PView(); }

// any image (pasted / dropped / from a file) -> scan animation -> same path as a typed code
async function handleP2PImage(blob) {
  const ph = directUi.phase;
  if (!blob || p2pScanning || ph === 'generating' || ph === 'joining' || ph === 'connecting' || appState.peers.length > 0) return;
  setP2PScanning(true);
  let text = null, err = null;
  const minShow = directSleep(600);            // the animation is always seen
  try { text = await decodeP2PImage(blob); } catch (e) { err = e; }
  await minShow;
  setP2PScanning(false);
  if (err) { showToast('lock', err.message || 'Could not read the image', 2600); return; }
  if (!text) { showToast('lock', 'No QR found in that image', 2200); return; }
  handleDirectCodeInput(text);
}

var P2P_IMG_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
async function handleP2PPath(path) {
  try {
    const buf = await invokeTauri('read_image_file', { path });
    if (buf) await handleP2PImage(new Blob([buf]));
  } catch (_) { showToast('lock', 'Could not read that file', 2200); }
}

function p2pViewActive() {
  const v = document.getElementById('view-p2p');
  return !!(v && v.classList.contains('active'));
}

// Native file drag from Explorer / a chat app (the window has native drop on, so the webview never sees these).
// Called first by onNativeDrop (08): while the P2P menu is open an image goes to the QR slot, not to the tray.
function p2pNativeDrop(p) {
  if (!p2pViewActive() || !p) return false;
  const slot = document.getElementById('code-display-box');
  if (p.type === 'enter' || p.type === 'over') { slot?.classList.add('drop-over'); return true; }
  if (p.type === 'leave') { slot?.classList.remove('drop-over'); return true; }
  if (p.type === 'drop') {
    slot?.classList.remove('drop-over');
    const img = (p.paths || []).find((x) => P2P_IMG_EXT.test(x));
    if (img) handleP2PPath(img); else showToast('lock', 'Drop a QR image here', 2000);
    return true;
  }
  return false;
}

// ---------- the P2P view (everything in it is decided from directUi + connected peers) ----------
function renderP2PView() {
  const $ = (id) => document.getElementById(id);
  const gen = $('btn-gen-code');
  if (!gen) return;
  const ph = directUi.phase;
  const connected = appState.peers.length > 0;
  const hosting = !connected && ph === 'offer-ready';
  const replying = !connected && ph === 'reply-ready';

  // the one slot: idle (Generate + hint) -> QR -> (friend's QR lands on it) -> scan -> reply QR
  const slot = $('code-display-box');
  const cv = $('p2p-qr-canvas');
  const idle = $('p2p-slot-idle');
  const code = hosting ? directUi.code : (replying ? directUi.replyCode : '');
  slot.classList.toggle('hidden', connected || ph === 'connecting');
  slot.classList.toggle('has-qr', !!code);
  slot.classList.toggle('scanning', p2pScanning || ph === 'joining');
  cv.classList.toggle('hidden', !code);
  idle.classList.toggle('hidden', !!code);
  gen.classList.toggle('hidden', !(ph === 'standby' || ph === 'generating'));
  gen.classList.toggle('busy', ph === 'generating');
  gen.textContent = ph === 'generating' ? 'Generating\u2026' : 'Generate';
  if (code) {
    if (slot.dataset.shown !== code) {          // a new QR: draw it + small pop-in animation
      slot.dataset.shown = code;
      drawP2PQr(cv, code);
      slot.classList.remove('pop'); void slot.offsetWidth; slot.classList.add('pop');
    }
  } else {
    slot.dataset.shown = '';
    slot.classList.remove('copied');
  }

  $('btn-exit-room')?.classList.toggle('hidden', connected || ph === 'standby');

  const timerEl = $('p2p-expiry-timer');
  const showTimer = hosting || replying;
  timerEl.classList.toggle('hidden', !showTimer);
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

// ---------- link steps ----------
function registerDirectPeer(pc, dc, name) {
  const entry = {
    pc, dc, name,
    rx: Promise.resolve(), lastSeen: Date.now(),
    hb: null, graceTimer: null, connTimer: null, offerTimer: null,
    pendingIce: [], send: null, recv: null,
    isDirect: true
  };
  rtcPeers.set('direct-peer', entry);
  setupDataChannel('direct-peer', dc);

  // never stay half-connected forever
  entry.connTimer = setTimeout(() => {
    if (rtcPeers.get('direct-peer') === entry && dc.readyState !== 'open') {
      cleanupPeer('direct-peer');
      showToast('lock', 'Connection failed', 2200);
    }
  }, 30000);

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    } else if (st === 'disconnected') {
      // short Wi-Fi blips recover by themselves; only give up after 5s
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

  releaseDirectSessions();   // the code is used up from now on
  setDirectState({ phase: 'connecting' });
  return entry;
}

async function handleDirectGenOffer() {
  if (rtcPeers.has('direct-peer')) return;
  if (directUi.phase === 'generating' || directUi.phase === 'joining') return;
  closeDirectSessions();
  const tok = ++directGenSeq;
  setDirectState({ phase: 'generating' });
  let pc = null;
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P codec not loaded.');
    pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('inex-p2p', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await Promise.all([waitCandidatesGathered(pc, 4500), directSleep(450)]);   // 450 ms minimum: the animation is always seen
    if (tok !== directGenSeq) { try { pc.close(); } catch (_) {} return; }

    const info = C.parseSdp(pc.localDescription.sdp);
    const sid = C.randomCode();
    const code = C.encode({ type: 'offer', code: sid, minutes: C.nowMinutes(), info });
    const expiresAt = Date.now() + CODE_TTL_MS;
    directHostSession = { pc, dc, sid, code, expiresAt };
    armDirectExpiry(expiresAt);
    setDirectState({ phase: 'offer-ready', code, expiresAt });
  } catch (err) {
    try { if (pc) pc.close(); } catch (_) {}
    if (tok === directGenSeq) {
      setDirectState({ phase: 'standby' });
      showToast('lock', (err && err.message) || 'Could not create code', 2400);
    }
  }
}

async function handleDirectJoinOffer(hostCode) {
  if (rtcPeers.has('direct-peer')) return;
  closeDirectSessions();
  const tok = ++directGenSeq;
  setDirectState({ phase: 'joining' });
  let pc = null;
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P codec not loaded.');
    const dec = C.decode(hostCode);
    if (dec.type !== 'offer') throw new Error('This is not a host code.');
    if (C.nowMinutes() - dec.minutes > Math.ceil(CODE_TTL_MS / 60000)) throw new Error('Code expired. Ask for a new one.');

    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.ondatachannel = (e) => registerDirectPeer(pc, e.channel, 'Direct Host');
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: C.toSdp(dec.info, 'offer') }));
    await pc.setLocalDescription(await pc.createAnswer());
    await Promise.all([waitCandidatesGathered(pc, 4500), directSleep(450)]);
    if (tok !== directGenSeq) { try { pc.close(); } catch (_) {} return; }

    const replyCode = C.encode({ type: 'answer', code: dec.code, info: C.parseSdp(pc.localDescription.sdp) });
    const expiresAt = Date.now() + CODE_TTL_MS;
    directJoinSession = { pc, replyCode, expiresAt };
    armDirectExpiry(expiresAt);
    setDirectState({ phase: 'reply-ready', replyCode, expiresAt });
    await directSleep(60);                       // let the reply QR get drawn first
    if (await copyP2PQr()) showToast('done', 'Reply QR copied', 1600);
  } catch (err) {
    try { if (pc) pc.close(); } catch (_) {}
    if (tok === directGenSeq) {
      setDirectState({ phase: 'standby' });
      showToast('lock', (err && err.message) || 'Could not join', 2600);
    }
  }
}

async function handleDirectAcceptReply(replyCode) {
  const s = directHostSession;
  if (!s) { showToast('lock', 'Generate a code first', 2200); return; }
  let dec;
  try {
    const C = window.inexIslandCodec;
    dec = C.decode(replyCode);
    if (dec.type !== 'answer') throw new Error('Paste the reply code from your friend.');
    if (dec.code !== s.sid) throw new Error('This reply is for a different code.');
  } catch (err) {
    showToast('lock', (err && err.message) || 'Invalid reply code', 2600);
    return;
  }
  directHostSession = null;   // one reply only: this code is used up now
  clearDirectExpiry();
  try {
    const C = window.inexIslandCodec;
    await s.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: C.toSdp(dec.info, 'answer') }));
    registerDirectPeer(s.pc, s.dc, 'Direct Partner');
  } catch (err) {
    try { s.pc.close(); } catch (_) {}
    setDirectState({ phase: 'standby' });
    showToast('lock', 'Could not connect. Try a new code', 2600);
  }
}

// one box for everything: a host code joins, a reply code connects
function handleDirectCodeInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  const ph = directUi.phase;
  if (ph === 'generating' || ph === 'joining' || ph === 'connecting') return false;
  const C = window.inexIslandCodec;
  if (!C) { showToast('lock', 'P2P codec not loaded', 2200); return false; }
  let dec;
  try { dec = C.decode(text); } catch (err) { showToast('lock', err.message || 'Invalid code', 2400); return false; }
  if (dec.type === 'offer') {
    if (ph === 'offer-ready') { showToast('lock', 'You made a code. Paste the reply code, or Cancel first', 3000); return false; }
    handleDirectJoinOffer(text);
  } else {
    handleDirectAcceptReply(text);
  }
  return true;
}

// Cancel (while a code is waiting)
function handleDirectDisconnect() {
  directGenSeq++;
  closeDirectSessions();
  if (rtcPeers.has('direct-peer')) { disconnectPeer('direct-peer'); return; }   // cleanupPeer resets the state
  setDirectState({ phase: 'standby' });
}

// ---------- wiring ----------
(function wireP2PView() {
  const $ = (id) => document.getElementById(id);
  $('btn-gen-code')?.addEventListener('click', (e) => { e.stopPropagation(); handleDirectGenOffer(); });
  $('btn-exit-room')?.addEventListener('click', handleDirectDisconnect);

  const slot = $('code-display-box');
  slot?.addEventListener('animationend', () => slot.classList.remove('pop'));
  // click the QR = copy it as an image. Click an empty slot = focus it, so Ctrl+V lands here
  slot?.addEventListener('click', async () => {
    slot.focus({ preventScroll: true });
    if (!slot.classList.contains('has-qr')) return;
    if (!(await copyP2PQr())) showToast('lock', 'Copy failed', 1500);
  });

  // Ctrl+V anywhere in the P2P menu: an image (screenshot / "Copy image" / copied file) or a text code
  document.addEventListener('paste', async (e) => {
    if (!p2pViewActive()) return;
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const items = Array.from(cd.items || []);
    const imgItem = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (imgItem) { e.preventDefault(); handleP2PImage(imgItem.getAsFile()); return; }
    const text = (cd.getData('text/plain') || '').trim();
    if (text) { e.preventDefault(); handleDirectCodeInput(text); return; }
    // a copied image FILE (Explorer / chat app): the page sees nothing, so ask the native clipboard
    e.preventDefault();
    try {
      const paths = (await invokeTauri('get_clipboard_files')) || [];
      const img = paths.find((x) => P2P_IMG_EXT.test(x));
      if (img) handleP2PPath(img); else showToast('lock', 'Nothing to paste', 1600);
    } catch (_) {}
  });

  // drag an image (or a text code) onto the menu when the webview itself receives the drop
  const body = $('p2p-body');
  const hasPayload = (e) => {
    const t = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    return t.includes('Files') || t.includes('text/plain');
  };
  ['dragenter', 'dragover'].forEach((n) => body?.addEventListener(n, (ev) => {
    if (!hasPayload(ev)) return;
    ev.preventDefault(); ev.stopPropagation();
    slot?.classList.add('drop-over');
  }));
  body?.addEventListener('dragleave', (ev) => { if (!body.contains(ev.relatedTarget)) slot?.classList.remove('drop-over'); });
  body?.addEventListener('drop', (ev) => {
    slot?.classList.remove('drop-over');
    if (!hasPayload(ev)) return;
    ev.preventDefault(); ev.stopPropagation();
    const f = Array.from(ev.dataTransfer.files || []).find((x) => /^image\//.test(x.type));
    if (f) { handleP2PImage(f); return; }
    const t = ev.dataTransfer.getData('text/plain');
    if (t) handleDirectCodeInput(t);
  });
})();
