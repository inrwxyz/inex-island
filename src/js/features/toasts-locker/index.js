// Toasts, Locker Pro Biometric Unlock, Windows Credential Prompts & Nexus Assistant Bridge
import { appState } from '../../core/state.js';
import { loadSettings } from '../../core/settings.js';
import { bus } from '../../core/bus.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { goCompact, reportIslandSize, cancelCloseEase, ISLAND_WIN_W } from '../../core/views.js';
import { renderCenter, rtcPeers, endTransferStats } from '../file-transfer/index.js';
import { updateClocks } from '../clock/index.js';
import { refreshMedia } from '../media/index.js';
import { triggerTimerAlarm, startTimerWithSecs } from '../timer/index.js';
import { showDeviceHud, hudRestoreSize, showBtConnectHud, BOLT_SVG, LOW_BATT_SVG } from '../bluetooth/index.js';

const SVG_A = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">';
export const TOAST_ICONS = {
  unlock: SVG_A + '<rect x="4" y="11" width="16" height="10" rx="2"/><path class="lock-shackle" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  lock: SVG_A + '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  face: SVG_A + '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><path d="M10 15c.8.7 1.8 1 2 1s1.2-.3 2-1"/></svg>',
  fingerprint: SVG_A + '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .13-5.35 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/><path d="M17 19a10 10 0 0 1-5 2"/><path d="M18.7 18.2a12 12 0 0 0 1.3-4.2"/></svg>',
  phone: SVG_A + '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
  unphone: SVG_A + '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/><line x1="3" y1="3" x2="21" y2="21"/></svg>',
  bolt: SVG_A + '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  battery: SVG_A + '<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/></svg>',
  low: SVG_A + '<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="10" x2="6" y2="14"/></svg>',
  done: SVG_A + '<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9"/></svg>',
  warn: SVG_A + '<circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  alert: SVG_A + '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  cloud: SVG_A + '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: SVG_A + '<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  error: SVG_A + '<circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  mic: SVG_A + '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
};

export function playStatusSound(category, kind) {
  const SET = loadSettings();
  const s = SET.sounds;
  if (s && s.enabled === false) return;
  if (s && category && s[category] === false) return;
  invokeTauri('play_status_sound', { kind: kind || category }).catch((err) => console.warn('Tauri invoke error:', err));
}

export function showToast(kind, text, ms) {
  const isXfer = appState.transferring;
  const duration = isXfer ? Math.min(ms || 1400, 1400) : (ms || 2200);
  const box = document.getElementById('c-toast');
  if (!box) return false;
  box.className = 'c-transfer-inline c-toast t-' + kind;
  const ico = document.getElementById('c-toast-ico');
  if (ico) ico.innerHTML = TOAST_ICONS[kind] || '';
  const txt = document.getElementById('c-toast-text');
  if (txt) txt.textContent = text;
  appState.toast = true;
  renderCenter();
  clearTimeout(appState.toastTimer);
  appState.toastTimer = setTimeout(() => {
    appState.toast = false;
    renderCenter();
    updateClocks();
    refreshMedia();
    bus.emit('smart:sync');
  }, duration);
  return true;
}

let bioTimer = null;
let bioAnimPhaseTimer = null;
let bioStartTimer = null;
let bioEndTimer = null;

export const BIO_SVGS = {
  scan: `<svg class="bio-scan-svg" viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path class="bio-br" d="M5 15v-4a6 6 0 0 1 6-6h4"/>
    <path class="bio-br" d="M39 15v-4a6 6 0 0 0-6-6h-4"/>
    <path class="bio-br" d="M5 29v4a6 6 0 0 0 6 6h4"/>
    <path class="bio-br" d="M39 29v4a6 6 0 0 1-6 6h-4"/>
    <rect class="bio-core" x="14" y="14" width="16" height="16" rx="5"/>
    <rect class="bio-scan" x="9" y="9" width="26" height="2.2" rx="1.1" stroke="none"/>
  </svg>`,
  face: `<svg class="bio-face-svg" viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path class="bio-br" d="M5 15v-4a6 6 0 0 1 6-6h4"/>
    <path class="bio-br" d="M39 15v-4a6 6 0 0 0-6-6h-4"/>
    <path class="bio-br" d="M5 29v4a6 6 0 0 0 6 6h4"/>
    <path class="bio-br" d="M39 29v4a6 6 0 0 1-6 6h-4"/>
    <path class="bio-ft" d="M16 17v3.5"/>
    <path class="bio-ft" d="M28 17v3.5"/>
    <path class="bio-ft" d="M22 17v6.5a1.5 1.5 0 0 1-1.5 1.5H19"/>
    <path class="bio-ft" d="M16 29.5c3.5 3 8.5 3 12 0"/>
    <rect class="bio-scan" x="9" y="9" width="26" height="2.2" rx="1.1" stroke="none"/>
  </svg>`,
  fingerprint: `<svg class="bio-finger-svg" viewBox="0 0 38 38" width="42" height="42" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path class="fp-ridge" d="M19 9a10 10 0 0 0-7 2.9"/>
    <path class="fp-ridge" d="M19 6a13 13 0 0 0-11 5.9"/>
    <path class="fp-ridge" d="M19 13a6 6 0 0 0-5.8 4.5"/>
    <path class="fp-ridge" d="M19 16a3 3 0 0 0-3 3c0 3.5-.8 5-1.5 6.5"/>
    <path class="fp-ridge" d="M22 17.5a3 3 0 0 1 0 3c-.5 2-.5 4.5-.5 6.5"/>
    <path class="fp-ridge" d="M25 13a7 7 0 0 1 0 7.5c-1 3-1 6-1 8.5"/>
    <path class="fp-ridge" d="M19 3a16 16 0 0 1 12 5.5c3 3.5 3 8 3 12"/>
    <path class="fp-ridge" d="M11 23.5c.5 3.5 2 6.5 4 8.5"/>
    <path class="fp-ridge" d="M6 20c0 5 2 9 5 12"/>
  </svg>`,
  folderAdd: `<svg class="bio-obj-svg" viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path class="bio-br" d="M5 15v-4a6 6 0 0 1 6-6h4"/>
    <path class="bio-br" d="M39 15v-4a6 6 0 0 0-6-6h-4"/>
    <path class="bio-br" d="M5 29v4a6 6 0 0 0 6 6h4"/>
    <path class="bio-br" d="M39 29v4a6 6 0 0 1-6 6h-4"/>
    <path class="bio-draw" pathLength="1" d="M12 17.5a2 2 0 0 1 2-2h4l2 2.5h10a2 2 0 0 1 2 2V28a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2z"/>
    <path class="bio-late" d="M22 21v6M19 24h6"/>
  </svg>`,
  folderDel: `<svg class="bio-obj-svg" viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path class="bio-br" d="M5 15v-4a6 6 0 0 1 6-6h4"/>
    <path class="bio-br" d="M39 15v-4a6 6 0 0 0-6-6h-4"/>
    <path class="bio-br" d="M5 29v4a6 6 0 0 0 6 6h4"/>
    <path class="bio-br" d="M39 29v4a6 6 0 0 1-6 6h-4"/>
    <path class="bio-draw" pathLength="1" d="M12 17.5a2 2 0 0 1 2-2h4l2 2.5h10a2 2 0 0 1 2 2V28a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2z"/>
    <path class="bio-late" d="M19 24h6"/>
  </svg>`,
  phone: `<svg class="bio-obj-svg" viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path class="bio-br" d="M5 15v-4a6 6 0 0 1 6-6h4"/>
    <path class="bio-br" d="M39 15v-4a6 6 0 0 0-6-6h-4"/>
    <path class="bio-br" d="M5 29v4a6 6 0 0 0 6 6h4"/>
    <path class="bio-br" d="M39 29v4a6 6 0 0 1-6 6h-4"/>
    <rect class="bio-draw" pathLength="1" x="16.5" y="12" width="11" height="20" rx="3"/>
    <path class="bio-late" d="M21 28h2"/>
    <path class="bio-wave" d="M10.5 19a6 6 0 0 0 0 6M33.5 19a6 6 0 0 1 0 6"/>
    <path class="bio-wave b" stroke-width="2" d="M7.5 17a9 9 0 0 0 0 10M36.5 17a9 9 0 0 1 0 10"/>
  </svg>`,
  phoneOff: `<svg class="bio-obj-svg" viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path class="bio-br" d="M5 15v-4a6 6 0 0 1 6-6h4"/>
    <path class="bio-br" d="M39 15v-4a6 6 0 0 0-6-6h-4"/>
    <path class="bio-br" d="M5 29v4a6 6 0 0 0 6 6h4"/>
    <path class="bio-br" d="M39 29v4a6 6 0 0 1-6 6h-4"/>
    <rect x="16.5" y="12" width="11" height="20" rx="3"/>
    <path d="M21 28h2"/>
    <path class="bio-slash" pathLength="1" d="M12 12l20 20"/>
  </svg>`,
  check: `<svg class="bio-check-svg" viewBox="0 0 44 44" width="44" height="44" fill="none">
    <circle class="fillc" cx="22" cy="22" r="17" fill="rgba(48,209,88,0.16)"/>
    <circle class="ring" cx="22" cy="22" r="17" stroke="#30d158" stroke-width="2.4" stroke-linecap="round" transform="rotate(-90 22 22)"/>
    <path class="tick" d="M14 22.5l6 6 11-12.5" stroke="#30d158" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
};

export function triggerBiometricMorph(type, label) {
  if (appState.currentView !== 'view-compact' || appState.alarmActive) return;
  const kind = (type === 'fingerprint') ? 'fingerprint' : 'scan';
  const box = document.getElementById('c-biometric-box');
  const glyph = document.getElementById('bio-glyph-wrap');
  const txt = document.getElementById('bio-label');
  const island = document.getElementById('island');
  if (!box || !glyph || !txt || !island) return;
  nexusAbort();

  clearTimeout(bioTimer);
  clearTimeout(bioAnimPhaseTimer);
  clearTimeout(bioStartTimer);
  clearTimeout(bioEndTimer);

  island.classList.remove('bt-hud-active', 'hud-out', 'hud-back');
  island.classList.remove('welcome-hud');
  island.classList.add('bio-hud');
  document.getElementById('c-bt-hud')?.classList.add('hidden');

  txt.textContent = label ? String(label) : 'Unlocked';
  glyph.innerHTML = BIO_SVGS[kind];
  box.classList.remove('hidden');

  cancelCloseEase();
  reportIslandSize({ width: ISLAND_WIN_W, height: 112 });
  island.classList.add('hud-pre');
  bioStartTimer = setTimeout(() => {
    island.classList.remove('hud-pre');
    island.classList.add('biometric-active');
  }, 130);

  bioAnimPhaseTimer = setTimeout(() => {
    const cur = glyph.firstElementChild;
    if (cur) cur.classList.add('bio-leave');
    setTimeout(() => { glyph.innerHTML = BIO_SVGS.check; }, 150);
  }, 1150);

  bioTimer = setTimeout(() => {
    island.classList.add('hud-out');
    bioEndTimer = setTimeout(() => {
      island.classList.remove('biometric-active', 'hud-out');
      island.classList.add('hud-back');
      setTimeout(() => {
        box.classList.add('hidden');
        glyph.innerHTML = '';
        island.classList.remove('hud-back', 'bio-hud');
        hudRestoreSize();
        renderCenter();
        updateClocks();
        refreshMedia();
      }, 560);
    }, 170);
  }, 2350);
}

let testTransferTimer = null;
let lastLockerTs = 0;
let lastLockToast = { target: '', at: 0 };
const LOCKER_LEASE_MS = 8000;

const XFER_UP = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';
const XFER_DOWN = '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="5 12 12 19 19 12"/>';

export function xferDirection() {
  let send = false;
  let recv = false;
  for (const e of rtcPeers.values()) {
    if (e.send && e.send.active) send = true;
    if (e.recv && e.recv.active) recv = true;
  }
  return send && recv ? 'both' : recv ? 'recv' : 'send';
}

export function setXferDirectionUI() {
  const box = document.getElementById('c-transfer-anim');
  if (!box) return;
  const dir = appState.xferDir || xferDirection();
  if (box.dataset.dir === dir) return;
  box.dataset.dir = dir;
  appState.xferDir = dir;
  box.classList.toggle('recv', dir === 'recv');
  const label = document.getElementById('c-xfer-label');
  if (label) label.textContent = dir === 'recv' ? 'Receiving' : dir === 'both' ? 'Transferring' : 'Sending';
  const glyph = document.getElementById('c-xfer-glyph');
  if (glyph) glyph.innerHTML = dir === 'recv' ? XFER_DOWN : XFER_UP;
}

export function setXferRing(pct) {
  const ring = document.getElementById('c-xfer-ring-fg');
  if (ring) ring.style.strokeDashoffset = String(66 * (1 - Math.max(0, Math.min(100, pct)) / 100));
}

let lastReportedPct = -1;

export function startCompactTransferUI() {
  appState.transferring = true;
  lastReportedPct = -1;
  const box = document.getElementById('c-transfer-anim');
  if (box) {
    box.dataset.dir = '';
    box.classList.add('indeterminate');
  }
  setXferDirectionUI();
  setXferRing(0);
  const pctEl = document.getElementById('c-transfer-pct');
  if (pctEl) pctEl.textContent = '0%';
  renderCenter();
}

export function updateCompactTransferPct(pct, speed, name) {
  if (typeof pct === 'number' && Number.isFinite(pct)) {
    lastReportedPct = Math.max(lastReportedPct, pct);
  }
  const pctEl = document.getElementById('c-transfer-pct');
  if (pctEl) pctEl.textContent = speed ? `${pct}% \u2022 ${speed}` : `${pct}%`;
  const box = document.getElementById('c-transfer-anim');
  if (box && pct > 0) box.classList.remove('indeterminate');
  setXferDirectionUI();
  setXferRing(pct);
  if (name) {
    const lb = document.getElementById('c-xfer-label');
    if (lb) {
      lb.textContent = name;
      lb.title = name;
    }
  }
}

export function finishCompactTransferUI() {
  const completed = lastReportedPct >= 100;
  const dir = appState.xferDir;
  appState.transferring = false;
  appState.lastXferEnd = Date.now();
  lastReportedPct = -1;
  endTransferStats();
  renderCenter();
  updateClocks();
  refreshMedia();
  if (completed) showToast('done', dir === 'recv' ? 'Received' : 'Sent', 1500);
}

const NX_TEXT = { wake: 'Listening...', thinking: 'Thinking...', done: 'Done', fail: 'Failed' };
const NX_FAIL_STATUS = ['fail', 'failed', 'failure', 'error'];
const NX_GLYPH = {
  lockwait: BIO_SVGS.scan,
  finger: BIO_SVGS.fingerprint,
  folderAdd: BIO_SVGS.folderAdd,
  folderDel: BIO_SVGS.folderDel,
  phone: BIO_SVGS.phone,
  phoneOff: BIO_SVGS.phoneOff,
  wake: '<div class="nx-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>',
  thinking: '<div class="nx-aurora" aria-hidden="true"><b></b><b></b><b></b></div>',
  fail: `<svg class="bio-check-svg nx-fail-svg" viewBox="0 0 44 44" width="44" height="44" fill="none">
    <circle class="fillc" cx="22" cy="22" r="17" fill="rgba(255,69,58,0.16)"/>
    <circle class="ring" cx="22" cy="22" r="17" stroke="#ff453a" stroke-width="2.4" stroke-linecap="round" transform="rotate(-90 22 22)"/>
    <path class="tick" d="M16 16l12 12" stroke="#ff453a" stroke-width="3" stroke-linecap="round"/>
    <path class="tick" d="M28 16L16 28" stroke="#ff453a" stroke-width="3" stroke-linecap="round"/>
  </svg>`
};

const NX_HOLD_DONE_MS = 1400;
const NX_LEASE_MS = 12000;

let nxActive = false;
let nxMode = '';
let nxExiting = false;
let nxEnterT = null;
let nxSwapT = null;
let nxHoldT = null;
let nxLeaseT = null;
let nxEndT = null;
let nxBackT = null;
let nxGlowT = null;

export function nexusClearTimers() {
  clearTimeout(nxEnterT);
  clearTimeout(nxSwapT);
  clearTimeout(nxHoldT);
  clearTimeout(nxLeaseT);
  clearTimeout(nxEndT);
  clearTimeout(nxBackT);
  clearTimeout(nxGlowT);
}

export function nexusCleanup() {
  const island = document.getElementById('island');
  const box = document.getElementById('c-biometric-box');
  const glyph = document.getElementById('bio-glyph-wrap');
  if (box) box.classList.add('hidden');
  if (glyph) glyph.innerHTML = '';
  if (island) island.classList.remove('hud-back', 'bio-hud', 'island-locker-glow');
  nxActive = false;
  nxExiting = false;
  nxMode = '';
  hudRestoreSize();
  renderCenter();
  updateClocks();
  refreshMedia();
}

export function nexusAbort() {
  if (!nxActive && !nxExiting) return;
  nexusClearTimers();
  const island = document.getElementById('island');
  if (island) island.classList.remove('biometric-active', 'hud-pre', 'hud-out', 'hud-back', 'bio-hud', 'island-locker-glow');
  const box = document.getElementById('c-biometric-box');
  if (box) box.classList.add('hidden');
  const glyph = document.getElementById('bio-glyph-wrap');
  if (glyph) glyph.innerHTML = '';
  nxActive = false;
  nxExiting = false;
  nxMode = '';
  hudRestoreSize();
  renderCenter();
  updateClocks();
  refreshMedia();
}

export function nexusEnter() {
  const island = document.getElementById('island');
  const box = document.getElementById('c-biometric-box');
  const glyph = document.getElementById('bio-glyph-wrap');
  if (!box || !glyph || !island) return false;
  if (appState.currentView !== 'view-compact' || appState.alarmActive) return false;

  if (nxActive) return true;
  if (nxExiting) {
    nexusClearTimers();
    nxExiting = false;
    nxActive = true;
    island.classList.remove('hud-out', 'hud-back');
    island.classList.add('bio-hud', 'biometric-active');
    box.classList.remove('hidden');
    return true;
  }
  if (island.classList.contains('biometric-active') || island.classList.contains('bio-hud')) return false;

  nexusClearTimers();
  nxActive = true;
  nxMode = '';
  glyph.innerHTML = '';
  island.classList.remove('bt-hud-active', 'hud-out', 'hud-back');
  document.getElementById('c-bt-hud')?.classList.add('hidden');
  island.classList.add('bio-hud');
  box.classList.remove('hidden');

  cancelCloseEase();
  reportIslandSize({ width: ISLAND_WIN_W, height: 112 });
  island.classList.add('hud-pre');
  nxEnterT = setTimeout(() => {
    island.classList.remove('hud-pre');
    island.classList.add('biometric-active');
  }, 130);
  return true;
}

export function nexusSetMode(mode, text, leaseMs, glow) {
  const glyph = document.getElementById('bio-glyph-wrap');
  const txt = document.getElementById('bio-label');
  const island = document.getElementById('island');
  if (!glyph || !txt) return;
  txt.textContent = ((text && String(text).trim()) || NX_TEXT[mode] || '').replace(/[.\u2026]+$/, '');
  clearTimeout(nxHoldT);
  if (mode !== nxMode) {
    nxMode = mode;
    clearTimeout(nxSwapT);
    const html = mode === 'done' ? BIO_SVGS.check : (NX_GLYPH[mode] || '');
    const cur = glyph.firstElementChild;
    if (cur) {
      cur.classList.add('bio-leave');
      nxSwapT = setTimeout(() => { glyph.innerHTML = html; }, 150);
    } else {
      glyph.innerHTML = html;
    }
    if (mode === 'done' && glow !== false && island) {
      island.classList.add('island-locker-glow');
      clearTimeout(nxGlowT);
      nxGlowT = setTimeout(() => island.classList.remove('island-locker-glow'), 600);
    }
  }
  if (mode === 'done' || mode === 'fail') nxHoldT = setTimeout(nexusExit, NX_HOLD_DONE_MS);
  nexusArmLease(leaseMs);
}

export function nexusArmLease(ms) {
  clearTimeout(nxLeaseT);
  nxLeaseT = setTimeout(nexusExit, ms || NX_LEASE_MS);
}

export function nexusIsMode(mode) {
  return nxActive && nxMode === mode;
}

export function nexusExit() {
  if (!nxActive) return;
  const island = document.getElementById('island');
  nxActive = false;
  nxExiting = true;
  clearTimeout(nxHoldT);
  clearTimeout(nxLeaseT);
  clearTimeout(nxEnterT);
  clearTimeout(nxSwapT);
  clearTimeout(nxGlowT);
  if (island) {
    island.classList.remove('hud-pre', 'island-locker-glow');
    island.classList.add('hud-out');
  }
  nxEndT = setTimeout(() => {
    if (island) {
      island.classList.remove('biometric-active', 'hud-out');
      island.classList.add('hud-back');
    }
    nxBackT = setTimeout(nexusCleanup, 560);
  }, 170);
}

// Mic loudness (0..1) from Nexus drives the listening bars; without it they keep their idle motion.
export function nexusSetLevel(payload) {
  const raw = payload ? (payload.level ?? payload.amp ?? payload.volume ?? payload.rms) : undefined;
  const wave = document.querySelector('#bio-glyph-wrap .nx-wave');
  if (!wave || raw === undefined || raw === null) return;
  const lv = Math.max(0, Math.min(1, Number(raw) || 0));
  wave.style.setProperty('--lv', lv.toFixed(3));
}

export function triggerNexusVoiceAnimation(status, text, payload) {
  let st = String(status || '').toLowerCase();
  if (NX_FAIL_STATUS.includes(st)) st = 'fail';
  if (st === 'level') {
    if (nxActive && nxMode === 'wake') nexusSetLevel(payload);
  } else if (st === 'wake' || st === 'thinking' || st === 'done' || st === 'fail') {
    if (!nexusEnter()) return;
    nexusSetMode(st, text);
    if (st === 'wake') nexusSetLevel(payload);
  } else if (st === 'cancel') {
    nexusExit();
  }
}

let lockPrev = false;
let lockUnlockT = null;
let lastNexusTs = 0;
let lockerWaitTarget = '';
let nativeWaiting = false;
let lockerStepT = null;

// Locker events use the same island morph as the unlock animation (nexusEnter / nexusSetMode / nexusExit).
// "waiting" stays up as long as Locker Pro keeps the prompt alive (same 8 s lease as before), the result swaps the glyph.
function lockerWaitStart(label, native) {
  clearTimeout(lockerStepT);
  if (!nexusEnter()) return false;
  nativeWaiting = !!native;
  lockerWaitTarget = label;
  nexusSetMode('lockwait', label, LOCKER_LEASE_MS, false);
  return true;
}

function lockerWaitEnd() {
  clearTimeout(lockerStepT);
  nativeWaiting = false;
}

// completion-only events (pair, remove, lock): the glyph draws itself, then the check / cross
function lockerFlash(glyphMode, label, endMode) {
  clearTimeout(lockerStepT);
  lockerWaitEnd();
  if (!nexusEnter()) return;
  nexusSetMode(glyphMode, label, 4000, false);
  lockerStepT = setTimeout(() => nexusSetMode(endMode, label, 4000, false), 900);
}

export function initToastsLocker() {
  window.showToast = showToast;
  window.triggerBiometricMorph = triggerBiometricMorph;
  window.startCompactTransferUI = startCompactTransferUI;
  window.updateCompactTransferPct = updateCompactTransferPct;
  window.finishCompactTransferUI = finishCompactTransferUI;
  window.triggerNexusVoiceAnimation = triggerNexusVoiceAnimation;
  window.playStatusSound = playStatusSound;

  bus.on('toast:show', ({ icon, title, ms }) => showToast(icon, title, ms));
  bus.on('sound:play', ({ category, kind }) => playStatusSound(category, kind));
  bus.on('transfer:start', () => startCompactTransferUI());
  bus.on('transfer:progress', ({ pct, speed, name }) => updateCompactTransferPct(pct, speed, name));
  bus.on('transfer:finish', () => finishCompactTransferUI());

  listenTauri('locker-unlock', (event) => {
    let payload = (event && event.payload !== undefined) ? event.payload : event;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (err) { console.warn('JSON parse error in locker-unlock:', err); }
    }
    if (!payload || typeof payload !== 'object') payload = {};

    const evTs = Number(payload.ts) || 0;
    if (evTs) {
      if (evTs < lastLockerTs && lastLockerTs - evTs < 60000) return;
      lastLockerTs = evTs;
    }

    const evName = payload.event || (payload.type ? 'locker_unlock' : '');
    const tgt = payload.target ? String(payload.target) : '';

    if (evName === 'locker_prompt') {
      if (payload.hb) {
        if (nexusIsMode('lockwait')) nexusArmLease(LOCKER_LEASE_MS);
        return;
      }
      lockerWaitStart(tgt || 'Locked', false);
    } else if (evName === 'locker_wrong') {
      clearTimeout(lockerStepT);
      if (!nexusEnter()) return;
      nexusSetMode('fail', 'Incorrect', LOCKER_LEASE_MS, false);
      lockerStepT = setTimeout(() => nexusSetMode('lockwait', tgt || lockerWaitTarget || 'Locked', LOCKER_LEASE_MS, false), 1250);
    } else if (evName === 'locker_cancel') {
      lockerWaitEnd();
      if (nexusIsMode('lockwait') || nexusIsMode('fail')) nexusExit();
    } else if (evName === 'locker_unlock') {
      lockerWaitEnd();
      const kind = payload.type === 'fingerprint' ? 'fingerprint' : payload.type === 'charging' ? 'charging' : payload.type === 'low_battery' ? 'low_battery' : payload.type === 'alarm' ? 'alarm' : payload.type === 'transfer' ? 'transfer' : payload.type === 'bluetooth' ? 'bluetooth' : 'scan';
      const targetName = tgt || 'Unlocked';
      const waiting = nexusIsMode('lockwait') || nexusIsMode('fail');

      if (kind === 'alarm') {
        nexusAbort();
        triggerTimerAlarm();
      } else if (kind === 'scan' || kind === 'fingerprint') {
        playStatusSound('lock', 'lock');
        if (waiting) {
          // the waiting morph is still up: swap its glyph instead of restarting the animation
          if (kind === 'fingerprint') {
            nexusSetMode('finger', targetName, 4000, false);
            lockerStepT = setTimeout(() => nexusSetMode('done', targetName, 4000, false), 1150);
          } else {
            nexusSetMode('done', targetName, 4000, false);
          }
        } else {
          triggerBiometricMorph(kind, targetName);
        }
      } else if (kind === 'charging') {
        showDeviceHud({ iconHTML: BOLT_SVG, battery: true, plain: true, accent: 'green', name: 'Charging', tag: `${payload.target || '85%'} \u2022 MagSafe Power`, pct: parseInt(payload.target, 10) || 85, ms: 3200 });
      } else if (kind === 'low_battery') {
        showDeviceHud({ iconHTML: LOW_BATT_SVG, battery: true, plain: true, accent: 'amber', name: 'Low Battery', tag: `${payload.target || '18%'} \u2022 Connect Power`, pct: parseInt(payload.target, 10) || 18, ms: 3800 });
      } else if (kind === 'bluetooth') {
        showBtConnectHud(payload.target || 'AirPods Pro', payload.kind || 'headphones', parseInt(payload.pct, 10) || 90);
      } else if (kind === 'transfer') {
        clearInterval(testTransferTimer);
        appState.xferDir = payload.dir === 'recv' ? 'recv' : 'send';
        startCompactTransferUI();
        let p = 0;
        testTransferTimer = setInterval(() => {
          p += 10;
          if (p >= 100) {
            p = 100;
            clearInterval(testTransferTimer);
            updateCompactTransferPct(100);
            lastReportedPct = 100;
            setTimeout(() => {
              finishCompactTransferUI();
            }, 600);
          } else {
            updateCompactTransferPct(p);
          }
        }, 200);
      }
    } else if (evName === 'locker_pair') {
      lockerFlash('phone', 'Paired', 'done');
    } else if (evName === 'locker_unpair') {
      lockerFlash('phoneOff', 'Unpaired', 'fail');
    } else if (evName === 'locker_remove') {
      lockerFlash('folderDel', 'Removed', 'done');
    } else if (evName === 'locker_lock') {
      const nowMs = Date.now();
      if (lastLockToast.target === tgt && nowMs - lastLockToast.at < 3000) return;
      lastLockToast = { target: tgt, at: nowMs };
      lockerFlash('folderAdd', 'Locked', 'done');
    }
  });

  listenTauri('native-prompt-changed', (event) => {
    const on = !!(event && event.payload && event.payload.active);
    if (on && !nativeWaiting) {
      lockerWaitStart('Locked', true);
    } else if (!on && nativeWaiting) {
      nativeWaiting = false;
      if (!nexusIsMode('lockwait')) return;
      const SET = loadSettings();
      if (SET.general && SET.general.lockToast) nexusSetMode('done', 'Done', 4000, false);
      else nexusExit();
    }
  });

  listenTauri('session-lock-changed', (event) => {
    const SET = loadSettings();
    if (SET.general && !SET.general.lockToast) {
      lockPrev = false;
      return;
    }
    const locked = event && event.payload && event.payload.locked;
    if (typeof locked !== 'boolean') return;
    if (locked === true) {
      lockPrev = true;
      goCompact();
      return;
    }
    if (locked === false) {
      if (lockPrev === true && SET.general && SET.general.lockToast) {
        clearTimeout(lockUnlockT);
        lockUnlockT = setTimeout(() => triggerBiometricMorph('scan', 'Unlocked'), 450);
      }
      lockPrev = false;
    }
  });

  ['m-play'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', async () => {
      await invokeTauri('media_play_pause');
      if (typeof window.pollSystemAndMedia === 'function') setTimeout(window.pollSystemAndMedia, 250);
    });
  });
  ['m-next'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', async () => {
      await invokeTauri('media_next');
      if (typeof window.pollSystemAndMedia === 'function') setTimeout(window.pollSystemAndMedia, 250);
    });
  });
  ['m-prev'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', async () => {
      await invokeTauri('media_prev');
      if (typeof window.pollSystemAndMedia === 'function') setTimeout(window.pollSystemAndMedia, 250);
    });
  });

  listenTauri('nexus-voice', (event) => {
    let payload = (event && event.payload !== undefined) ? event.payload : event;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (err) { console.warn('JSON parse error in nexus-voice:', err); }
    }
    if (!payload || typeof payload !== 'object') payload = {};

    const evTs = Number(payload.ts) || 0;
    if (evTs) {
      if (evTs < lastNexusTs && lastNexusTs - evTs < 60000) return;
      lastNexusTs = evTs;
    }

    const action = String(payload.action || payload.type || '').toLowerCase();
    if (action === 'set_timer' || action === 'timer') {
      let secs = 0;
      if (typeof payload.seconds === 'number' && payload.seconds > 0) {
        secs = payload.seconds;
      } else if (typeof payload.minutes === 'number' && payload.minutes > 0) {
        secs = payload.minutes * 60;
      } else if (typeof payload.duration === 'number' && payload.duration > 0) {
        secs = payload.duration;
      } else if (typeof payload.duration === 'string') {
        const m = payload.duration.match(/(\d+)\s*(m|s|min|sec)/i);
        if (m) {
          const val = parseInt(m[1], 10);
          secs = m[2].toLowerCase().startsWith('s') ? val : val * 60;
        }
      }
      if (secs > 0) {
        startTimerWithSecs(secs);
        const mm = Math.floor(secs / 60);
        const ss = secs % 60;
        showToast('bolt', `Timer set for ${mm ? mm + 'm ' : ''}${ss ? ss + 's' : ''}`.trim(), 2500);
      }
    }

    const status = payload.status || '';
    const text = payload.text || '';
    triggerNexusVoiceAnimation(status, text, payload);
  });
}
