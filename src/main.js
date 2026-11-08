// GENERATED from main-parts/*.js by scripts/build-main.mjs. Edit the parts, not this file.
import { load as loadSettings, save as saveSettings, subscribe as onSettings, applyTheme } from './shared.js';

let SET = loadSettings();
applyTheme(SET);

// Firebase is used strictly for 5-minute WebRTC room discovery & SDP/ICE handshake signaling
const DEFAULT_FIREBASE_DB_URL = "";
function getFirebaseUrl() {
  const custom = (SET.share && SET.share.firebaseUrl) ? SET.share.firebaseUrl.trim() : '';
  return (custom || DEFAULT_FIREBASE_DB_URL).replace(/\/+$/, '');
}
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes validity
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const island = document.getElementById('island');

const myPeerId = 'PC-' + Math.floor(10000 + Math.random() * 89999);
let myDeviceName = SET.share.deviceName || localStorage.getItem('island_pc_name') || myPeerId;

const appState = {
  currentView: 'view-compact',
  lastVolume: 75,
  trayFiles: [],
  roomCode: null,
  isCodeHost: false,
  manuallyDisconnected: new Set(),
  roomExpiresAt: 0,
  roomExpiryTimer: null,
  pollSignalTimer: null,
  peers: [], // Connected WebRTC peers: [{ id, name }]
  traySelect: null, // { peerId, picked:Set } while choosing which tray files to send
  draggingOut: false,
  polling: false,
  lastTry: {},
  xfer: null,
  prompting: false,
  transferring: false,
  mediaPlaying: false,
  mediaProgressSec: 0,
  mediaDuration: 0,
  mediaSeeking: false,
  mediaTitleKey: '',
  timerPresetMins: 25,
  timerSeconds: 25 * 60,
  timerRunning: false,
  timerInterval: null,
  volOpen: false,
  wifiRadio: true,
  btRadio: true
};

// WebRTC Connection Store: peerId -> { pc, dc, name, makingOffer, outgoingQueue }
const rtcPeers = new Map();

const MEDIA_H = 166;
const MEDIA_H_VOL = 198;

async function invokeTauri(cmd, args = {}) {
  if (cmd === 'resize_island') {
    appState.lastWin = { width: args.width, height: args.height };
    const k = SET.appearance.scale / 100;
    args = { width: Math.round(args.width * k), height: Math.round(args.height * k) };
  }
  if (window.__TAURI__ && window.__TAURI__.core) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Control-panel slots (small registry). The settings choose what sits in the two slots.
//   id      -> { el: tile element id, start(): called when the slot becomes visible,
//                stop(): called when it is swapped away }
// A slot that is not shown has its whole backend stopped (Wi-Fi: WLAN watcher closed,
// Bluetooth: all commands idle, no timers, no events).
// To add an item: add it to SLOT_OPTIONS in shared.js, add a tile in index.html and an entry here.
// ---------------------------------------------------------------------------------------
const slotRunning = new Set();
const SLOT_DEFS = {
  wifi: {
    el: 'tile-wifi',
    start: async () => { await invokeTauri('wifi_backend', { on: true }); refreshRadios(); refreshWifiNow(); },
    stop: async () => {
      await invokeTauri('wifi_backend', { on: false });
      document.getElementById('wifi-cap').textContent = '';
    }
  },
  bt: {
    el: 'tile-bt',
    start: async () => { await invokeTauri('bt_backend', { on: true }); refreshRadios(); refreshBtCaption(); },
    stop: async () => {
      await invokeTauri('bt_backend', { on: false });
      document.getElementById('bt-cap').textContent = '';
    }
  },
  mic: {
    el: 'tile-mic',
    start: () => refreshMic(),
    stop: () => {},
    click: () => toggleMic()
  },
  notepad: {
    el: 'tile-notepad',
    start: () => {},
    stop: () => {},
    click: () => {
      switchView('view-notepad', 'state-sub', 316, 240);
      if (typeof focusNotepad === 'function') focusNotepad();
    }
  },
  drop: {
    el: 'tile-drop',
    start: () => {},
    stop: () => {},
    click: () => {
      if (typeof toggleInexDrop === 'function') toggleInexDrop();
      else switchView('view-p2p', 'state-sub', 316, 248);
    }
  },
  tray: {
    el: 'tile-tray',
    start: () => { if (typeof updateTrayUI === 'function') updateTrayUI(); },
    stop: () => {},
    click: () => { if (typeof openTrayView === 'function') openTrayView(); }
  }
};

function applySlots() {
  let a = SET.slots && SET.slots.a;
  let b = SET.slots && SET.slots.b;
  let c = SET.slots && SET.slots.c;
  let d = SET.slots && SET.slots.d;
  if (!SLOT_DEFS[a]) a = 'wifi';
  if (!SLOT_DEFS[b]) b = 'drop';
  if (!SLOT_DEFS[c]) c = 'bt';
  if (!SLOT_DEFS[d]) d = 'tray';

  const used = new Set();
  const allDefs = Object.keys(SLOT_DEFS);
  const slots = [a, b, c, d];
  for (let i = 0; i < 4; i++) {
    if (used.has(slots[i])) {
      const alt = allDefs.find(k => !used.has(k)) || 'wifi';
      slots[i] = alt;
    }
    used.add(slots[i]);
  }
  [a, b, c, d] = slots;

  const slotMap = { [a]: 1, [b]: 2, [c]: 3, [d]: 4 };
  const want = new Set([a, b, c, d]);

  Object.entries(SLOT_DEFS).forEach(([id, def]) => {
    const tile = document.getElementById(def.el);
    if (!tile) return;
    const on = want.has(id);
    tile.classList.toggle('hidden', !on);
    if (on) {
      tile.style.order = slotMap[id];
      if (!slotRunning.has(id)) {
        slotRunning.add(id);
        def.start();
      }
    } else {
      if (slotRunning.has(id)) {
        slotRunning.delete(id);
        def.stop();
      }
    }
  });
}

// Microphone slot: real system mute of the default capture device
function renderMic(m) {
  const t = document.getElementById('tile-mic');
  if (!t) return;
  const none = m === null || m === undefined;
  t.classList.toggle('muted', m === true);
  t.classList.toggle('active', m === false);
  document.getElementById('mic-sub').textContent = none ? 'No mic' : m ? 'Muted' : 'On';
  document.getElementById('mic-cap').textContent = none ? 'No mic' : m ? 'Muted' : '';
}
async function refreshMic() {
  renderMic(await invokeTauri('get_mic_muted'));
}
async function toggleMic() {
  const muted = document.getElementById('tile-mic').classList.contains('muted');
  await invokeTauri('set_mic_muted', { muted: !muted });
  refreshMic();
}
document.getElementById('tile-mic').addEventListener('click', () => SLOT_DEFS.mic.click());
document.getElementById('tile-notepad').addEventListener('click', () => SLOT_DEFS.notepad.click());

function updateCompactStateClasses() {
  const isPrompt = !!(appState.prompting || appState.lockerPrompting);
  const isBusy = appState.transferring || isPrompt || appState.toast;
  const hasBadges = appState.trayFiles.length > 0 || appState.peers.length > 0;
  island.classList.toggle('has-toast', !!appState.toast);
  island.classList.toggle('has-badges', hasBadges && !appState.mediaPlaying && !isBusy);
  island.classList.toggle('media-active', !!appState.mediaPlaying && !isBusy);
}

function switchView(viewId, stateClass, winWidth, winHeight) {
  appState.keepOpen = false;
  if (appState.currentView === 'view-bt' && viewId !== 'view-bt') {
    appState.btBusy = false;
    invokeTauri('bt_discovery', { on: false }); // new-device discovery only runs while the list is open
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const target = document.getElementById(viewId);
  if (target) target.classList.add('active');

  island.classList.remove(
    'state-compact', 'state-drop', 'state-control',
    'state-tray', 'state-sub', 'state-media', 'state-calendar'
  );
  island.classList.add(stateClass);
  appState.currentView = viewId;
  updateCompactStateClasses();
  if (typeof syncLoadTimer === 'function') syncLoadTimer();
  if (typeof syncMediaTick === 'function') syncMediaTick();
  if (typeof eqKick === 'function') eqKick();

  const isFloating = SET.notch && SET.notch.style === 'floating';
  let effH = winHeight;
  if (isFloating) {
    if (viewId === 'view-compact') {
      effH = 48;
    } else {
      effH = winHeight + 12;
    }
  }

  invokeTauri('resize_island', { width: winWidth, height: effH });

  if (viewId === 'view-compact' && appState.timerStartPending) {
    appState.timerStartPending = false;
    setTimeout(() => { if (appState.timerRunning && typeof showTimerStartHud === 'function') showTimerStartHud(); }, 450);
  }
}

function openMedia() {
  switchView('view-media', 'state-media', 316, appState.volOpen ? MEDIA_H_VOL : MEDIA_H);
  island.classList.toggle('vol-open', appState.volOpen);
  if (typeof renderMediaProgress === 'function') renderMediaProgress();
  invokeTauri('get_system_volume').then((v) => { if (typeof v === 'number') setVolumeUI(v); });
}

function goCompact() {
  island.classList.remove('vol-open');
  document.getElementById('tray-peer-picker').classList.add('hidden');
  switchView('view-compact', 'state-compact', 265, 36);
}

// 1. Live Clock + Media Progress Tick
function updateClocks() {
  const now = new Date();
  let hrs = now.getHours();
  const mins = String(now.getMinutes()).padStart(2, '0');
  const ampm = hrs >= 12 ? 'pm' : 'am';
  let str;
  if (SET.general.hour24) {
    str = `${String(hrs).padStart(2, '0')}:${mins}`;
  } else {
    hrs = hrs % 12 || 12;
    str = `${String(hrs).padStart(2, '0')}:${mins} ${ampm}`;
  }

  if (!appState.timerRunning && !appState.transferring && !appState.prompting && !appState.lockerPrompting) {
    const cClock = document.getElementById('c-clock');
    if (cClock && cClock.textContent !== str) cClock.textContent = str;
  }
  const ctrlClock = document.getElementById('ctrl-clock-tab');
  if (ctrlClock && ctrlClock.textContent !== str) ctrlClock.textContent = str;
  const calClock = document.getElementById('cal-top-clock');
  if (calClock && calClock.textContent !== str) calClock.textContent = str;
  const timerClock = document.getElementById('timer-top-clock');
  if (timerClock && timerClock.textContent !== str) timerClock.textContent = str;
}

let mediaBackendPos = 0;
let mediaBackendTime = Date.now();

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function renderMediaProgress(pos) {
  if (pos === undefined) {
    if (appState.mediaPlaying && !appState.mediaSeeking && appState.mediaDuration > 0) {
      const now = Date.now();
      const elapsed = Math.max(0, (now - mediaBackendTime) / 1000);
      const computed = Math.min(appState.mediaDuration, mediaBackendPos + elapsed);
      if (appState.mediaProgressSec && computed < appState.mediaProgressSec && (appState.mediaProgressSec - computed) < 6.0) {
        pos = appState.mediaProgressSec;
      } else {
        pos = computed;
        appState.mediaProgressSec = pos;
      }
    } else {
      pos = appState.mediaProgressSec || 0;
    }
  }
  const dur = appState.mediaDuration || 0;
  pos = Math.min(dur || pos, Math.max(0, pos));

  if (appState.currentView !== 'view-media') return;

  const curTimeEl = document.getElementById('m-cur-time');
  const totTimeEl = document.getElementById('m-tot-time');
  const progFillEl = document.getElementById('m-prog-fill');
  const sliderEl = document.getElementById('m-seek-slider');

  if (curTimeEl) {
    const str = fmtTime(pos);
    if (curTimeEl.textContent !== str) curTimeEl.textContent = str;
  }
  if (totTimeEl) {
    const str = dur > 0 ? `-${fmtTime(dur - pos)}` : '--:--';
    if (totTimeEl.textContent !== str) totTimeEl.textContent = str;
  }
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  if (progFillEl) {
    const w = `${pct}%`;
    if (progFillEl.style.width !== w) progFillEl.style.width = w;
  }
  if (sliderEl && !appState.mediaSeeking) {
    const v = Math.round(pct * 10);
    if (sliderEl.value != v) sliderEl.value = v;
  }
}

// Tick media progress smoothly every 250ms when expanded media player is open
// The timer only exists while the media panel is open and a track is playing.
var mediaTickT; // var + no initializer: switchView() may call syncMediaTick() early
function syncMediaTick() {
  const want = appState.currentView === 'view-media' && appState.mediaPlaying && appState.mediaDuration > 0;
  if (want && !mediaTickT) {
    mediaTickT = setInterval(() => {
      if (!appState.mediaSeeking) renderMediaProgress();
    }, 250);
  } else if (!want && mediaTickT) {
    clearInterval(mediaTickT);
    mediaTickT = null;
  }
}

// Interactive Media Timeline Seek Bar
const seekSlider = document.getElementById('m-seek-slider');
seekSlider.addEventListener('input', (e) => {
  if (appState.mediaDuration <= 0) return;
  appState.mediaSeeking = true;
  const pct = Number(e.target.value) / 1000;
  const targetSec = pct * appState.mediaDuration;
  document.getElementById('m-prog-fill').style.width = `${pct * 100}%`;
  document.getElementById('m-cur-time').textContent = fmtTime(targetSec);
  document.getElementById('m-tot-time').textContent = `-${fmtTime(appState.mediaDuration - targetSec)}`;
});

seekSlider.addEventListener('change', async (e) => {
  if (appState.mediaDuration <= 0) {
    appState.mediaSeeking = false;
    return;
  }
  const pct = Number(e.target.value) / 1000;
  const targetSec = pct * appState.mediaDuration;
  mediaBackendPos = targetSec;
  mediaBackendTime = Date.now();
  appState.mediaProgressSec = targetSec;
  await invokeTauri('seek_media', { positionSec: targetSec });
  setTimeout(() => { appState.mediaSeeking = false; }, 300);
});

// Artwork & Dominant Ambient Color
async function loadMediaArt() {
  const url = await invokeTauri('get_media_art');
  const cArt = document.getElementById('c-art'), mArt = document.getElementById('m-art');
  const cFb = document.getElementById('c-art-fallback'), mFb = document.getElementById('m-art-fallback');
  const card = document.getElementById('view-media');

  if (!url) {
    appState.loadedArtUrl = '';
    [cArt, mArt].forEach((i) => {
      i.classList.add('hidden');
      i.src = '';
    });
    [cFb, mFb].forEach((i) => (i.style.display = ''));
    if (card) card.style.setProperty('--amb', '70, 130, 180');
    return;
  }

  if (url === appState.loadedArtUrl) return;

  const img = new Image();
  img.onload = () => {
    // If image is a tiny icon (width and height <= 64), skip it (it's a browser placeholder)
    if (img.naturalWidth > 0 && img.naturalWidth <= 64 && img.naturalHeight <= 64) {
      return;
    }
    appState.loadedArtUrl = url;
    cArt.src = url;
    mArt.src = url;
    [cArt, mArt].forEach((i) => i.classList.remove('hidden'));
    [cFb, mFb].forEach((i) => (i.style.display = 'none'));
    const c = dominantColor(img);
    if (card) card.style.setProperty('--amb', c);
    const mBtn = document.getElementById('c-media-btn');
    if (mBtn) mBtn.style.setProperty('--thumb-glow', `rgba(${c}, 0.9)`);
  };
  img.src = url;
}

function dominantColor(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 24, 24);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
    const sat = max === 0 ? 0 : (max - min) / max;
    const wt = 0.15 + sat * sat * 3 + (max > 40 ? 0.1 : 0);
    r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
  }
  r /= w; g /= w; b /= w;
  const m = Math.max(r, g, b) || 1, k = m < 120 ? 120 / m : 1;
  return `${Math.min(255, Math.round(r * k))}, ${Math.min(255, Math.round(g * k))}, ${Math.min(255, Math.round(b * k))}`;
}

// The clock shows hours:minutes, so wake only on the minute (and again after the PC resumes).
function tickClock() {
  updateClocks();
  setTimeout(tickClock, 60000 - (Date.now() % 60000) + 20);
}
tickClock();
onTauriEvent('system-resumed', updateClocks);

function clearMediaUI() {
  appState.cachedMedia = null;
  appState.mediaPlaying = false;
  appState.mediaTitleKey = '';
  appState.loadedArtUrl = '';

  const eq = document.getElementById('c-eq');
  const mediaBtn = document.getElementById('c-media-btn');
  const cArt = document.getElementById('c-art');
  const mArt = document.getElementById('m-art');
  const cFb = document.getElementById('c-art-fallback');
  const mFb = document.getElementById('m-art-fallback');
  const playSvg = document.getElementById('m-play-svg');
  const mEqBars = document.getElementById('m-eq-bars');
  const mTitle = document.getElementById('m-title');
  const mArtist = document.getElementById('m-artist');
  const card = document.getElementById('view-media');

  if (eq) eq.classList.add('hidden');
  if (mediaBtn) {
    mediaBtn.classList.add('hidden');
    mediaBtn.classList.remove('paused');
  }
  if (cArt) {
    cArt.src = '';
    cArt.classList.add('hidden');
  }
  if (mArt) {
    mArt.src = '';
    mArt.classList.add('hidden');
  }
  if (cFb) cFb.style.display = '';
  if (mFb) mFb.style.display = '';
  if (card) card.style.setProperty('--amb', '70, 130, 180');
  if (playSvg) playSvg.innerHTML = `<polygon points="6 3 20 12 6 21"/>`;
  if (mEqBars) mEqBars.style.visibility = 'hidden';
  if (mTitle) mTitle.textContent = 'Not Playing';
  if (mArtist) mArtist.textContent = 'Spotify / YouTube';

  appState.mediaProgressSec = 0;
  appState.mediaDuration = 0;
  if (typeof syncMediaTick === 'function') syncMediaTick();
  renderMediaProgress();

  island.classList.remove('media-active');
  updateCompactStateClasses();
  syncEq();
}

// 2. Poll Media, RAM, Wi-Fi & Fullscreen Window State (Smart Mode)
// 2. System state. Windows now TELLS us about changes (events from Rust); the only timer left
// is one cheap native stats read every 3 s, and it sleeps while the island is hidden.
async function refreshMedia() {
  if (SET.notch && SET.notch.musicMode === false) {
    clearMediaUI();
    return;
  }

  const media = await invokeTauri('get_media_status');
  const eq = document.getElementById('c-eq');
  const mediaBtn = document.getElementById('c-media-btn');
  const playSvg = document.getElementById('m-play-svg');
  const mTitle = document.getElementById('m-title');
  const mArtist = document.getElementById('m-artist');
  const mEqBars = document.getElementById('m-eq-bars');

  const hasMedia = !!(media && media.title && media.title.trim());
  const isPlaying = !!(hasMedia && media.playing);

  appState.mediaPlaying = isPlaying;

  if (!hasMedia) {
    clearMediaUI();
    return;
  }

  if (media.duration > 0) appState.mediaDuration = media.duration;
  syncMediaTick();

  // Active track exists
  if (isPlaying) {
    if (mTitle) mTitle.textContent = media.title;
    if (mArtist) mArtist.textContent = media.artist || 'Playing on PC';
    if (playSvg) playSvg.innerHTML = `<rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/>`;
    if (mEqBars) mEqBars.style.visibility = 'visible';

    if (SET.notch && SET.notch.compactMode !== false) {
      if (eq) eq.classList.remove('hidden');
      if (mediaBtn) mediaBtn.classList.remove('hidden', 'paused');
    } else {
      if (eq) eq.classList.add('hidden');
      if (mediaBtn) mediaBtn.classList.add('hidden');
    }

    const key = media.title + '|' + (media.artist || '');
    const isNewTrack = key !== appState.mediaTitleKey;
    const now = media.updated_at || Date.now();

    if (isNewTrack) {
      appState.mediaTitleKey = key;
      appState.loadedArtUrl = '';
      mediaBackendPos = Math.max(0, media.position || 0);
      mediaBackendTime = now;
      appState.mediaProgressSec = mediaBackendPos;
      loadMediaArt();
      // Retry in 400ms and 1200ms to guarantee fetching YouTube high-res thumbnail after initial buffering
      setTimeout(loadMediaArt, 400);
      setTimeout(loadMediaArt, 1200);
    } else if (!appState.mediaSeeking && media.position >= 0) {
      // Smooth monotonic progress extrapolation
      const currentExtrapolated = mediaBackendPos + Math.max(0, (now - mediaBackendTime) / 1000);
      const forwardJump = media.position - currentExtrapolated;
      const backwardJump = currentExtrapolated - media.position;

      // Only accept backward change if user performed a real backward seek (> 6.0s).
      // Stale polling timestamps (< 6s backwards) are completely ignored to prevent jumping glitches.
      if (backwardJump > 6.0 || forwardJump > 1.2) {
        mediaBackendPos = media.position;
        mediaBackendTime = now;
      }
    }
    renderMediaProgress();
  } else {
    // Paused: hide equalizer and compact disc, return island to clean desktop mode
    if (eq) eq.classList.add('hidden');
    if (mediaBtn) {
      mediaBtn.classList.add('hidden');
      mediaBtn.classList.add('paused');
    }
    if (mEqBars) mEqBars.style.visibility = 'hidden';
    if (playSvg) playSvg.innerHTML = `<polygon points="6 3 20 12 6 21"/>`;

    // Keep metadata in expanded player if opened
    if (mTitle) mTitle.textContent = media.title;
    if (mArtist) mArtist.textContent = media.artist ? `${media.artist} (Paused)` : 'Paused on PC';
    if (!appState.mediaSeeking && media.position >= 0) {
      mediaBackendPos = media.position;
      mediaBackendTime = Date.now();
      appState.mediaProgressSec = media.position;
    }
    renderMediaProgress();
  }

  updateCompactStateClasses();
  syncEq();
}

async function refreshRadios() {
  // only ask about radios whose slot is shown (a hidden slot costs nothing)
  const [wifiOn, btOn] = await Promise.all([
    slotRunning.has('wifi') ? invokeTauri('get_radio_state', { kind: 'wifi' }) : null,
    slotRunning.has('bt') ? invokeTauri('get_radio_state', { kind: 'bt' }) : null
  ]);
  if (typeof wifiOn === 'boolean') applyRadio('wifi', wifiOn);
  if (typeof btOn === 'boolean') applyRadio('bt', btOn);
}

async function refreshStats() {
  const stats = await invokeTauri('get_sys_stats');
  if (stats) {
    appState.stats = stats;
    renderWidgets();
    batteryOverlays(stats);
    if (slotRunning.has('wifi')) {
      document.getElementById('wifi-cap').textContent =
        appState.wifiRadio && stats.wifi_name && stats.wifi_name !== 'Not connected' ? stats.wifi_name : '';
      if (appState.wifiRadio) document.getElementById('wifi-sub').textContent = stats.wifi_name;
    }

    const currentMode = SET.notch.mode;
    if (currentMode === 'smart' && stats.is_fullscreen && appState.currentView === 'view-compact') {
      island.classList.add('smart-hidden');
    } else {
      island.classList.remove('smart-hidden');
    }
  }
}

async function pollSystemAndMedia() {
  await refreshMedia();
  await refreshRadios();
  await refreshStats();
}

// CPU / GPU / RAM / Disk / Net speed: Windows has no "value changed" event for these, so they are
// sampled. The timer exists ONLY while one of those widgets is on screen (compact view, window visible);
// everything else (battery, Wi-Fi, radios, media, fullscreen, volume ...) arrives as a native event.
// (var, no initializer: switchView() may call syncLoadTimer() before this line has run)
var loadTimer, loadBusy;
function loadWanted() {
  if (document.hidden || appState.currentView !== 'view-compact') return false;
  const wL = SET.widgets ? SET.widgets.left : null;
  const wR = SET.widgets ? SET.widgets.right : null;
  return ['ram', 'cpu', 'gpu', 'disk', 'net'].some(k => wL === k || wR === k);
}
async function refreshLoad() {
  const load = await invokeTauri('get_sys_load');
  if (!load) return;
  appState.stats = Object.assign(appState.stats || {}, load);
  // network speed is only read while the Net Speed widget is selected
  if (SET.widgets.left === 'net' || SET.widgets.right === 'net') {
    try {
      const n = await invokeTauri('get_net_speed');
      if (Array.isArray(n)) appState.net = n;
    } catch (_) {}
  }
  renderWidgets();
}
async function loadTick() {
  if (loadBusy) return;
  loadBusy = true;
  try { await refreshLoad(); } finally { loadBusy = false; }
}
function syncLoadTimer() {
  const want = loadWanted();
  if (want && !loadTimer) { loadTick(); loadTimer = setInterval(loadTick, 3500); }
  else if (!want && loadTimer) { clearInterval(loadTimer); loadTimer = null; }
}
document.addEventListener('visibilitychange', syncLoadTimer);
function onTauriEvent(name, fn) {
  try {
    const r = window.__TAURI__.event.listen(name, fn);
    if (r && r.catch) r.catch((e) => console.warn('event listen failed:', name, e));
  } catch (_) {}
}
let mediaEvT = null, radioEvT = null;
onTauriEvent('media-changed', () => {
  clearTimeout(mediaEvT);
  mediaEvT = setTimeout(async () => {
    await refreshMedia();
    if (appState.mediaPlaying) {
      loadMediaArt();
    }
  }, 100);
});
// Player was seeked / position corrected (also from another app): refresh the progress only
let mediaTlT = null;
onTauriEvent('media-timeline-changed', () => { clearTimeout(mediaTlT); mediaTlT = setTimeout(refreshMedia, 300); });
// Volume / mute changed anywhere in Windows (volume keys, tray slider, headset, other apps)
let volDrag = false;
['slider-vol', 'm-vol-slider'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('pointerdown', () => { volDrag = true; });
});
window.addEventListener('pointerup', () => { volDrag = false; });
onTauriEvent('volume-changed', (e) => {
  const l = e && e.payload && e.payload.level;
  if (!volDrag && typeof l === 'number') setVolumeUI(l);
});
// Microphone mute changed anywhere in Windows
onTauriEvent('mic-muted-changed', (e) => renderMic(e && e.payload ? e.payload.muted : null));
// Speaker / headphone / mic plugged, removed or switched
onTauriEvent('audio-device-changed', () => {
  if (appState.currentView === 'view-audio') loadAudioDeviceList(false);
});
onTauriEvent('radio-changed', () => { clearTimeout(radioEvT); radioEvT = setTimeout(refreshRadios, 200); });
// Instant smart mode fullscreen response (0ms latency from Rust watcher)
onTauriEvent('fullscreen-changed', (e) => {
  const isFs = !!(e && e.payload && e.payload.is_fullscreen);
  appState.isFs = isFs;
  if (SET.notch.mode === 'smart' && appState.currentView === 'view-compact') {
    island.classList.toggle('smart-hidden', isFs);
  } else {
    island.classList.remove('smart-hidden');
  }
});
// Instant charger plug-in / power status changes from Rust power watcher
onTauriEvent('power-changed', (e) => {
  if (e && e.payload) {
    if (!appState.stats) appState.stats = {};
    appState.stats.battery_pct = e.payload.battery_pct;
    appState.stats.charging = e.payload.charging;
    batteryOverlays(appState.stats);
  }
});
// Wi-Fi connection / scan changes arrive from the native WLAN notification (no polling)
let wifiEvT = null;
async function refreshWifiNow() {
  const st = await invokeTauri('get_wifi_status');
  if (!st) return;
  if (appState.stats) { appState.stats.wifi_name = st.name; appState.stats.wifi_signal = st.signal; }
  document.getElementById('wifi-cap').textContent =
    appState.wifiRadio && st.name && st.name !== 'Not connected' ? st.name : '';
  if (appState.wifiRadio) document.getElementById('wifi-sub').textContent = st.name;
  if (appState.currentView === 'view-wifi') loadWifiList(true);
}
onTauriEvent('wifi-changed', () => { clearTimeout(wifiEvT); wifiEvT = setTimeout(refreshWifiNow, 300); });
pollSystemAndMedia();
syncLoadTimer();

// 3. Compact Bar Clicks
document.getElementById('c-center-trigger').addEventListener('click', (e) => {
  if (e.target.closest('#c-incoming-alert')) return;
  if (island.classList.contains('alarm-active')) {
    if (typeof dismissTimerAlarm === 'function') dismissTimerAlarm();
    return;
  }
  switchView('view-control', 'state-control', 316, 292);
  refreshBtCaption();
  if (slotRunning.has('mic')) refreshMic();
});
document.getElementById('c-alarm-box')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (typeof dismissTimerAlarm === 'function') dismissTimerAlarm();
});
document.getElementById('btn-alarm-snooze')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (typeof snoozeClockAlarm === 'function') snoozeClockAlarm();
  if (typeof dismissTimerAlarm === 'function') dismissTimerAlarm();
});
document.getElementById('btn-alarm-dismiss')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (typeof dismissTimerAlarm === 'function') dismissTimerAlarm();
});
document.getElementById('c-media-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  openMedia();
});
document.getElementById('c-eq').addEventListener('click', (e) => {
  e.stopPropagation();
  openMedia();
});
document.getElementById('c-tray-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  openTrayView();
});
document.getElementById('c-peer-badge').addEventListener('click', (e) => {
  e.stopPropagation();
  switchView('view-p2p', 'state-sub', 316, 208);
});

island.addEventListener('mouseleave', () => {
  if (appState.keepOpen) return;      // typing a Wi-Fi password: do not collapse
  if (appState.currentView !== 'view-compact') {
    goCompact();
  }
});

// 4. Control Center Navigation & Sub-Menus
// (Clock in main menu is display-only; subviews navigate back via their left back-arrow)

const BARS = ['▁', '▂▃', '▂▄▅', '▂▄▆█', '▂▄▆█'];
const ROW_ICON = {
  link: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  unlink: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>'
};

function rowAction(connected) {
  const b = document.createElement('span');
  b.className = 'row-act';
  b.title = connected ? 'Disconnect' : 'Connect';
  b.innerHTML = connected ? ROW_ICON.unlink : ROW_ICON.link;
  return b;
}

let selectedWifiSsid = null;
let wifiBusySsid = null;

async function loadWifiList(soft) {
  const netList = document.getElementById('wifi-network-list');
  const btn = document.getElementById('btn-refresh-wifi');
  if (!appState.wifiRadio) {
    netList.innerHTML = `<div class="empty-hint">Wi-Fi is off</div>`;
    return;
  }
  if (appState.keepOpen) return; // password panel is open
  btn.classList.add('spin');
  if (!soft) netList.innerHTML = `<div class="empty-hint">Scanning…</div>`;
  const res = await invokeTauri('get_wifi_networks');
  btn.classList.remove('spin');
  if (appState.currentView !== 'view-wifi' || appState.keepOpen) return;
  const networks = res && Array.isArray(res.networks) ? res.networks : [];
  const scanError = res && res.error ? res.error : '';
  const wn = appState.stats && appState.stats.wifi_name;
  const current = wn && wn !== 'Not connected' ? wn : '';
  const list = networks.map((n) => ({ ...n }));
  const sigPct = (appState.stats && appState.stats.wifi_signal) || 0;
  const sigBars = sigPct >= 75 ? 4 : sigPct >= 50 ? 3 : sigPct >= 25 ? 2 : 1;
  if (current && !list.some((n) => n.ssid === current)) {
    list.unshift({ ssid: current, bars: sigBars, signal: sigPct, saved: true, security: 'wpa2', connected: true });
  }
  list.sort((a, b) => (b.ssid === current) - (a.ssid === current));
  netList.innerHTML = '';
  if (list.length === 0) {
    netList.innerHTML = `<div class="empty-hint">${scanError === 'no_adapter' ? 'No Wi-Fi adapter found' : 'No networks found. Tap refresh.'}</div>`;
  }
  list.forEach((n) => {
    const isConnected = n.ssid === current;
    const isExpanded = selectedWifiSsid === n.ssid;
    const isBusy = wifiBusySsid === n.ssid;

    const row = document.createElement('div');
    row.className = 'list-row-item' + (isConnected ? ' on' : '') + (isExpanded ? ' expanded' : '') + (isBusy ? ' busy' : '');

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = n.ssid;

    const pct = document.createElement('small');
    pct.className = 'sig-pct';
    const displaySignal = isConnected ? (sigPct > 0 ? sigPct : (n.signal || 85)) : (n.signal || Math.min(100, Math.round((n.bars || 2) * 25)));
    pct.textContent = `${displaySignal}%`;
    row.append(rowAction(isConnected), name, pct);

    if (n.security && n.security !== 'open') {
      const lock = document.createElement('span');
      lock.className = 'row-lock';
      lock.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      row.insertBefore(lock, pct);
    }

    // Inline action drawer (click / context expand)
    if (isExpanded) {
      const drawer = document.createElement('div');
      drawer.className = 'inline-action-drawer';
      drawer.addEventListener('click', (e) => e.stopPropagation());

      const errEl = document.createElement('div');
      errEl.className = 'drawer-err';

      if (isConnected) {
        const btnRow = document.createElement('div');
        btnRow.className = 'drawer-row';
        const disBtn = document.createElement('button');
        disBtn.className = 'drawer-btn ghost';
        disBtn.textContent = 'Disconnect';
        disBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          disBtn.disabled = true;
          wifiBusySsid = n.ssid;
          await invokeTauri('disconnect_wifi');
          if (appState.stats) appState.stats.wifi_name = 'Not connected';
          document.getElementById('wifi-cap').textContent = '';
          selectedWifiSsid = null;
          wifiBusySsid = null;
          loadWifiList(true);
        });
        btnRow.appendChild(disBtn);

        if (n.saved) {
          const fBtn = document.createElement('button');
          fBtn.className = 'drawer-btn ghost';
          fBtn.textContent = 'Forget';
          fBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            fBtn.disabled = true;
            await invokeTauri('wifi_forget', { ssid: n.ssid });
            selectedWifiSsid = null;
            loadWifiList(true);
          });
          btnRow.appendChild(fBtn);
        }
        drawer.appendChild(btnRow);
      } else if (n.saved) {
        const btnRow = document.createElement('div');
        btnRow.className = 'drawer-row';
        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn';
        connBtn.textContent = 'Connect';
        connBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          connBtn.disabled = true;
          wifiBusySsid = n.ssid;
          connBtn.textContent = 'Connecting…';
          const ok = await invokeTauri('connect_wifi_network', { ssid: n.ssid });
          wifiBusySsid = null;
          if (ok === false) {
            n.saved = false;
            loadWifiList(true);
            return;
          }
          selectedWifiSsid = null;
          setTimeout(() => loadWifiList(true), 2500);
        });
        const fBtn = document.createElement('button');
        fBtn.className = 'drawer-btn ghost';
        fBtn.textContent = 'Forget';
        fBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          fBtn.disabled = true;
          await invokeTauri('wifi_forget', { ssid: n.ssid });
          selectedWifiSsid = null;
          loadWifiList(true);
        });
        btnRow.append(connBtn, fBtn);
        drawer.appendChild(btnRow);
      } else if (n.security === 'open') {
        const btnRow = document.createElement('div');
        btnRow.className = 'drawer-row';
        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn';
        connBtn.textContent = 'Connect';
        connBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          connBtn.disabled = true;
          wifiBusySsid = n.ssid;
          connBtn.textContent = 'Connecting…';
          await invokeTauri('wifi_join', { ssid: n.ssid, password: '', security: 'open', hidden: false });
          wifiBusySsid = null;
          selectedWifiSsid = null;
          setTimeout(() => loadWifiList(true), 2500);
        });
        btnRow.appendChild(connBtn);
        drawer.appendChild(btnRow);
      } else {
        // Needs password
        const inpRow = document.createElement('div');
        inpRow.className = 'drawer-row';
        const passIn = document.createElement('input');
        passIn.type = 'password';
        passIn.className = 'drawer-input';
        passIn.placeholder = 'Password (8-63 chars)';
        passIn.autocomplete = 'off';
        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn';
        connBtn.textContent = 'Connect';

        const doJoin = async () => {
          const key = passIn.value;
          if (!key || key.length < 8) {
            errEl.textContent = 'Password must be 8 to 63 characters';
            return;
          }
          connBtn.disabled = passIn.disabled = true;
          connBtn.textContent = 'Connecting…';
          errEl.textContent = '';
          const res = await invokeTauri('wifi_join', { ssid: n.ssid, password: key, security: n.security || 'wpa2', hidden: false });
          if (res === 'ok') {
            selectedWifiSsid = null;
            loadWifiList(true);
          } else {
            connBtn.disabled = passIn.disabled = false;
            connBtn.textContent = 'Connect';
            errEl.textContent = res === 'wrong-password' || res === 'badkey' ? 'Wrong password' : 'Could not connect';
          }
        };

        connBtn.addEventListener('click', doJoin);
        passIn.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') doJoin();
          if (e.key === 'Escape') { selectedWifiSsid = null; loadWifiList(true); }
        });

        inpRow.append(passIn, connBtn);
        drawer.append(inpRow, errEl);
        setTimeout(() => passIn.focus(), 60);
      }

      row.appendChild(drawer);
    }

    const toggleRow = (e) => {
      e.stopPropagation();
      if (isBusy) return;
      if (isConnected) {
        selectedWifiSsid = selectedWifiSsid === n.ssid ? null : n.ssid;
        loadWifiList(true);
      } else if (n.saved) {
        if (e.type === 'contextmenu') {
          selectedWifiSsid = selectedWifiSsid === n.ssid ? null : n.ssid;
          loadWifiList(true);
        } else {
          row.classList.add('busy');
          invokeTauri('connect_wifi_network', { ssid: n.ssid }).then((ok) => {
            row.classList.remove('busy');
            if (ok === false) {
              selectedWifiSsid = n.ssid;
              loadWifiList(true);
            }
          });
        }
      } else {
        selectedWifiSsid = selectedWifiSsid === n.ssid ? null : n.ssid;
        loadWifiList(true);
      }
    };

    row.addEventListener('click', toggleRow);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      toggleRow(e);
    });

    netList.appendChild(row);
  });

  const hid = document.createElement('div');
  hid.className = 'list-row-item add-hidden';
  hid.textContent = '+ Add Network';
  hid.addEventListener('click', () => showWifiJoin({ ssid: '', hidden: true }));
  netList.appendChild(hid);
  if (scanError === 'location_off') {
    const hint = document.createElement('div');
    hint.className = 'wifi-hint';
    hint.innerHTML = 'Windows blocks Wi-Fi scanning while Location is off. Turn on "Let desktop apps access your location". <button id="wifi-loc-btn">Open Location settings</button>';
    netList.appendChild(hint);
    hint.querySelector('button').addEventListener('click', () => invokeTauri('open_location_settings'));
  }
}

// Password / hidden-network panel, inside the island
function showWifiJoin({ ssid, hidden, security }) {
  appState.keepOpen = true;
  invokeTauri('focus_island');
  const netList = document.getElementById('wifi-network-list');
  netList.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'wifi-join';
  const title = document.createElement('div');
  title.className = 'wj-title';
  const ssidIn = document.createElement('input');
  ssidIn.className = 'wj-input';
  ssidIn.placeholder = 'Network name (SSID)';
  ssidIn.maxLength = 32;
  ssidIn.autocomplete = 'off';
  if (hidden) box.append(ssidIn); else { title.textContent = ssid; box.append(title); }

  const passRow = document.createElement('div');
  passRow.className = 'wj-row';
  const pass = document.createElement('input');
  pass.className = 'wj-input';
  pass.type = 'password';
  pass.placeholder = 'Password';
  pass.maxLength = 64;
  pass.autocomplete = 'off';
  const eye = document.createElement('button');
  eye.className = 'wj-mini';
  eye.textContent = '👁';
  eye.title = 'Show / hide';
  eye.addEventListener('click', () => { pass.type = pass.type === 'password' ? 'text' : 'password'; });
  passRow.append(pass, eye);

  const row2 = document.createElement('div');
  row2.className = 'wj-row';
  const sec = document.createElement('select');
  sec.className = 'wj-input';
  [
    ['wpa2', 'WPA2-Personal (AES)'],
    ['wpa3', 'WPA3-Personal (SAE)'],
    ['wpa2_wpa3', 'WPA2/WPA3-Personal'],
    ['wpa', 'WPA-Personal (TKIP)'],
    ['open', 'Open (No password)']
  ].forEach(([v, t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t; sec.append(o);
  });
  if (security && ['wpa2', 'wpa3', 'wpa', 'open'].includes(security)) sec.value = security;
  const go = document.createElement('button');
  go.className = 'wj-btn';
  go.textContent = 'Connect';
  const cancel = document.createElement('button');
  cancel.className = 'wj-btn ghost';
  cancel.textContent = 'Cancel';
  row2.append(sec, go, cancel);

  const msg = document.createElement('div');
  msg.className = 'wj-msg';
  box.append(passRow, row2, msg);
  netList.append(box);

  sec.addEventListener('change', () => { pass.disabled = sec.value === 'open'; });
  cancel.addEventListener('click', () => { appState.keepOpen = false; loadWifiList(); });
  const submit = async () => {
    const name = hidden ? ssidIn.value.trim() : ssid;
    if (!name) { msg.className = 'wj-msg err'; msg.textContent = 'Enter the network name'; return; }
    go.disabled = true; cancel.disabled = true;
    msg.className = 'wj-msg'; msg.textContent = 'Connecting…';
    const r = await invokeTauri('wifi_join', { ssid: name, password: pass.value, security: sec.value, hidden });
    if (r === 'ok') {
      msg.textContent = 'Connected';
      if (appState.stats) appState.stats.wifi_name = name;
      appState.keepOpen = false;
      setTimeout(() => { if (appState.currentView === 'view-wifi') loadWifiList(); }, 700);
      return;
    }
    go.disabled = false; cancel.disabled = false;
    msg.className = 'wj-msg err';
    msg.textContent = r === 'badkey' ? 'Password must be 8 to 63 characters'
      : r === 'badssid' ? 'Network name is not valid'
      : r === 'failed' ? 'Could not connect. Wrong password or security type?'
      : 'Something went wrong, try again';
  };
  go.addEventListener('click', submit);
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => (hidden ? ssidIn : pass).focus(), 120);
}

function openWifiView() {
  switchView('view-wifi', 'state-sub', 316, 208);
  loadWifiList();
}
document.getElementById('tile-wifi').addEventListener('click', (e) => {
  if (e.target.closest('.chev')) return openWifiView();
  toggleRadio('wifi', !appState.wifiRadio);
});
document.getElementById('tile-wifi').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openWifiView();
});
document.getElementById('btn-refresh-wifi').addEventListener('click', loadWifiList);
document.getElementById('btn-more-wifi').addEventListener('click', () => invokeTauri('open_wifi_settings'));

const DEV_SVG = (inner) => `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const DEV_ICONS = {
  headphones: DEV_SVG('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'),
  speaker: DEV_SVG('<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" y1="6" x2="12.01" y2="6"/>'),
  mouse: DEV_SVG('<rect x="6" y="3" width="12" height="18" rx="6"/><line x1="12" y1="7" x2="12" y2="11"/>'),
  keyboard: DEV_SVG('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  phone: DEV_SVG('<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
  computer: DEV_SVG('<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/>'),
  watch: DEV_SVG('<rect x="7" y="6" width="10" height="12" rx="3"/><path d="M9 6l1-4h4l1 4M9 18l1 4h4l1-4"/>'),
  gamepad: DEV_SVG('<line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/>'),
  bt: DEV_SVG('<polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>')
};

function battHtml(pct) {
  const w = Math.max(1, Math.round(pct * 0.12));
  const cls = pct <= 20 ? 'low' : 'ok';
  return `<span class="batt ${cls}"><svg viewBox="0 0 18 10" width="16" height="9"><rect x="0.5" y="0.5" width="14" height="9" rx="2" fill="none" stroke="currentColor"/><rect x="15.5" y="3" width="2" height="4" rx="1" fill="currentColor"/><rect x="2" y="2" width="${w}" height="6" rx="1" fill="currentColor"/></svg></span>${pct}%`;
}

// battery value for a device name (Windows names the battery node a bit differently)
function btBatteryFor(name) {
  const list = appState.btBatt || [];
  const n = name.toLowerCase();
  const hit = list.find((b) => { const x = b.name.toLowerCase(); return x === n || x.includes(n) || n.includes(x); });
  return hit ? hit.pct : null;
}

// ---- Bluetooth list: paired devices, nearby devices to pair, PIN questions ----
function showBtNote(text) {
  const btList = document.getElementById('bt-device-list');
  if (!btList) return;
  const note = document.createElement('div');
  note.className = 'wifi-hint';
  note.textContent = text;
  btList.prepend(note);
  setTimeout(() => note.remove(), 3500);
}

let selectedBtName = null;

async function loadBtList(soft) {
  const btList = document.getElementById('bt-device-list');
  const btn = document.getElementById('btn-refresh-bt');
  if (!appState.btRadio) {
    btList.innerHTML = `<div class="empty-hint">Bluetooth is off</div>`;
    return;
  }
  if (appState.btBusy) return; // a pairing question is on screen: do not wipe it
  if (!soft) {
    btn.classList.add('spin');
    btList.innerHTML = `<div class="empty-hint">Scanning…</div>`;
  }
  const devices = await invokeTauri('get_bt_devices');
  btn.classList.remove('spin');
  if (appState.currentView !== 'view-bt' || appState.btBusy) return;
  btList.innerHTML = '';
  const subs = [];
  if (!devices || devices.length === 0) {
    btList.innerHTML = `<div class="empty-hint">No paired devices found.</div>`;
  } else {
    setBtCaption(devices);
    devices.forEach((d) => {
      const isExpanded = selectedBtName === d.name;
      const row = document.createElement('div');
      row.className = 'list-row-item' + (d.connected ? ' on' : '') + (isExpanded ? ' expanded' : '');
      const ico = document.createElement('span');
      ico.className = 'dev-ico';
      ico.innerHTML = DEV_ICONS[d.kind] || DEV_ICONS.bt;
      const text = document.createElement('div');
      text.className = 'row-text';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = d.name;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = d.connected ? 'Connected' : 'Paired';
      text.append(name, sub);
      row.append(ico, text, rowAction(d.connected));
      if (d.connected) subs.push({ d, sub });

      if (isExpanded) {
        const drawer = document.createElement('div');
        drawer.className = 'inline-action-drawer';
        drawer.addEventListener('click', (e) => e.stopPropagation());
        drawer.addEventListener('contextmenu', (e) => e.stopPropagation());

        const actRow = document.createElement('div');
        actRow.className = 'drawer-row';

        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn ' + (d.connected ? 'danger' : 'primary');
        connBtn.textContent = d.connected ? 'Disconnect' : 'Connect';

        const unpairBtn = document.createElement('button');
        unpairBtn.className = 'drawer-btn ghost danger';
        unpairBtn.textContent = 'Remove';

        const errEl = document.createElement('div');
        errEl.className = 'drawer-err';

        connBtn.addEventListener('click', async () => {
          connBtn.disabled = unpairBtn.disabled = true;
          connBtn.textContent = d.connected ? 'Disconnecting…' : 'Connecting…';
          errEl.textContent = '';
          const r = await invokeTauri('bt_set_connection', { name: d.name, on: !d.connected });
          if (r !== 'ok') {
            connBtn.disabled = unpairBtn.disabled = false;
            connBtn.textContent = d.connected ? 'Disconnect' : 'Connect';
            errEl.textContent = 'Could not ' + (d.connected ? 'disconnect' : 'connect');
          } else {
            selectedBtName = null;
            setTimeout(() => { if (appState.currentView === 'view-bt') loadBtList(true); }, 500);
          }
        });

        unpairBtn.addEventListener('click', async () => {
          connBtn.disabled = unpairBtn.disabled = true;
          unpairBtn.textContent = 'Removing…';
          errEl.textContent = '';
          const r = await invokeTauri('bt_unpair', { name: d.name });
          if (r !== 'ok') {
            connBtn.disabled = unpairBtn.disabled = false;
            unpairBtn.textContent = 'Remove';
            errEl.textContent = 'Could not remove device';
          } else {
            selectedBtName = null;
            loadBtList(true);
          }
        });

        actRow.append(connBtn, unpairBtn);
        drawer.append(actRow, errEl);
        row.appendChild(drawer);
      }

      const toggleBtRow = (e) => {
        if (e.target.closest('.inline-action-drawer')) return;
        selectedBtName = selectedBtName === d.name ? null : d.name;
        loadBtList(true);
      };

      row.addEventListener('click', toggleBtRow);
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        toggleBtRow(e);
      });

      btList.appendChild(row);
    });
  }
  // new devices that can be paired (filled by the discovery watcher while this list is open)
  const near = document.createElement('div');
  near.id = 'bt-nearby';
  btList.appendChild(near);
  renderBtNearby();
  // battery of the connected devices (one lookup for all)
  if (subs.length && SET.overlays.btBattery) {
    const bl = await invokeTauri('get_bt_batteries');
    appState.btBatt = Array.isArray(bl) ? bl : [];
    subs.forEach(({ d, sub }) => {
      const pct = btBatteryFor(d.name);
      if (pct !== null && sub.isConnected) sub.innerHTML = `Connected <span style="opacity:.5">•</span> ${battHtml(pct)}`;
    });
    setBtCaption(devices);
  }
}

async function renderBtNearby() {
  const box = document.getElementById('bt-nearby');
  if (!box || appState.currentView !== 'view-bt' || appState.btBusy || appState.btPairing) return;
  const list = (await invokeTauri('get_bt_nearby')) || [];
  if (!box.isConnected || appState.btBusy || appState.btPairing) return;
  box.innerHTML = '';
  if (!list.length) return;
  const head = document.createElement('div');
  head.className = 'wifi-hint';
  head.textContent = 'Nearby: click to pair';
  box.append(head);
  list.forEach((n) => {
    const row = document.createElement('div');
    row.className = 'list-row-item';
    const ico = document.createElement('span');
    ico.className = 'dev-ico';
    ico.innerHTML = DEV_ICONS[n.kind] || DEV_ICONS.bt;
    const text = document.createElement('div');
    text.className = 'row-text';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = n.name;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = 'Click to pair';
    text.append(name, sub);
    row.append(ico, text, rowAction(false));
    row.addEventListener('click', () => startBtPair(n, row, sub));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      startBtPair(n, row, sub);
    });
    box.append(row);
  });
}

const BT_PAIR_ERR = {
  wrong_pin: 'Wrong PIN, try again',
  rejected: 'Pairing was declined',
  timeout: 'The device did not answer in time',
  busy: 'Windows is already pairing another device'
};

async function startBtPair(n, row, sub) {
  if (appState.btPairing) return;
  appState.btPairing = true;
  row.classList.add('busy');
  sub.textContent = 'Pairing…';
  const r = await invokeTauri('bt_pair', { id: n.id, name: n.name });
  appState.btPairing = false;
  appState.btBusy = false;
  appState.keepOpen = false;
  if (appState.currentView !== 'view-bt') return;
  await loadBtList(true);
  if (r !== 'ok') showBtNote(BT_PAIR_ERR[r] || 'Could not pair, try again');
}

// Windows asks a question while pairing: confirm a number / show a number / type a PIN
function showBtPrompt(p) {
  if (!p) return;
  if (appState.currentView !== 'view-bt') {
    // the user left the list: do not leave Windows waiting
    if (p.kind !== 'display_pin') invokeTauri('bt_pair_answer', { accept: false });
    return;
  }
  appState.btBusy = true;
  appState.keepOpen = true;
  invokeTauri('focus_island');
  const btList = document.getElementById('bt-device-list');
  btList.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'wifi-join';
  const title = document.createElement('div');
  title.className = 'wj-title';
  title.textContent = p.name;
  const msg = document.createElement('div');
  msg.className = 'wj-msg';
  box.append(title);

  const answer = (accept, pin) => invokeTauri('bt_pair_answer', { accept, pin: pin || null });
  const row = document.createElement('div');
  row.className = 'wj-row';

  if (p.kind === 'display_pin') {
    msg.textContent = 'Type this code on the device:';
    const code = document.createElement('div');
    code.className = 'wj-title';
    code.style.fontSize = '20px';
    code.style.letterSpacing = '4px';
    code.textContent = p.pin;
    box.append(msg, code);
  } else if (p.kind === 'confirm_pin') {
    msg.textContent = 'Does this code match the one on the device?';
    const code = document.createElement('div');
    code.className = 'wj-title';
    code.style.fontSize = '20px';
    code.style.letterSpacing = '4px';
    code.textContent = p.pin;
    const yes = document.createElement('button');
    yes.className = 'wj-btn';
    yes.textContent = 'Yes, pair';
    const no = document.createElement('button');
    no.className = 'wj-btn ghost';
    no.textContent = 'No';
    row.append(yes, no);
    yes.addEventListener('click', () => { yes.disabled = no.disabled = true; msg.textContent = 'Pairing…'; answer(true); });
    no.addEventListener('click', () => { yes.disabled = no.disabled = true; answer(false); });
    box.append(msg, code, row);
  } else {
    msg.textContent = 'Enter the PIN of the device (often 0000):';
    const pin = document.createElement('input');
    pin.className = 'wj-input';
    pin.placeholder = 'PIN';
    pin.maxLength = 16;
    pin.autocomplete = 'off';
    const go = document.createElement('button');
    go.className = 'wj-btn';
    go.textContent = 'Pair';
    const cancel = document.createElement('button');
    cancel.className = 'wj-btn ghost';
    cancel.textContent = 'Cancel';
    row.append(pin, go, cancel);
    const submit = () => { if (!pin.value.trim()) return; go.disabled = cancel.disabled = true; msg.textContent = 'Pairing…'; answer(true, pin.value.trim()); };
    go.addEventListener('click', submit);
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    cancel.addEventListener('click', () => { go.disabled = cancel.disabled = true; answer(false); });
    box.append(msg, row);
    setTimeout(() => pin.focus(), 120);
  }
  btList.append(box);
}

function openBtView() {
  switchView('view-bt', 'state-sub', 316, 208);
  invokeTauri('bt_discovery', { on: true });
  loadBtList();
}

// Windows tells us when a device connects / disconnects / is added / removed (no polling)
let btEvT = null, btNearT = null;
let btHudTimer = null;
let btHudStartT = null;
let btHudBackT = null;
let prevConnectedBtDevs = null;

// ---- Dynamic-Island style HUD shared by Bluetooth connect and the charger ----
const BUDS_SVG = `<svg viewBox="0 0 40 40" fill="none">
  <defs><linearGradient id="budg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#aeb4be"/></linearGradient></defs>
  <g fill="url(#budg)">
    <rect x="13.4" y="14" width="4.8" height="21" rx="2.4"/><circle cx="12.5" cy="13" r="7.5"/>
    <rect x="21.8" y="14" width="4.8" height="21" rx="2.4"/><circle cx="27.5" cy="13" r="7.5"/>
  </g>
  <circle cx="11.2" cy="13" r="2.1" fill="#7c828c" opacity="0.55"/><circle cx="28.8" cy="13" r="2.1" fill="#7c828c" opacity="0.55"/>
</svg>`;
const BOLT_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.2 2 5 13.4h5.6L9.8 22 19 10.2h-5.7z"/></svg>`;
const LOW_BATT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="10" x2="6" y2="14" stroke="#ff453a" stroke-width="2.5"/></svg>`;
const BATT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="11" x2="12" y2="11"/></svg>`;

function hudIsFloating() { return !!(SET.notch && SET.notch.style === 'floating'); }
function hudCanShow() { return appState.currentView === 'view-compact'; }   // never fight an open menu
function hudRestoreWindow() {
  if (!hudCanShow() || appState.alarmActive) return;   // the timer-end card keeps its own window size
  tryInvoke('resize_island', { width: 265, height: hudIsFloating() ? 48 : 36 });
}

function showDeviceHud(o) {
  if (!hudCanShow() || appState.alarmActive) return;   // timer-end card has priority
  const hud = document.getElementById('c-bt-hud');
  const ico = document.getElementById('bt-hud-icon');
  const nameEl = document.getElementById('bt-hud-name');
  const tagEl = document.getElementById('bt-hud-tag');
  const battBox = document.getElementById('bt-hud-batt-box');
  const ring = document.getElementById('bt-hud-ring');
  const battTxt = document.getElementById('bt-hud-batt-pct');
  if (!hud || !ico || !nameEl) return;

  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT);
  // another HUD may be open: close it instantly
  clearTimeout(bioTimer); clearTimeout(bioAnimPhaseTimer); clearTimeout(bioStartTimer); clearTimeout(bioEndTimer);
  island.classList.remove('biometric-active', 'hud-out', 'hud-back', 'bio-hud');
  document.getElementById('c-biometric-box').classList.add('hidden');

  ico.className = 'bt-hud-icon' + (o.plain ? ' plain' : '') + (o.accent ? ' ' + o.accent : '');
  ico.innerHTML = o.iconHTML;
  nameEl.textContent = o.name || 'Device';
  tagEl.textContent = o.tag || 'Connected';

  const pct = o.pct;
  const hasBatt = pct != null && pct >= 0 && pct <= 100;
  battBox.classList.toggle('hidden', !hasBatt);
  // battery HUDs (charging / low / on battery) show a real battery glyph that fills up; Bluetooth keeps the ring
  const battFill = document.getElementById('bt-batt-fill');
  const battGlyph = document.getElementById('bt-batt-glyph');
  const asBatt = !!o.battery && hasBatt && !!battFill && !!battGlyph;
  battBox.classList.toggle('as-batt', asBatt);
  if (asBatt) {
    const charging = o.accent === 'green';
    const lowB = o.accent === 'red' || (pct <= 10 && !charging);
    const amberB = !lowB && (o.accent === 'amber' || (pct <= 20 && !charging));
    battGlyph.classList.toggle('charging', charging);
    battGlyph.classList.toggle('low', lowB);
    battFill.className = 'bt-batt-fill' + (lowB ? ' low' : amberB ? ' amber' : '');
    battFill.style.transition = 'none';
    battFill.style.width = '0%';
    void battFill.getBoundingClientRect();
    battFill.style.transition = '';
    setTimeout(() => { battFill.style.width = Math.max(pct, 6) + '%'; }, 60);
  }
  if (hasBatt) {
    ring.classList.remove('low', 'amber');
    if (o.accent === 'red' || (pct <= 10 && o.accent !== 'green')) {
      ring.classList.add('low');
    } else if (o.accent === 'amber' || (pct <= 20 && o.accent !== 'green')) {
      ring.classList.add('amber');
    }
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = '66';
    void ring.getBoundingClientRect();
    ring.style.transition = '';
    battTxt.textContent = '0%';
    // ring fills + the number counts up once the island has opened
    setTimeout(() => { ring.style.strokeDashoffset = String(66 * (1 - pct / 100)); }, 60);
    const t0 = performance.now() + 380;
    const tick = (t) => {
      const k = Math.min(1, Math.max(0, (t - t0) / 900));
      battTxt.textContent = Math.round(pct * (1 - Math.pow(1 - k, 3))) + '%';
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  hud.classList.remove('hidden');
  // 1) window big enough, 2) old content blurs away, 3) island springs open
  tryInvoke('resize_island', { width: 256, height: 56 });  // a bit wider than the 220px HUD so the spring overshoot is never clipped
  island.classList.add('hud-pre');
  btHudStartT = setTimeout(() => {
    island.classList.remove('hud-pre');
    island.classList.add('bt-hud-active');
  }, 110);

  btHudTimer = setTimeout(() => {
    island.classList.add('hud-out');
    btHudBackT = setTimeout(() => {
      island.classList.remove('bt-hud-active', 'hud-out');
      island.classList.add('hud-back');
      setTimeout(() => {
        hud.classList.add('hidden');
        island.classList.remove('hud-back');
        hudRestoreWindow();
        renderCenter(); updateClocks(); refreshMedia();
      }, 560);
    }, 170);
  }, o.ms || 3200);
}

function showBtConnectHud(name, kind, battPct) {
  const isBuds = kind === 'headphones' && /airpod|buds|earbud|earphone|airdope|tws|pods|wf-/i.test(name || '');
  showDeviceHud({
    iconHTML: isBuds ? BUDS_SVG : (DEV_ICONS[kind] || DEV_ICONS.bt),
    plain: !isBuds,
    name: name || 'Device',
    tag: 'Connected',
    pct: battPct,
  });
}

async function checkNewBtConnections() {
  try {
    const devs = await invokeTauri('get_bt_devices');
    if (!Array.isArray(devs)) return;
    const connected = devs.filter((d) => d && d.connected);
    if (prevConnectedBtDevs === null) {
      prevConnectedBtDevs = new Set(connected.map((d) => d.name));
      return;
    }
    const newly = connected.find((d) => !prevConnectedBtDevs.has(d.name));
    prevConnectedBtDevs = new Set(connected.map((d) => d.name));
    if (newly) {
      let pct = btBatteryFor(newly.name);
      if (pct == null) {
        try { pct = await invokeTauri('get_bt_battery', { name: newly.name }); } catch (_) {}
      }
      showBtConnectHud(newly.name, newly.kind, pct);
    }
  } catch (_) {}
}
setTimeout(checkNewBtConnections, 2000);

onTauriEvent('bluetooth-changed', () => {
  clearTimeout(btEvT);
  btEvT = setTimeout(() => {
    refreshBtCaption();
    checkNewBtConnections();
    if (appState.currentView === 'view-bt') loadBtList(true);
  }, 400);
});
onTauriEvent('bluetooth-nearby', () => { clearTimeout(btNearT); btNearT = setTimeout(renderBtNearby, 500); });
onTauriEvent('bt-pairing', (e) => showBtPrompt(e && e.payload));

document.getElementById('tile-bt').addEventListener('click', (e) => {
  if (e.target.closest('.chev')) return openBtView();
  toggleRadio('bt', !appState.btRadio);
});
document.getElementById('tile-bt').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openBtView();
});
document.getElementById('btn-refresh-bt').addEventListener('click', () => { invokeTauri('bt_discovery', { on: true }); loadBtList(); });
document.getElementById('btn-more-bt').addEventListener('click', () => invokeTauri('open_bt_settings'));

document.getElementById('tile-p2p')?.addEventListener('click', () => {
  switchView('view-p2p', 'state-sub', 316, 248);
});
document.getElementById('tile-drop')?.addEventListener('click', () => {
  if (typeof toggleInexDrop === 'function') toggleInexDrop();
  else switchView('view-p2p', 'state-sub', 316, 248);
});
document.getElementById('tile-tray').addEventListener('click', openTrayView);

document.querySelectorAll('.back-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchView('view-control', 'state-control', 316, 292);
  });
});

function applyRadio(kind, on) {
  if (kind === 'wifi') {
    appState.wifiRadio = on;
    document.getElementById('tile-wifi').classList.toggle('active', on);
    if (!on) document.getElementById('wifi-sub').textContent = 'Off';
    document.getElementById('wifi-master-toggle').checked = on;
  } else {
    appState.btRadio = on;
    document.getElementById('tile-bt').classList.toggle('active', on);
    document.getElementById('bt-sub').textContent = on ? 'On' : 'Off';
    document.getElementById('bt-master-toggle').checked = on;
  }
}

async function toggleRadio(kind, on) {
  applyRadio(kind, on);
  try {
    await invokeTauri('set_radio_state', { kind, on });
  } catch (err) {
    console.warn('radio toggle failed', err);
  }
  const real = await invokeTauri('get_radio_state', { kind });
  if (typeof real === 'boolean') applyRadio(kind, real);
  if (kind === 'wifi' && appState.currentView === 'view-wifi') setTimeout(loadWifiList, on ? 2000 : 0);
}

document.getElementById('wifi-master-toggle').addEventListener('change', (e) => toggleRadio('wifi', e.target.checked));
document.getElementById('bt-master-toggle').addEventListener('change', async (e) => {
  await toggleRadio('bt', e.target.checked);
  if (appState.currentView === 'view-bt') setTimeout(loadBtList, e.target.checked ? 1500 : 0);
});

// 5. Dynamic Quick Action Row
const ACTION_TILE_ICONS = {
  awake: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  snip: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  timer: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><line x1="9" y1="2" x2="15" y2="2"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83 2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  alarm: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  calc: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M8 18h.01M12 18h.01"/></svg>',
  taskmgr: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  explorer: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  restart: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  notepad: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8z"/><path d="M15 3v5h5"/><path d="M8 13h8M8 17h5"/></svg>',
  drop: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M12 2v10M8 8l4-4 4 4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>'
};

const ACTION_TILE_TITLES = {
  awake: 'Keep screen awake: off',
  snip: 'Screenshot Snip',
  calendar: 'Monthly Calendar',
  timer: 'Focus Timer',
  clipboard: 'Clipboard History',
  lock: 'Lock PC',
  settings: 'Open Settings',
  alarm: 'Alarm',
  calc: 'Calculator',
  taskmgr: 'Task Manager',
  terminal: 'Terminal / Command Prompt',
  explorer: 'File Explorer',
  restart: 'Restart Inex Island',
  notepad: 'Quick Notes',
  drop: 'Inex Drop'
};

let awakeState = false;

function renderQuickActionTiles() {
  const row = document.getElementById('quick-icons-row');
  if (!row) return;
  const list = (SET.menu && Array.isArray(SET.menu.actionTiles) && SET.menu.actionTiles.length)
    ? SET.menu.actionTiles
    : ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings'];

  row.innerHTML = '';
  list.forEach((id) => {
    const ico = ACTION_TILE_ICONS[id];
    const title = ACTION_TILE_TITLES[id] || id;
    if (!ico) return;

    const btn = document.createElement('button');
    btn.className = 'q-icon-btn';
    btn.id = `act-${id}`;
    btn.title = title;
    btn.innerHTML = ico;

    if (id === 'awake') {
      btn.classList.toggle('active', awakeState);
      btn.title = awakeState ? 'Keep screen awake: ON' : 'Keep screen awake: off';
      btn.addEventListener('click', async () => {
        const want = !awakeState;
        const on = await invokeTauri('set_keep_awake', { on: want });
        awakeState = on === true;
        btn.classList.toggle('active', awakeState);
        btn.title = awakeState ? 'Keep screen awake: ON' : 'Keep screen awake: off';
      });
    } else if (id === 'snip') {
      btn.addEventListener('click', () => {
        goCompact();
        invokeTauri('take_snip');
      });
    } else if (id === 'calendar') {
      btn.addEventListener('click', () => {
        switchView('view-calendar', 'state-sub', 316, 225);
        if (typeof renderCalendarGrid === 'function') renderCalendarGrid();
      });
    } else if (id === 'timer') {
      btn.addEventListener('click', () => {
        switchView('view-timer', 'state-sub', 316, 200);
      });
    } else if (id === 'alarm') {
      btn.addEventListener('click', () => {
        switchView('view-alarm', 'state-sub', 316, 238);
        if (typeof openAlarmView === 'function') openAlarmView();
      });
    } else if (id === 'clipboard') {
      btn.addEventListener('click', () => {
        switchView('view-clipboard', 'state-sub', 320, 260);
        if (typeof openClipboardView === 'function') openClipboardView();
      });
    } else if (id === 'lock') {
      btn.addEventListener('click', () => invokeTauri('lock_screen'));
    } else if (id === 'settings') {
      btn.addEventListener('click', () => invokeTauri('open_settings'));
    } else if (id === 'restart') {
      btn.addEventListener('click', () => invokeTauri('restart_app'));
    } else if (id === 'notepad') {
      btn.addEventListener('click', () => {
        switchView('view-notepad', 'state-sub', 316, 240);
        if (typeof focusNotepad === 'function') focusNotepad();
      });
    } else if (id === 'drop') {
      btn.addEventListener('click', () => {
        if (typeof openDropView === 'function') openDropView();
      });
    } else {
      btn.addEventListener('click', () => {
        invokeTauri('launch_quick_action', { id });
      });
    }

    row.appendChild(btn);
  });
}

// 6. Volume & Brightness Sliders
function setVolumeUI(level) {
  document.getElementById('val-vol').textContent = `${level}%`;
  document.getElementById('slider-vol').value = level;
  document.getElementById('m-vol-slider').value = level;
  appState.lastVolume = level;
}
function handleVolumeChange(newVal) {
  const level = parseInt(newVal, 10);
  setVolumeUI(level);
  invokeTauri('set_system_volume', { level });
}
document.getElementById('m-vol-toggle').addEventListener('click', () => {
  appState.volOpen = !appState.volOpen;
  island.classList.toggle('vol-open', appState.volOpen);
  document.getElementById('m-vol-toggle').classList.toggle('muted-ico', !appState.volOpen);
  invokeTauri('resize_island', { width: 316, height: appState.volOpen ? MEDIA_H_VOL : MEDIA_H });
});
document.getElementById('m-bt-btn').addEventListener('click', () => openAudioView());
invokeTauri('get_system_volume').then((v) => { if (typeof v === 'number') setVolumeUI(v); });

document.getElementById('slider-vol').addEventListener('input', (e) => handleVolumeChange(e.target.value));
document.getElementById('m-vol-slider').addEventListener('input', (e) => handleVolumeChange(e.target.value));

document.getElementById('slider-bright').addEventListener('change', (e) => {
  const level = parseInt(e.target.value, 10);
  document.getElementById('val-bright').textContent = `${level}%`;
  invokeTauri('set_system_brightness', { level });
});
document.getElementById('slider-bright').addEventListener('input', (e) => {
  document.getElementById('val-bright').textContent = `${e.target.value}%`;
});
// Brightness follows Windows (Fn keys, quick settings, auto-brightness) through an event, no polling
function setBrightUI(level) {
  if (typeof level !== 'number') return;
  const s = document.getElementById('slider-bright');
  if (!s || s.dataset.drag === '1') return;
  s.value = level;
  document.getElementById('val-bright').textContent = `${level}%`;
}
document.getElementById('slider-bright').addEventListener('pointerdown', (e) => { e.target.dataset.drag = '1'; });
window.addEventListener('pointerup', () => { const s = document.getElementById('slider-bright'); if (s) s.dataset.drag = ''; });
onTauriEvent('brightness-changed', (e) => setBrightUI(e && e.payload));
invokeTauri('get_system_brightness').then(setBrightUI);
setTimeout(() => invokeTauri('get_system_brightness').then(setBrightUI), 5000);

// 7. Audio Output Switcher (Headphones / Speakers)
let lastAudioOrigin = 'view-media';

function openAudioView() {
  lastAudioOrigin = (appState.currentView === 'view-media') ? 'view-media' : 'view-control';
  switchView('view-audio', 'state-sub', 316, 215);
  loadAudioDeviceList();
}

document.getElementById('audio-back-btn')?.addEventListener('click', () => {
  if (lastAudioOrigin === 'view-media' && appState.mediaPlaying) {
    openMedia();
  } else {
    switchView('view-control', 'state-control', 316, 292);
  }
});

document.getElementById('btn-refresh-audio')?.addEventListener('click', () => loadAudioDeviceList(true));
document.getElementById('btn-more-audio')?.addEventListener('click', () => invokeTauri('open_sound_settings'));

async function loadAudioDeviceList(spin) {
  const listEl = document.getElementById('audio-device-list');
  const refBtn = document.getElementById('btn-refresh-audio');
  if (!listEl) return;
  if (spin && refBtn) refBtn.classList.add('spin');
  listEl.innerHTML = '<div class="empty-hint">Scanning audio outputs…</div>';

  try {
    const devices = await invokeTauri('get_audio_devices');
    if (spin && refBtn) setTimeout(() => refBtn.classList.remove('spin'), 400);

    if (!Array.isArray(devices) || devices.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">No audio outputs detected</div>';
      return;
    }

    listEl.innerHTML = '';
    devices.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'list-row-item' + (d.is_default ? ' on active-audio' : '');

      const lower = d.name.toLowerCase();
      let icoSvg = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      if (lower.includes('headphone') || lower.includes('buds') || lower.includes('airpod') || lower.includes('headset') || lower.includes('earphone')) {
        icoSvg = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
      }

      const ico = document.createElement('span');
      ico.className = 'dev-ico';
      ico.innerHTML = icoSvg;

      const text = document.createElement('div');
      text.className = 'row-text';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = d.name;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = d.is_default ? 'Active Output' : 'Tap to switch';
      text.append(name, sub);

      const statusBadge = document.createElement('div');
      statusBadge.className = 'audio-check-badge';
      statusBadge.innerHTML = d.is_default
        ? '<svg viewBox="0 0 24 24" width="13" height="13" stroke="#22c55e" stroke-width="2.5" fill="none"><polyline points="20 6 9 17 4 12"/></svg>'
        : '';

      row.append(ico, text, statusBadge);

      row.addEventListener('click', async () => {
        if (d.is_default) return;
        sub.textContent = 'Switching…';
        await invokeTauri('set_default_audio_device', { id: d.id });
        setTimeout(() => {
          if (appState.currentView === 'view-audio') loadAudioDeviceList();
        }, 200);
      });

      listEl.appendChild(row);
    });
  } catch (err) {
    if (spin && refBtn) refBtn.classList.remove('spin');
    listEl.innerHTML = '<div class="empty-hint">Failed to load audio devices</div>';
  }
}

// 7. File Drag & Drop -> Tray (native Tauri drop: real file paths, no copy, no RAM use)
let trayIdSeq = 1;

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Files dropped from Explorer: Tauri's native drop hands over the REAL path. Nothing is copied,
// nothing is read into RAM or the clipboard; the tray only remembers {path, name, size}.
// Dragging out and P2P sending both read straight from that original location.
async function addDroppedPaths(paths) {
  const metas = (await tryInvoke('file_info', { paths })) || [];
  let added = 0;
  for (const m of metas) {
    if (appState.trayFiles.some((t) => t.path === m.path)) continue;
    appState.trayFiles.push({ id: trayIdSeq++, name: m.name, size: m.size, path: m.path });
    added++;
  }
  if (!added && !metas.length) { goCompact(); return; } // folders / unreadable items are skipped
  updateTrayUI();
  openTrayView();
}

let dropLeaveTimeout = null;

function onNativeDrop(p) {
  if (!p) return;
  if (p.type === 'enter' || p.type === 'over') {
    clearTimeout(dropLeaveTimeout);
    if (!appState.draggingOut && appState.currentView !== 'view-drop') {
      switchView('view-drop', 'state-drop', 200, 92);
    }
  } else if (p.type === 'leave') {
    clearTimeout(dropLeaveTimeout);
    dropLeaveTimeout = setTimeout(() => {
      if (!appState.draggingOut && appState.currentView === 'view-drop') {
        goCompact();
      }
    }, 200);
  } else if (p.type === 'drop') {
    clearTimeout(dropLeaveTimeout);
    if (appState.draggingOut) { appState.draggingOut = false; goCompact(); return; }
    if (p.paths && p.paths.length) addDroppedPaths(p.paths); else goCompact();
  }
}

(function bindNativeDrop() {
  // Hook native OLE drop target on main window and all WebView2 child windows
  const registerDrop = () => {
    invokeTauri('setup_shelf_drop').catch((e) => console.warn('[drop] setup_shelf_drop:', e));
  };
  registerDrop();
  setTimeout(registerDrop, 1000);
  setTimeout(registerDrop, 3000);

  // Native OLE shelf events from shelf.rs
  onTauriEvent('shelf-drag-enter', (e) => {
    const paths = e && e.payload && e.payload.paths;
    onNativeDrop({ type: 'enter', paths });
  });
  onTauriEvent('shelf-drag-leave', () => {
    onNativeDrop({ type: 'leave' });
  });
  onTauriEvent('shelf-drag-drop', (e) => {
    const paths = e && e.payload && e.payload.paths;
    onNativeDrop({ type: 'drop', paths });
  });

  // Tauri 2 standard drag-drop handler on webviewWindow / window / webview
  const bindTauriHandler = (w) => {
    if (!w || !w.onDragDropEvent) return false;
    try {
      const r = w.onDragDropEvent((e) => {
        const payload = e && e.payload;
        if (!payload) return;
        if (payload.type === 'enter' || payload.type === 'over') {
          onNativeDrop({ type: 'enter', paths: payload.paths });
        } else if (payload.type === 'leave') {
          onNativeDrop({ type: 'leave' });
        } else if (payload.type === 'drop') {
          onNativeDrop({ type: 'drop', paths: payload.paths });
        }
      });
      if (r && r.catch) r.catch(() => {});
      return true;
    } catch (_) { return false; }
  };

  const tw = window.__TAURI__;
  if (tw) {
    bindTauriHandler(tw.webviewWindow?.getCurrentWebviewWindow?.());
    bindTauriHandler(tw.window?.getCurrentWindow?.());
    bindTauriHandler(tw.webview?.getCurrentWebview?.());
  }

  // Plain Tauri events fallback
  onTauriEvent('tauri://drag-enter', (e) => onNativeDrop({ type: 'enter', paths: e?.payload?.paths }));
  onTauriEvent('tauri://drag-over', (e) => onNativeDrop({ type: 'over', paths: e?.payload?.paths }));
  onTauriEvent('tauri://drag-leave', () => onNativeDrop({ type: 'leave' }));
  onTauriEvent('tauri://drag-drop', (e) => onNativeDrop({ type: 'drop', paths: e?.payload?.paths }));

  // HTML5 drag/drop events on window
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    onNativeDrop({ type: 'enter' });
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    onNativeDrop({ type: 'over' });
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) onNativeDrop({ type: 'leave' });
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [];
    if (e.dataTransfer && e.dataTransfer.files) {
      for (const f of e.dataTransfer.files) {
        if (f.path) paths.push(f.path);
      }
    }
    if (paths.length) onNativeDrop({ type: 'drop', paths });
  });
})();

function openTrayView() {
  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  if (appState.traySelectedIds.size === 0 && appState.trayFiles.length > 0) {
    appState.trayFiles.forEach((f) => appState.traySelectedIds.add(f.id));
  }
  appState.traySelect = null;
  island.classList.remove('picker-open');
  document.getElementById('tray-peer-picker').classList.add('hidden');
  updateTrayUI();
  switchView('view-tray', 'state-tray', 316, 218);
}

// Drag a tray card out of the island (to Desktop / Explorer / Discord ...) with a native file drag
async function startDragOut(f) {
  appState.draggingOut = true;
  try {
    if (f.path) await invokeTauri('drag_out_file', { path: f.path }); // the original file, no copy
  } catch (_) {}
  setTimeout(() => { appState.draggingOut = false; }, 400);
}

function updateTrayUI() {
  const count = appState.trayFiles.length;
  document.getElementById('c-tray-count').textContent = count;
  document.getElementById('tray-total-badge').textContent = count;
  document.getElementById('tile-tray-sub').textContent = `${count} File${count === 1 ? '' : 's'}`;
  document.getElementById('tray-cap').textContent = count > 0 ? `${count} file${count > 1 ? 's' : ''}` : '';
  document.getElementById('tile-tray').classList.toggle('active', count > 0);
  document.getElementById('c-tray-btn').classList.toggle('hidden', count === 0);
  updateCompactStateClasses();

  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  // Clean up IDs of files that were removed
  const existingIds = new Set(appState.trayFiles.map((f) => f.id));
  for (const id of Array.from(appState.traySelectedIds)) {
    if (!existingIds.has(id)) appState.traySelectedIds.delete(id);
  }
  if (appState.traySelectedIds.size === 0 && count > 0) {
    appState.trayFiles.forEach((f) => appState.traySelectedIds.add(f.id));
  }

  const sel = appState.traySelect;
  const list = document.getElementById('tray-files-list');
  list.innerHTML = '';
  if (count === 0) {
    list.innerHTML = `<div class="empty-hint" style="width:100%;">Drop files onto Island to add</div>`;
    return;
  }

  appState.trayFiles.forEach((f) => {
    const isPicked = appState.traySelectedIds.has(f.id);
    const card = document.createElement('div');
    card.className = 'tray-file-card' + (isPicked ? ' sel' : '');
    card.title = `${f.name} (Click to ${isPicked ? 'deselect' : 'select'})`;
    card.innerHTML = `
      <span class="f-check">✓</span>
      <button class="f-del" title="Remove file">×</button>
      <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
      <div class="f-name">${escHtml(f.name)}</div>
    `;
    card.querySelector('.f-del').addEventListener('click', (e) => {
      e.stopPropagation();
      appState.trayFiles = appState.trayFiles.filter((t) => t.id !== f.id);
      appState.traySelectedIds.delete(f.id);
      if (sel) sel.picked.delete(f.id);
      updateTrayUI();
      if (appState.currentView === 'view-tray' && !document.getElementById('tray-peer-picker').classList.contains('hidden')) {
        renderPeerPicker();
      }
    });

    // press + move = drag the file out; click = toggle selection for sending
    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.f-del')) return;
      const sx = e.clientX, sy = e.clientY;
      let dragged = false;
      const cleanup = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      const move = (ev) => {
        if (dragged) return;
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) {
          dragged = true;
          cleanup();
          startDragOut(f);
        }
      };
      const up = () => {
        cleanup();
        if (!dragged) {
          // Toggle selection
          if (appState.traySelectedIds.has(f.id)) {
            appState.traySelectedIds.delete(f.id);
          } else {
            appState.traySelectedIds.add(f.id);
          }
          const nowPicked = appState.traySelectedIds.has(f.id);
          card.classList.toggle('sel', nowPicked);
          card.title = `${f.name} (Click to ${nowPicked ? 'deselect' : 'select'})`;
          if (appState.traySelect) {
            if (nowPicked) appState.traySelect.picked.add(f.id);
            else appState.traySelect.picked.delete(f.id);
          }
          renderPeerPicker();
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    list.appendChild(card);
  });
}

// Mouse wheel scrolls the tray sideways, so every file can be reached
const scrollTrayList = (e) => {
  const l = document.getElementById('tray-files-list');
  if (!l || l.scrollWidth <= l.clientWidth) return;
  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  l.scrollLeft += (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) * Math.abs(delta);
  e.preventDefault();
};
document.getElementById('tray-files-list').addEventListener('wheel', scrollTrayList, { passive: false });
document.getElementById('view-tray').addEventListener('wheel', (e) => {
  if (e.target.closest('#tray-peer-picker') || e.target.closest('.tray-share-actions')) return;
  scrollTrayList(e);
}, { passive: false });

document.getElementById('btn-clear-tray').addEventListener('click', () => {
  appState.trayFiles = [];
  appState.traySelect = null;
  if (appState.traySelectedIds) appState.traySelectedIds.clear();
  document.getElementById('tray-peer-picker').classList.add('hidden');
  updateTrayUI();
});

document.getElementById('btn-tray-quickshare').addEventListener('click', async () => {
  goCompact();
  await invokeTauri('launch_quick_share');
});

function makeChip(text, onClick) {
  const chip = document.createElement('button');
  chip.className = 'peer-chip';
  chip.textContent = text;
  chip.addEventListener('click', onClick);
  return chip;
}

function renderPeerPicker() {
  const picker = document.getElementById('tray-peer-picker');
  const label = picker.querySelector('small');
  const box = document.getElementById('tray-peer-buttons');
  box.innerHTML = '';
  
  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  const selectedCount = appState.traySelectedIds.size;
  label.textContent = `Send ${selectedCount || appState.trayFiles.length} file${(selectedCount || appState.trayFiles.length) === 1 ? '' : 's'} to:`;

  if (appState.peers.length === 0) {
    box.appendChild(makeChip('Connect device in P2P...', () => {
      island.classList.remove('picker-open');
      picker.classList.add('hidden');
      switchView('view-p2p', 'state-sub', 316, 208);
    }));
  } else {
    // If more than 1 peer is connected, add a "Send to All" option
    if (appState.peers.length > 1) {
      box.appendChild(makeChip(`🌐 Send to All (${appState.peers.length})`, () => {
        let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds.has(f.id));
        if (toSend.length === 0 && appState.trayFiles.length > 0) toSend = [...appState.trayFiles];
        if (toSend.length > 0) {
          island.classList.remove('picker-open');
          picker.classList.add('hidden');
          appState.peers.forEach((p) => offerFilesToPeer(p.id, toSend));
          goCompact();
          updateTrayUI();
        }
      }));
    }
    appState.peers.forEach((peer) => {
      box.appendChild(makeChip(`🖥️ ${peer.name}`, () => {
        let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds.has(f.id));
        if (toSend.length === 0 && appState.trayFiles.length > 0) {
          toSend = [...appState.trayFiles];
        }
        if (toSend.length > 0) {
          island.classList.remove('picker-open');
          picker.classList.add('hidden');
          sendTrayFiles(peer.id, toSend);
        }
      }));
    });
  }
  picker.classList.remove('hidden');
}

document.getElementById('btn-tray-p2p').addEventListener('click', () => {
  let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds && appState.traySelectedIds.has(f.id));
  if (toSend.length === 0 && appState.trayFiles.length > 0) {
    toSend = [...appState.trayFiles];
  }
  if (toSend.length === 0) {
    showToast('info', 'Drop files into tray first');
    return;
  }
  const picker = document.getElementById('tray-peer-picker');
  if (picker && !picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    island.classList.remove('picker-open');
    invokeTauri('resize_island', { width: 316, height: 218 });
    return;
  }
  appState.traySelect = null;
  renderPeerPicker();
  island.classList.add('picker-open');
  invokeTauri('resize_island', { width: 316, height: 252 });
});

function sendTrayFiles(peerId, files) {
  appState.traySelect = null;
  goCompact();
  offerFilesToPeer(peerId, files);
  updateTrayUI();
}


// ==================== 8. WEBRTC P2P (FIREBASE FOR HANDSHAKE ONLY, 5-MIN CODE TTL, MAX 5 PEERS) ====================
let p2pTimerInterval = null;

function updateP2PExpiryUI() {
  const timerEl = document.getElementById('p2p-expiry-timer');
  if (!timerEl) return;
  if (!appState.isCodeHost || !appState.roomCode || !appState.roomExpiresAt || appState.roomExpiresAt <= Date.now() || appState.peers.length > 0) {
    timerEl.classList.add('hidden');
    if (p2pTimerInterval) {
      clearInterval(p2pTimerInterval);
      p2pTimerInterval = null;
    }
    return;
  }
  const remSec = Math.max(0, Math.floor((appState.roomExpiresAt - Date.now()) / 1000));
  const m = Math.floor(remSec / 60);
  const s = String(remSec % 60).padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
  timerEl.classList.remove('hidden');
}

document.getElementById('btn-open-p2p-settings')?.addEventListener('click', () => {
  invokeTauri('open_settings');
});

document.getElementById('btn-gen-code')?.addEventListener('click', async () => {
  appState.isCodeHost = true;
  appState.manuallyDisconnected.clear();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  document.getElementById('btn-gen-code')?.classList.add('hidden');
  document.getElementById('p2p-join-box')?.classList.add('hidden');
  const badge = document.getElementById('code-display-box');
  badge?.classList.remove('hidden');
  document.getElementById('my-p2p-code').textContent = code;
  document.getElementById('btn-exit-room')?.classList.remove('hidden');
  await startFirebaseSignalingRoom(code, true);
});

document.getElementById('code-display-box')?.addEventListener('click', () => {
  const code = document.getElementById('my-p2p-code')?.textContent;
  if (code && code !== '------') {
    navigator.clipboard?.writeText(code);
    showToast('unlock', 'Code copied to clipboard!', 1500);
  }
});

const handleP2PJoin = async () => {
  const code = document.getElementById('input-peer-code')?.value.trim();
  if (!code || code.length < 4) {
    showToast('lock', 'Enter valid 6-digit code', 1800);
    return;
  }
  appState.isCodeHost = false;
  appState.manuallyDisconnected.clear();
  document.getElementById('btn-gen-code')?.classList.add('hidden');
  document.getElementById('p2p-join-box')?.classList.add('hidden');
  document.getElementById('btn-exit-room')?.classList.remove('hidden');
  await startFirebaseSignalingRoom(code, false);
};

document.getElementById('btn-join-code')?.addEventListener('click', handleP2PJoin);
document.getElementById('input-peer-code')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleP2PJoin();
});

document.getElementById('btn-exit-room')?.addEventListener('click', () => {
  exitP2PRoom(true);
});

async function exitP2PRoom(isManual = true) {
  const code = appState.roomCode;
  const wasHost = appState.isCodeHost;

  // 1. Notify connected peers
  if (wasHost && isManual) {
    for (const entry of rtcPeers.values()) {
      try {
        if (entry.dc && entry.dc.readyState === 'open') {
          entry.dc.send(JSON.stringify({ type: 'room_closed' }));
        }
      } catch (_) {}
    }
    if (code) {
      try {
        await fetch(`${getFirebaseUrl()}/rooms/${code}.json`, { method: 'DELETE' });
      } catch (_) {}
    }
  } else if (!wasHost && isManual) {
    for (const entry of rtcPeers.values()) {
      try {
        if (entry.dc && entry.dc.readyState === 'open') {
          entry.dc.send(JSON.stringify({ type: 'bye', peerId: myPeerId }));
        }
      } catch (_) {}
    }
    if (code) {
      try {
        await fetch(`${getFirebaseUrl()}/rooms/${code}/peers/${myPeerId}.json`, { method: 'DELETE' });
        await fetch(`${getFirebaseUrl()}/rooms/${code}/signals/${myPeerId}.json`, { method: 'DELETE' });
      } catch (_) {}
    }
  }

  // 2. Disconnect all peers cleanly
  for (const id of Array.from(rtcPeers.keys())) {
    cleanupPeer(id);
  }
  if (typeof broadcastDirectState === 'function') {
    broadcastDirectState({ phase: 'standby' });
  }

  // 3. Clear timers
  if (appState.pollSignalTimer) {
    clearInterval(appState.pollSignalTimer);
    appState.pollSignalTimer = null;
  }
  if (appState.roomExpiryTimer) {
    clearTimeout(appState.roomExpiryTimer);
    appState.roomExpiryTimer = null;
  }
  if (p2pTimerInterval) {
    clearInterval(p2pTimerInterval);
    p2pTimerInterval = null;
  }

  // 4. Reset state
  appState.roomCode = null;
  appState.roomExpiresAt = 0;
  appState.isCodeHost = false;
  appState.peers = [];
  appState.manuallyDisconnected.clear();

  // 5. Reset UI
  document.getElementById('code-display-box')?.classList.add('hidden');
  document.getElementById('btn-gen-code')?.classList.remove('hidden');
  document.getElementById('p2p-join-box')?.classList.remove('hidden');
  document.getElementById('btn-exit-room')?.classList.add('hidden');
  const timerEl = document.getElementById('p2p-expiry-timer');
  if (timerEl) timerEl.classList.add('hidden');
  const myCodeEl = document.getElementById('my-p2p-code');
  if (myCodeEl) myCodeEl.textContent = '------';
  const inputEl = document.getElementById('input-peer-code');
  if (inputEl) inputEl.value = '';
  document.getElementById('p2p-status-pill').textContent = 'Standby';

  renderPeersUI();
  updateTrayUI();

  if (isManual) {
    showToast('unlock', 'Left P2P Room', 1500);
  }
}

async function expireSignalingCode() {
  await exitP2PRoom(false);
}

async function startFirebaseSignalingRoom(code, isCreator) {
  const fbUrl = getFirebaseUrl();
  if (!fbUrl) {
    document.getElementById('p2p-status-pill').textContent = 'Set Firebase URL';
    showToast('lock', 'Set Firebase URL in Settings', 2500);
    return;
  }
  try {
    const res = await fetch(`${fbUrl}/rooms/${code}.json`);
    const room = await res.json();
    const now = Date.now();

    if (!isCreator) {
      if (!room || !room.createdAt || now - room.createdAt > CODE_TTL_MS) {
        document.getElementById('p2p-status-pill').textContent = 'Code Expired';
        return;
      }
    }

    const existingPeers = (room && room.peers) || {};
    const count = Object.keys(existingPeers).length;
    if (count >= 5 && !existingPeers[myPeerId]) {
      document.getElementById('p2p-status-pill').textContent = 'Full (5/5)';
      return;
    }

    const createdAt = isCreator ? now : (room.createdAt || now);
    appState.roomCode = code;
    appState.roomExpiresAt = createdAt + CODE_TTL_MS;

    if (isCreator) {
      await fetch(`${getFirebaseUrl()}/rooms/${code}/createdAt.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createdAt)
      });
    }

    await fetch(`${getFirebaseUrl()}/rooms/${code}/peers/${myPeerId}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: myPeerId, name: myDeviceName, joinedAt: now })
    });

    document.getElementById('p2p-status-pill').textContent = `Code ${code}`;

    updateP2PExpiryUI();
    if (p2pTimerInterval) clearInterval(p2pTimerInterval);
    p2pTimerInterval = setInterval(() => {
      updateP2PExpiryUI();
      if (Date.now() >= appState.roomExpiresAt) {
        expireSignalingCode();
      }
    }, 1000);

    if (appState.roomExpiryTimer) clearTimeout(appState.roomExpiryTimer);
    const remainingMs = Math.max(1000, appState.roomExpiresAt - Date.now());
    appState.roomExpiryTimer = setTimeout(expireSignalingCode, remainingMs);

    if (appState.pollSignalTimer) clearInterval(appState.pollSignalTimer);
    pollFirebaseSignaling();
    appState.pollSignalTimer = setInterval(pollFirebaseSignaling, 1200);
  } catch (err) {
    console.error('Signaling room error:', err);
  }
}

async function sendFirebaseSignal(targetPeerId, payload) {
  if (!appState.roomCode) return;
  try {
    await fetch(`${getFirebaseUrl()}/rooms/${appState.roomCode}/signals/${targetPeerId}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: myPeerId, fromName: myDeviceName, ...payload })
    });
  } catch (_) {}
}


async function pollFirebaseSignaling() {
  if (!appState.roomCode) return;
  if (Date.now() > appState.roomExpiresAt) {
    await expireSignalingCode();
    return;
  }
  if (appState.polling) return; // never run two polls at once (double-handled offers broke connections)
  appState.polling = true;

  try {
    const code = appState.roomCode;
    const res = await fetch(`${getFirebaseUrl()}/rooms/${code}.json`);
    const room = await res.json();
    if (!room || !room.createdAt) {
      if (!appState.isCodeHost && appState.roomCode) {
        showToast('lock', 'Room closed by host', 2000);
        await exitP2PRoom(false);
      }
      return;
    }
    if (!room.peers) return;

    // 1. Discover peers in room (up to 5) & initiate WebRTC handshake if lexicographically smaller
    const roomPeers = Object.values(room.peers).filter((p) => p && p.id !== myPeerId).slice(0, 5);
    for (const rp of roomPeers) {
      if (appState.manuallyDisconnected.has(rp.id)) continue;
      if (rtcPeers.has(rp.id) || !(myPeerId < rp.id)) continue;
      const last = appState.lastTry[rp.id] || 0;
      if (Date.now() - last < 8000) continue; // do not hammer a dead/stale peer
      appState.lastTry[rp.id] = Date.now();
      createPeerConnection(rp.id, rp.name, true);
    }

    // 2. Process incoming WebRTC SDP / ICE signals addressed to myPeerId
    const mine = room.signals && room.signals[myPeerId];
    if (mine) {
      const keys = Object.keys(mine).sort();
      // delete ONLY what we just read (deleting the whole node could erase ICE candidates that arrived meanwhile)
      await Promise.all(keys.map((k) =>
        fetch(`${getFirebaseUrl()}/rooms/${code}/signals/${myPeerId}/${k}.json`, { method: 'DELETE' }).catch(() => {})
      ));
      for (const k of keys) {
        const sig = mine[k];
        if (sig && sig.from) await handleIncomingSignal(sig);
      }
    }
  } catch (err) {
    console.warn('Signaling poll error:', err);
  } finally {
    appState.polling = false;
  }
}

function createPeerConnection(peerId, peerName, initiator) {
  if (appState.manuallyDisconnected.has(peerId)) return null;
  if (rtcPeers.has(peerId)) return rtcPeers.get(peerId);
  if (rtcPeers.size >= 5) return null;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const entry = {
    pc, dc: null, name: peerName || peerId,
    rx: Promise.resolve(), lastSeen: Date.now(),
    hb: null, graceTimer: null, connTimer: null, offerTimer: null,
    pendingIce: [], send: null, recv: null
  };
  rtcPeers.set(peerId, entry);

  // never stay half-connected forever
  entry.connTimer = setTimeout(() => {
    if (rtcPeers.get(peerId) === entry && !(entry.dc && entry.dc.readyState === 'open')) cleanupPeer(peerId);
  }, 30000);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendFirebaseSignal(peerId, { type: 'ice', candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    } else if (st === 'disconnected') {
      // short Wi-Fi blips recover by themselves; only give up after 5s
      if (!entry.graceTimer) {
        entry.graceTimer = setTimeout(() => {
          if (rtcPeers.get(peerId) === entry && pc.connectionState !== 'connected') cleanupPeer(peerId);
        }, 5000);
      }
    } else if (st === 'failed' || st === 'closed') {
      if (rtcPeers.get(peerId) === entry) cleanupPeer(peerId);
    }
  };

  if (initiator) {
    const dc = pc.createDataChannel('inex-p2p', { ordered: true });
    setupDataChannel(peerId, dc);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        sendFirebaseSignal(peerId, { type: 'offer', sdp: pc.localDescription });
      })
      .catch((e) => console.warn('Offer error', e));
  } else {
    pc.ondatachannel = (e) => setupDataChannel(peerId, e.channel);
  }

  return entry;
}

async function flushPendingIce(entry) {
  const list = entry.pendingIce.splice(0);
  for (const c of list) {
    try { await entry.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
  }
}

async function handleIncomingSignal(sig) {
  const peerId = sig.from;
  if (sig.type === 'room_closed') {
    showToast('lock', 'Room closed by host', 2200);
    exitP2PRoom(false);
    return;
  }
  if (sig.type === 'disconnect') {
    appState.manuallyDisconnected.add(peerId);
    cleanupPeer(peerId);
    return;
  }
  if (appState.manuallyDisconnected.has(peerId)) return;

  let entry = rtcPeers.get(peerId);
  if (!entry) {
    entry = createPeerConnection(peerId, sig.fromName, false);
  }
  if (!entry) return;
  if (sig.fromName) entry.name = sig.fromName;

  const { pc } = entry;
  try {
    if (sig.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
      await flushPendingIce(entry);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendFirebaseSignal(peerId, { type: 'answer', sdp: pc.localDescription });
    } else if (sig.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
      await flushPendingIce(entry);
    } else if (sig.type === 'ice' && sig.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
      else entry.pendingIce.push(sig.candidate); // candidate came before the offer/answer: keep it, do not lose it
    }
  } catch (e) {
    console.warn('WebRTC signal handle error:', e);
  }
}

function setupDataChannel(peerId, dc) {
  const entry = rtcPeers.get(peerId);
  if (!entry) return;
  entry.dc = dc;
  dc.binaryType = 'arraybuffer';

  dc.onopen = () => {
    entry.lastSeen = Date.now();
    clearTimeout(entry.connTimer);
    dc.send(JSON.stringify({ type: 'hello', name: myDeviceName }));
    // heartbeat: if the other PC vanishes (power off, app killed, Wi-Fi gone) we notice in ~9s
    entry.hb = setInterval(() => {
      if (dc.readyState !== 'open') return;
      if (Date.now() - entry.lastSeen > 9000) {
        cleanupPeer(peerId);
        return;
      }
      try { dc.send('{"type":"ping"}'); } catch (_) {}
    }, 2000);
    syncConnectedPeersList();
  };

  dc.onclose = () => {
    if (rtcPeers.get(peerId) === entry) cleanupPeer(peerId);
  };

  // every message (text and file bytes) goes through ONE ordered queue, so chunks can never be reordered
  dc.onmessage = (e) => {
    entry.lastSeen = Date.now();
    const data = e.data;
    entry.rx = entry.rx
      .then(() => onPeerData(peerId, entry, data))
      .catch((err) => console.warn('P2P rx error:', err));
  };
}

async function onPeerData(peerId, entry, data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    await handlePeerMessage(peerId, entry, msg);
  } else {
    await handleIncomingChunk(peerId, entry, data);
  }
}

function syncConnectedPeersList() {
  const list = [];
  for (const [id, entry] of rtcPeers.entries()) {
    if (entry.dc && entry.dc.readyState === 'open') {
      list.push({ id, name: entry.name || id });
    }
  }
  appState.peers = list.slice(0, 5);

  const sel = appState.traySelect;
  if (sel && !appState.peers.some((p) => p.id === sel.peerId)) {
    appState.traySelect = null;
    if (appState.currentView === 'view-tray') { updateTrayUI(); renderPeerPicker(); }
  }
  renderPeersUI();
}

// Forget everything about an in-flight transfer (partial file is deleted)
function dropTransferState(entry) {
  if (entry.send) {
    entry.send.cancelled = true;
    entry.send = null;
  }
  if (entry.recv) {
    if (entry.recv.cur) tryInvoke('recv_abort', { id: entry.recv.cur.id });
    entry.recv = null;
  }
}

function cleanupPeer(peerId) {
  const entry = rtcPeers.get(peerId);
  if (entry) {
    rtcPeers.delete(peerId);
    clearInterval(entry.hb);
    clearTimeout(entry.graceTimer);
    clearTimeout(entry.connTimer);
    clearTimeout(entry.offerTimer);
    dropTransferState(entry);
    try { if (entry.dc) { entry.dc.onclose = null; entry.dc.close(); } } catch (_) {}
    try { if (entry.pc) entry.pc.close(); } catch (_) {}
  }
  if (peerId === 'direct-peer' && typeof broadcastDirectState === 'function') {
    broadcastDirectState({ phase: 'standby' });
  }
  syncConnectedPeersList();
  refreshTransferUI();
}

function disconnectPeer(peerId) {
  appState.manuallyDisconnected.add(peerId);
  const entry = rtcPeers.get(peerId);
  if (entry && entry.dc && entry.dc.readyState === 'open') {
    try { entry.dc.send(JSON.stringify({ type: 'bye', peerId: myPeerId })); } catch (_) {}
  }
  if (appState.roomCode) {
    try {
      sendFirebaseSignal(peerId, { type: 'disconnect' });
    } catch (_) {}
  }
  cleanupPeer(peerId);
  showToast('unlock', 'Disconnected', 1400);
}

window.addEventListener('beforeunload', () => {
  for (const entry of rtcPeers.values()) {
    try { if (entry.dc && entry.dc.readyState === 'open') entry.dc.send('{"type":"bye"}'); } catch (_) {}
  }
});

// ==================== 8b. DIRECT SERVERLESS P2P (ZERO-SERVER CODE HANDSHAKE) ====================
// 1-on-1 direct link without Firebase. WebRTC handshake is done via compact copy-paste codes.

let directHostSession = null;
let directJoinSession = null;

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

function broadcastDirectState(state) {
  try {
    if (window.__TAURI__?.event?.emit) {
      window.__TAURI__.event.emit('direct-p2p-state', state);
    }
  } catch (_) {}
}

function getDirectP2PCurrentState() {
  const directPeer = rtcPeers.get('direct-peer');
  if (directPeer && directPeer.dc && directPeer.dc.readyState === 'open') {
    return { phase: 'connected', peerName: directPeer.name || 'Direct Partner' };
  }
  if (directHostSession && directHostSession.code) {
    return { phase: 'offer-ready', code: directHostSession.code, expiresAt: directHostSession.expiresAt };
  }
  if (directJoinSession && directJoinSession.replyCode) {
    return { phase: 'reply-ready', replyCode: directJoinSession.replyCode };
  }
  return { phase: 'standby' };
}

async function handleDirectGenOffer() {
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P Codec module not loaded.');

    if (directHostSession && directHostSession.pc) {
      try { directHostSession.pc.close(); } catch (_) {}
      directHostSession = null;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('inex-p2p', { ordered: true });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await waitCandidatesGathered(pc, 4500);

    const sdp = pc.localDescription.sdp;
    const info = C.parseSdp(sdp);
    const code = C.randomCode ? C.randomCode() : 'ABCDEFGH';
    const minutes = C.nowMinutes();
    const offerCode = C.encode({ type: 'offer', code, minutes, info });

    const expiresAt = Date.now() + 15 * 60 * 1000;
    directHostSession = { pc, dc, code: offerCode, expiresAt };

    broadcastDirectState({ phase: 'offer-ready', code: offerCode, expiresAt });
  } catch (err) {
    broadcastDirectState({ phase: 'error', message: err.message || 'Failed to create host code' });
  }
}

async function handleDirectAcceptReply(replyCode) {
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P Codec module not loaded.');
    if (!directHostSession || !directHostSession.pc) throw new Error('Host session not found. Generate a code first.');

    const dec = C.decode(replyCode);
    if (dec.type !== 'answer') throw new Error('This is not a valid reply code. Paste the reply code from your friend.');

    const sdp = C.toSdp(dec.info, 'answer');
    await directHostSession.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));

    const entry = {
      pc: directHostSession.pc,
      dc: directHostSession.dc,
      name: 'Direct Partner',
      rx: Promise.resolve(),
      lastSeen: Date.now(),
      hb: null, graceTimer: null, connTimer: null, offerTimer: null,
      pendingIce: [], send: null, recv: null,
      isDirect: true
    };
    rtcPeers.set('direct-peer', entry);
    setupDataChannel('direct-peer', directHostSession.dc);
    directHostSession.dc.addEventListener('open', () => {
      broadcastDirectState({ phase: 'connected', peerName: 'Direct Partner' });
    });
    directHostSession.dc.addEventListener('close', () => {
      broadcastDirectState({ phase: 'standby' });
    });

    broadcastDirectState({ phase: 'connecting' });
  } catch (err) {
    broadcastDirectState({ phase: 'error', message: err.message || 'Failed to accept reply code' });
  }
}

async function handleDirectJoinOffer(hostCode) {
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P Codec module not loaded.');

    if (directJoinSession && directJoinSession.pc) {
      try { directJoinSession.pc.close(); } catch (_) {}
      directJoinSession = null;
    }

    const dec = C.decode(hostCode);
    if (dec.type !== 'offer') throw new Error('This is not a host offer code.');

    const sdp = C.toSdp(dec.info, 'offer');
    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.ondatachannel = (e) => {
      const entry = {
        pc,
        dc: e.channel,
        name: 'Direct Host',
        rx: Promise.resolve(),
        lastSeen: Date.now(),
        hb: null, graceTimer: null, connTimer: null, offerTimer: null,
        pendingIce: [], send: null, recv: null,
        isDirect: true
      };
      rtcPeers.set('direct-peer', entry);
      setupDataChannel('direct-peer', e.channel);
      e.channel.addEventListener('open', () => {
        broadcastDirectState({ phase: 'connected', peerName: 'Direct Host' });
      });
      e.channel.addEventListener('close', () => {
        broadcastDirectState({ phase: 'standby' });
      });
    };

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await waitCandidatesGathered(pc, 4500);

    const answerInfo = C.parseSdp(pc.localDescription.sdp);
    const replyCode = C.encode({ type: 'answer', code: dec.code, info: answerInfo });

    directJoinSession = { pc, replyCode };
    broadcastDirectState({ phase: 'reply-ready', replyCode, hostCode });
  } catch (err) {
    broadcastDirectState({ phase: 'error', message: err.message || 'Failed to join host code' });
  }
}

function handleDirectDisconnect() {
  if (rtcPeers.has('direct-peer')) {
    cleanupPeer('direct-peer');
  }
  if (directHostSession) {
    try { directHostSession.pc?.close(); } catch (_) {}
    directHostSession = null;
  }
  if (directJoinSession) {
    try { directJoinSession.pc?.close(); } catch (_) {}
    directJoinSession = null;
  }
  broadcastDirectState({ phase: 'standby' });
}

onTauriEvent('direct-p2p-cmd', (e) => {
  const p = e.payload || {};
  if (p.action === 'gen-offer') handleDirectGenOffer();
  else if (p.action === 'accept-reply') handleDirectAcceptReply(p.replyCode);
  else if (p.action === 'join-offer') handleDirectJoinOffer(p.hostCode);
  else if (p.action === 'disconnect') handleDirectDisconnect();
  else if (p.action === 'clear-error') broadcastDirectState({ phase: 'standby' });
  else if (p.action === 'get-state') broadcastDirectState(getDirectP2PCurrentState());
});
// ======================================================================================
// Inex Drop: Native offline local file sharing between Phone and PC (Wi-Fi / Hotspot)
// ======================================================================================

let dropActive = false;
let dropConnected = false;
let dropCurrentUrl = '';

function openDropView() {
  switchView('view-p2p', 'state-sub', 316, 248);
  refreshDropUI();
}

async function refreshDropUI() {
  const status = await invokeTauri('get_inex_drop_status');
  if (!status) return;

  dropActive = !!status.running;
  dropConnected = !!status.connected;
  dropCurrentUrl = status.url || '';

  const tileDrop = document.getElementById('tile-drop');
  if (tileDrop) {
    tileDrop.classList.toggle('active', dropActive);
  }

  const subEl = document.getElementById('tile-drop-sub');
  if (subEl) {
    if (dropConnected) {
      subEl.textContent = status.device ? status.device : 'Connected';
    } else if (dropActive) {
      subEl.textContent = `Waiting (${status.remaining}s)`;
    } else {
      subEl.textContent = 'Off';
    }
  }

  const pill = document.getElementById('drop-status-pill');
  const cdBadge = document.getElementById('drop-countdown-badge');
  const btnDisc = document.getElementById('btn-drop-disconnect');
  const boxIdle = document.getElementById('drop-state-idle');
  const boxWait = document.getElementById('drop-state-waiting');
  const boxConn = document.getElementById('drop-state-connected');

  if (!dropActive) {
    if (pill) { pill.textContent = 'Off'; pill.className = 'status-tag'; }
    if (cdBadge) cdBadge.classList.add('hidden');
    if (btnDisc) btnDisc.classList.add('hidden');
    if (boxIdle) boxIdle.classList.remove('hidden');
    if (boxWait) boxWait.classList.add('hidden');
    if (boxConn) boxConn.classList.add('hidden');
    return;
  }

  if (dropConnected) {
    if (pill) { pill.textContent = 'Connected'; pill.className = 'status-tag ok'; }
    if (cdBadge) cdBadge.classList.add('hidden');
    if (btnDisc) btnDisc.classList.remove('hidden');
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxWait) boxWait.classList.add('hidden');
    if (boxConn) boxConn.classList.remove('hidden');

    const devName = document.getElementById('drop-dev-name');
    const devIp = document.getElementById('drop-dev-ip');
    if (devName) devName.textContent = status.device || 'Phone';
    if (devIp) devIp.textContent = `Connected • ${status.ip || 'Local Wi-Fi'}`;

    const trayCount = document.getElementById('drop-tray-count');
    if (trayCount) trayCount.textContent = (appState.trayFiles && appState.trayFiles.length) || 0;
  } else {
    // Waiting for scanner connection
    if (pill) { pill.textContent = 'Waiting...'; pill.className = 'status-tag warn'; }
    if (cdBadge) {
      cdBadge.classList.remove('hidden');
      const rem = status.remaining || 60;
      cdBadge.textContent = `00:${rem < 10 ? '0' : ''}${rem}`;
    }
    if (btnDisc) btnDisc.classList.add('hidden');
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxWait) boxWait.classList.remove('hidden');
    if (boxConn) boxConn.classList.add('hidden');

    renderDropQR(dropCurrentUrl);
    const urlTxt = document.getElementById('drop-url-text');
    if (urlTxt) urlTxt.textContent = dropCurrentUrl;
  }
}

function renderDropQR(url) {
  const container = document.getElementById('drop-qr-container');
  if (!container || !url) return;
  try {
    if (typeof qrcode === 'function') {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const svg = qr.createSvgTag({ scalable: true });
      container.innerHTML = svg;
    } else {
      container.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--dim);word-break:break-all;">${url}</div>`;
    }
  } catch (err) {
    console.error('QR error:', err);
    container.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--dim);">${url}</div>`;
  }
}

async function startInexDrop() {
  try {
    const res = await invokeTauri('start_inex_drop');
    if (res) {
      dropActive = true;
      dropConnected = false;
      dropCurrentUrl = res.url || '';
      refreshDropUI();
    }
  } catch (err) {
    showToast('lock', 'Could not start Inex Drop: ' + err);
  }
}

async function stopInexDrop() {
  try {
    await invokeTauri('stop_inex_drop');
    dropActive = false;
    dropConnected = false;
    refreshDropUI();
  } catch (_) {}
}

async function toggleInexDrop() {
  if (dropActive) {
    await stopInexDrop();
  } else {
    await startInexDrop();
    openDropView();
  }
}

// Bind Inex Drop Events from Rust
onTauriEvent('inexdrop-event', (event) => {
  let p = event.payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (_) {}
  }
  if (!p || typeof p !== 'object') return;

  if (p.type === 'tick') {
    const cdBadge = document.getElementById('drop-countdown-badge');
    if (cdBadge) {
      const rem = p.remaining || 0;
      cdBadge.textContent = `00:${rem < 10 ? '0' : ''}${rem}`;
    }
    const subEl = document.getElementById('tile-drop-sub');
    if (subEl && dropActive && !dropConnected) {
      subEl.textContent = `Waiting (${p.remaining}s)`;
    }
  } else if (p.type === 'timeout') {
    dropActive = false;
    dropConnected = false;
    showToast('unlock', 'Inex Drop timed out (Auto-closed)', 2200);
    refreshDropUI();
  } else if (p.type === 'connected') {
    dropActive = true;
    dropConnected = true;
    showToast('unlock', `Connected to ${p.device || 'Phone'}!`, 2000);
    refreshDropUI();
  } else if (p.type === 'disconnected') {
    dropConnected = false;
    showToast('unlock', 'Phone disconnected', 1800);
    refreshDropUI();
  } else if (p.type === 'stopped') {
    dropActive = false;
    dropConnected = false;
    const rxBox = document.getElementById('drop-rx-progress');
    if (rxBox) rxBox.classList.add('hidden');
    if (typeof finishCompactTransferUI === 'function') {
      finishCompactTransferUI();
    }
    refreshDropUI();
  } else if (p.type === 'upload_cancelled') {
    const rxBox = document.getElementById('drop-rx-progress');
    if (rxBox) rxBox.classList.add('hidden');
    if (typeof finishCompactTransferUI === 'function') {
      finishCompactTransferUI();
    }
    showToast('unlock', 'Transfer cancelled (Inex Drop turned off)', 2000);
  } else if (p.type === 'upload_start') {
    const rxBox = document.getElementById('drop-rx-progress');
    const rxName = document.getElementById('drop-rx-name');
    const rxPct = document.getElementById('drop-rx-pct');
    const rxBar = document.getElementById('drop-rx-bar');
    if (rxBox) rxBox.classList.remove('hidden');
    if (rxName) rxName.textContent = `Receiving ${p.name || 'File'}`;
    if (rxPct) rxPct.textContent = '0%';
    if (rxBar) rxBar.style.width = '0%';

    // Island compact transfer morph animation
    if (typeof startCompactTransferUI === 'function') {
      appState.xferDir = 'recv';
      startCompactTransferUI();
    }
  } else if (p.type === 'progress') {
    const rxPct = document.getElementById('drop-rx-pct');
    const rxBar = document.getElementById('drop-rx-bar');
    if (rxPct) rxPct.textContent = p.speed ? `${p.speed} • ${p.pct}%` : `${p.pct}%`;
    if (rxBar) rxBar.style.width = `${p.pct}%`;

    if (typeof updateCompactTransferPct === 'function') {
      updateCompactTransferPct(p.pct, p.speed);
    }
  } else if (p.type === 'upload_done') {
    const rxPct = document.getElementById('drop-rx-pct');
    const rxBar = document.getElementById('drop-rx-bar');
    const rxBox = document.getElementById('drop-rx-progress');
    if (rxPct) rxPct.textContent = p.speed ? `100% • ${p.speed}` : '100%';
    if (rxBar) rxBar.style.width = '100%';

    if (typeof finishCompactTransferUI === 'function') {
      finishCompactTransferUI();
    }

    const dlDoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
    if (typeof showDeviceHud === 'function') {
      showDeviceHud({
        iconHTML: dlDoneSvg,
        plain: true,
        accent: 'ok',
        name: p.name || 'File received',
        tag: p.speed ? `Saved to Downloads • ${p.speed}` : 'Saved to Downloads',
        ms: 3500
      });
    }

    setTimeout(() => {
      if (rxBox) rxBox.classList.add('hidden');
    }, 2500);
  }
});

// UI Event Listeners
function initInexDrop() {
  const tileDrop = document.getElementById('tile-drop');
  if (tileDrop) {
    tileDrop.addEventListener('click', (e) => {
      if (e.target.closest('.chev')) return openDropView();
      toggleInexDrop();
    });
    tileDrop.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openDropView();
    });
  }

  const btnStart = document.getElementById('btn-drop-start');
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      startInexDrop();
    });
  }

  const btnDisc = document.getElementById('btn-drop-disconnect');
  if (btnDisc) {
    btnDisc.addEventListener('click', () => {
      stopInexDrop();
    });
  }

  const btnCopy = document.getElementById('btn-copy-drop-url');
  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      if (dropCurrentUrl) {
        navigator.clipboard.writeText(dropCurrentUrl).then(() => {
          showToast('unlock', 'Link copied to clipboard!', 1400);
        });
      }
    });
  }

  const btnPush = document.getElementById('btn-drop-push');
  if (btnPush) {
    btnPush.addEventListener('click', async () => {
      if (!appState.trayFiles || appState.trayFiles.length === 0) {
        showToast('info', 'Drop files into Tray first');
        return;
      }
      for (const f of appState.trayFiles) {
        if (f.path) {
          await invokeTauri('stage_file_for_phone', { path: f.path });
        }
      }
      showToast('unlock', 'Files pushed to Phone!', 1800);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInexDrop);
} else {
  initInexDrop();
}
// ==================== P2P FILE TRANSFER (offer lives in P2P list, streamed to disk, no RAM blow-up) ====================
const CHUNK = 128 * 1024;           // one WebRTC message
const READ_BLOCK = 4 * 1024 * 1024; // read from disk in big blocks
const HIGH_WATER = 4 * 1024 * 1024; // pause sending above this
const LOW_WATER = 1024 * 1024;      // resume below this
const FLUSH_BYTES = 4 * 1024 * 1024; // receiver writes to disk in 4MB blocks

async function tryInvoke(cmd, args) {
  try { return await invokeTauri(cmd, args); } catch (e) { console.warn(cmd, e); return null; }
}

// Binary (raw) command call: file bytes go to Rust without base64
async function invokeRaw(cmd, bytes, headers) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return await window.__TAURI__.core.invoke(cmd, bytes, { headers });
  }
  return null;
}

function toArrayBuffer(b) {
  if (b instanceof ArrayBuffer) return b;
  if (ArrayBuffer.isView(b)) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  if (Array.isArray(b)) return new Uint8Array(b).buffer;
  return null;
}

function waitBuffered(dc, limit) {
  return new Promise((resolve) => {
    if (dc.readyState !== 'open' || dc.bufferedAmount <= limit) return resolve();
    dc.bufferedAmountLowThreshold = limit;
    let t = null;
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      clearInterval(t);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    t = setInterval(() => {
      if (dc.readyState !== 'open' || dc.bufferedAmount <= limit) done();
    }, 200);
  });
}

function offerFilesToPeer(peerId, files) {
  const entry = rtcPeers.get(peerId);
  if (!entry || !entry.dc || entry.dc.readyState !== 'open' || files.length === 0) return;
  if (entry.send || entry.recv) return; // this peer is busy

  entry.send = {
    files: [...files], accepted: false, active: false, cancelled: false, completed: false,
    sent: 0, total: files.reduce((a, f) => a + (f.size || 0), 0)
  };
  entry.dc.send(JSON.stringify({
    type: 'file-offer',
    files: files.map((f) => ({ name: f.name, size: f.size })),
    fromName: myDeviceName
  }));
  // nobody answered for 2 minutes -> withdraw the offer
  entry.offerTimer = setTimeout(() => {
    if (entry.send && !entry.send.active) abortTransfer(peerId, true);
  }, 120000);
  refreshTransferUI();
}

function acceptPeerFileOffer(peerId) {
  const entry = rtcPeers.get(peerId);
  const r = entry && entry.recv;
  if (!r || r.accepted || !entry.dc || entry.dc.readyState !== 'open') return;
  r.accepted = true;
  r.active = true;
  beginTransferStats(entry);
  entry.dc.send('{"type":"file-accept"}');
  refreshTransferUI();
}

function declinePeerFileOffer(peerId) {
  const entry = rtcPeers.get(peerId);
  if (entry && entry.dc && entry.dc.readyState === 'open') {
    try { entry.dc.send('{"type":"file-decline"}'); } catch (_) {}
  }
  if (entry) entry.recv = null;
  refreshTransferUI();
}

// Stop a transfer (either side) and tell the other PC
function abortTransfer(peerId, notify) {
  const entry = rtcPeers.get(peerId);
  if (entry) {
    if (notify && entry.dc && entry.dc.readyState === 'open') {
      try { entry.dc.send('{"type":"cancel"}'); } catch (_) {}
    }
    clearTimeout(entry.offerTimer);
    dropTransferState(entry);
  }
  refreshTransferUI();
}

function cancelAllActiveTransfers(notify = true) {
  let cancelledAny = false;
  for (const [peerId, entry] of rtcPeers.entries()) {
    if ((entry.send && entry.send.active) || (entry.recv && entry.recv.active)) {
      abortTransfer(peerId, notify);
      cancelledAny = true;
    }
  }
  if (cancelledAny) {
    showToast('unlock', 'Transfer cancelled', 1500);
  }
  refreshTransferUI();
}

document.getElementById('c-transfer-cancel-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  cancelAllActiveTransfers(true);
});

async function handlePeerMessage(peerId, entry, msg) {
  switch (msg.type) {
    case 'ping':
      return;
    case 'hello':
      if (msg.name) { entry.name = msg.name; syncConnectedPeersList(); }
      return;
    case 'bye':
      if (msg.peerId) appState.manuallyDisconnected.add(msg.peerId);
      appState.manuallyDisconnected.add(peerId);
      cleanupPeer(peerId);
      return;
    case 'room_closed':
      showToast('lock', 'Room closed by host', 2200);
      exitP2PRoom(false);
      return;
    case 'file-offer': {
      const files = Array.isArray(msg.files) ? msg.files.filter((f) => f && f.name).slice(0, 200) : [];
      if (files.length === 0) return;
      if (entry.recv || entry.send) {
        try { entry.dc.send('{"type":"file-decline"}'); } catch (_) {}
        return;
      }
      entry.recv = {
        files, fromName: msg.fromName || entry.name, accepted: false, active: false,
        total: files.reduce((a, f) => a + (Number(f.size) || 0), 0), got: 0, cur: null
      };
      refreshTransferUI(); // peer badge glows + row shows tick/cross (no notch popup)
      return;
    }
    case 'file-accept':
      if (entry.send && !entry.send.active) {
        clearTimeout(entry.offerTimer);
        entry.send.accepted = true;
        streamFiles(peerId);
      }
      return;
    case 'file-decline':
      if (entry.send && !entry.send.active) {
        clearTimeout(entry.offerTimer);
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
      const id = await tryInvoke('recv_begin', { fileName: String(msg.name || 'Shared_File') });
      if (entry.recv !== r) { if (id) tryInvoke('recv_abort', { id }); return; } // cancelled meanwhile
      if (!id) { abortTransfer(peerId, true); return; }
      r.cur = { id, buf: [], bufBytes: 0 };
      return;
    }
    case 'file-end': {
      const r = entry.recv;
      if (!r || !r.cur) return;
      const cur = r.cur;
      const ok = await flushCur(cur);
      if (entry.recv !== r) return;
      if (!ok) { abortTransfer(peerId, true); return; }
      r.cur = null;
      const saved = await tryInvoke('recv_end', { id: cur.id });
      if (!saved && entry.recv === r) abortTransfer(peerId, true);
      return;
    }
    case 'all-done':
      if (entry.recv && entry.recv.accepted) {
        entry.recv = null;
        refreshTransferUI();
      }
      return;
    default:
  }
}

async function flushCur(cur) {
  if (cur.bufBytes === 0) return true;
  const out = new Uint8Array(cur.bufBytes);
  let p = 0;
  for (const b of cur.buf) { out.set(b, p); p += b.byteLength; }
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

async function handleIncomingChunk(peerId, entry, ab) {
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

async function streamFiles(peerId) {
  const entry = rtcPeers.get(peerId);
  const s = entry && entry.send;
  if (!s || s.active || !entry.dc) return;
  const dc = entry.dc;
  s.active = true;
  beginTransferStats(entry);
  refreshTransferUI();

  let failed = false;
  try {
    for (const f of s.files) {
      if (s.cancelled || dc.readyState !== 'open') break;
      dc.send(JSON.stringify({ type: 'file-start', name: f.name, size: f.size }));
      let offset = 0;
      while (offset < f.size) {
        if (s.cancelled || dc.readyState !== 'open') break;
        const want = Math.min(READ_BLOCK, f.size - offset);
        let buf = null;
        try { buf = await invokeTauri('read_file_chunk', { path: f.path, offset, len: want }); } catch (_) {}
        if (!buf || buf.byteLength === 0) { failed = true; break; } // file moved/deleted/locked
        for (let p = 0; p < buf.byteLength; p += CHUNK) {
          if (s.cancelled || dc.readyState !== 'open') break;
          if (dc.bufferedAmount > HIGH_WATER) await waitBuffered(dc, LOW_WATER);
          dc.send(new Uint8Array(buf, p, Math.min(CHUNK, buf.byteLength - p)));
          s.sent += Math.min(CHUNK, buf.byteLength - p);
          noteProgress(Math.max(0, s.sent - dc.bufferedAmount), s.total);
          if (((p / CHUNK) & 3) === 0) {
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        offset += buf.byteLength;
      }
      if (failed || s.cancelled || dc.readyState !== 'open') break;
      dc.send('{"type":"file-end"}');
    }
    if (!failed && !s.cancelled && dc.readyState === 'open') {
      await waitBuffered(dc, 0); // wait until every byte really left this PC
      if (!s.cancelled && dc.readyState === 'open') {
        dc.send('{"type":"all-done"}');
        s.completed = true;
        noteProgress(s.total, s.total);   // ring reaches 100% so the notch can show "Sent"
      }
    }
  } catch (e) {
    console.warn('P2P send error:', e);
    failed = true;
  }

  if (entry.send !== s) return; // already cancelled / peer gone (state was reset)
  if (failed || !s.completed) {
    abortTransfer(peerId, true);
    return;
  }
  entry.send = null;
  appState.trayFiles = appState.trayFiles.filter((t) => !s.files.includes(t));
  updateTrayUI();
  refreshTransferUI();
}

// ---- speed / route (shown in the P2P status pill while sending/receiving) ----
async function getRouteLabel(pc) {
  try {
    const stats = await pc.getStats();
    const byId = {};
    let pairId = null;
    stats.forEach((r) => {
      byId[r.id] = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    let pair = pairId ? byId[pairId] : null;
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return '';
    const types = [byId[pair.localCandidateId], byId[pair.remoteCandidateId]].map((c) => c && c.candidateType);
    if (types.includes('relay')) return 'Relay';
    if (types.every((t) => t === 'host')) return 'LAN';
    return 'Internet';
  } catch (_) { return ''; }
}

function beginTransferStats(entry) {
  if (appState.xfer) return;
  const x = { bytes: 0, lastBytes: 0, lastT: Date.now(), route: '', speed: 0, pctT: 0, timer: null };
  appState.xfer = x;
  getRouteLabel(entry.pc).then((l) => { x.route = l; });
  x.timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - x.lastT) / 1000 || 1;
    x.speed = Math.max(0, (x.bytes - x.lastBytes) / dt / 1048576);
    x.lastBytes = x.bytes;
    x.lastT = now;
    document.getElementById('p2p-status-pill').textContent =
      `${x.route ? x.route + ' · ' : ''}${x.speed.toFixed(1)} MB/s`;
  }, 1000);
}

function endTransferStats() {
  if (appState.xfer) {
    clearInterval(appState.xfer.timer);
    appState.xfer = null;
  }
}

let lastReportedPct = -1;
function noteProgress(done, total) {
  const x = appState.xfer;
  if (!x) return;
  x.bytes = done;
  const now = Date.now();
  if (now - x.pctT < 120 && done < total) return;
  x.pctT = now;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
  if (pct !== lastReportedPct) {
    lastReportedPct = pct;
    updateCompactTransferPct(pct);
  }
}

function anyTransferActive() {
  for (const e of rtcPeers.values()) {
    if ((e.send && e.send.active) || (e.recv && e.recv.active)) return true;
  }
  return false;
}

function updateOfferGlow() {
  let pending = false;
  for (const e of rtcPeers.values()) if (e.recv && !e.recv.accepted) pending = true;
  document.getElementById('c-peer-badge').classList.toggle('offer', pending);
  document.getElementById('tile-p2p')?.classList.toggle('offer', pending);
  document.getElementById('tile-drop')?.classList.toggle('offer', pending);
}

function refreshStatusPill() {
  if (anyTransferActive()) return;
  const pill = document.getElementById('p2p-status-pill');
  if (appState.roomCode) pill.textContent = `Code ${appState.roomCode}`;
  else pill.textContent = appState.peers.length > 0 ? `${appState.peers.length} Connected` : 'Standby';
}

// One place that decides if the notch shows the transfer animation: only while data is really moving
function refreshTransferUI() {
  if (anyTransferActive()) {
    if (!appState.transferring) startCompactTransferUI();
  } else if (appState.transferring) {
    finishCompactTransferUI();
  }
  updateOfferGlow();
  renderPeersUI();
  refreshStatusPill();
}

function renderPeersUI() {
  updateP2PExpiryUI();
  const exitBtn = document.getElementById('btn-exit-room');
  if (exitBtn) {
    exitBtn.classList.toggle('hidden', !appState.roomCode && appState.peers.length === 0);
  }
  const count = appState.peers.length;
  const inRoomOrConnected = !!(appState.roomCode || count > 0);
  document.getElementById('btn-gen-code')?.classList.toggle('hidden', inRoomOrConnected);
  document.getElementById('p2p-join-box')?.classList.toggle('hidden', inRoomOrConnected);
  if (appState.isCodeHost && appState.roomCode) {
    document.getElementById('code-display-box')?.classList.remove('hidden');
  } else if (!inRoomOrConnected) {
    document.getElementById('code-display-box')?.classList.add('hidden');
  }
  document.getElementById('btn-open-p2p-settings')?.classList.toggle('hidden', count > 0);
  const listEl = document.getElementById('p2p-peers-list');
  const badge = document.getElementById('c-peer-badge');
  const countSpan = document.getElementById('c-peer-count');
  const tileP2P = document.getElementById('tile-p2p') || document.getElementById('tile-drop');

  const p2pSub = document.getElementById('tile-p2p-sub') || document.getElementById('tile-drop-sub');
  if (p2pSub && !dropActive) p2pSub.textContent = count > 0 ? (rtcPeers.has('direct-peer') ? 'Direct 1:1' : `${count}/5 Peers`) : 'Off';
  const p2pCap = document.getElementById('p2p-cap') || document.getElementById('drop-cap');
  if (p2pCap) p2pCap.textContent = count > 0 ? (rtcPeers.has('direct-peer') ? '1 direct peer' : `${count} peer${count > 1 ? 's' : ''}`) : '';
  if (tileP2P && !dropActive) tileP2P.classList.toggle('active', count > 0);

  if (count > 0) {
    badge.classList.remove('hidden');
    countSpan.textContent = count;
  } else {
    badge.classList.add('hidden');
  }
  updateCompactStateClasses();

  listEl.innerHTML = '';
  if (count === 0) {
    const msg = appState.roomCode
      ? `Waiting for peers to join code ${appState.roomCode} (5m valid)...`
      : 'Generate a code or enter partner code (Max 5 PCs)';
    listEl.innerHTML = `
      <div class="empty-hint">
        <div>${msg}</div>
        <button id="btn-open-p2p-settings" class="link-btn" style="margin-top:6px;font-size:10px;opacity:0.75;cursor:pointer;background:none;border:none;color:inherit;text-decoration:underline;">Or use Direct Offline P2P in Settings ↗</button>
      </div>`;
    document.getElementById('btn-open-p2p-settings')?.addEventListener('click', () => {
      invokeTauri('open_settings');
    });
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
    nameSpan.textContent = `🖥️ ${peer.name}`;
    row.appendChild(nameSpan);

    if (r && !r.accepted) {
      // incoming offer: tick / cross right next to the PC (only place where the offer is shown)
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
      actBox.querySelector('.accept').addEventListener('click', (e) => { e.stopPropagation(); acceptPeerFileOffer(peer.id); });
      actBox.querySelector('.decline').addEventListener('click', (e) => { e.stopPropagation(); declinePeerFileOffer(peer.id); });
      row.appendChild(actBox);
    } else if (r || s) {
      // sending / receiving / waiting for the other side: Cancel instead of Disconnect
      const cancel = document.createElement('small');
      cancel.style.color = '#f87171';
      cancel.textContent = s && !s.active ? 'Waiting… Cancel' : 'Cancel';
      cancel.addEventListener('click', (e) => { e.stopPropagation(); abortTransfer(peer.id, true); });
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
        let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds && appState.traySelectedIds.has(f.id));
        if (toSend.length === 0 && appState.trayFiles.length > 0) toSend = [...appState.trayFiles];
        if (toSend.length > 0) {
          sendTrayFiles(peer.id, toSend);
        } else {
          showToast('info', 'Drop files into tray first');
        }
      });

      const disc = document.createElement('small');
      disc.style.color = '#f87171';
      disc.style.cursor = 'pointer';
      disc.textContent = 'Disconnect';
      disc.addEventListener('click', (e) => { e.stopPropagation(); disconnectPeer(peer.id); });

      actionsWrap.append(sendBtn, disc);
      row.appendChild(actionsWrap);
    }

    listEl.appendChild(row);
  });
}

// Notch center: clock <-> transfer animation <-> Windows password-prompt animation
function renderCenter() {
  const toast = !!appState.toast;
  const isPrompt = !!(appState.prompting || appState.lockerPrompting);
  const busy = appState.transferring || isPrompt || toast;
  const xferLive = !!(appState.transferring && !isPrompt && !toast);
  island.classList.toggle('transferring', busy);
  island.classList.toggle('xfer-live', xferLive);
  document.getElementById('c-clock').classList.toggle('hidden', busy);
  document.getElementById('c-transfer-anim').classList.toggle('hidden', !xferLive);
  document.getElementById('c-prompt-anim').classList.toggle('hidden', !(isPrompt && !toast));
  document.getElementById('c-toast').classList.toggle('hidden', !toast);
  updateCompactStateClasses();
  if (typeof updateTimerChip === 'function') updateTimerChip();   // running timer stays visible next to a transfer / popup
}

// ---- Short status popups: charger, low battery, unlock ----
const SVG_A = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">';
const TOAST_ICONS = {
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
  mic: SVG_A + '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
};
function showToast(kind, text, ms) {
  const isXfer = appState.transferring;
  const duration = isXfer ? Math.min(ms || 1400, 1400) : (ms || 2200);
  const box = document.getElementById('c-toast');
  box.className = 'c-transfer-inline c-toast t-' + kind;
  document.getElementById('c-toast-ico').innerHTML = TOAST_ICONS[kind] || '';
  document.getElementById('c-toast-text').textContent = text;
  appState.toast = true;
  renderCenter();
  clearTimeout(appState.toastTimer);
  appState.toastTimer = setTimeout(() => {
    appState.toast = false;
    renderCenter();
    updateClocks();
    refreshMedia();
  }, duration);
  return true;
}

// ---- Biometric morph (Face ID / Touch ID style) ----
// pill -> drops down into a rounded square -> scan -> green tick -> back to pill
let bioTimer = null;
let bioAnimPhaseTimer = null;
let bioStartTimer = null;
let bioEndTimer = null;

const BIO_SVGS = {
  // generic scan (Windows unlock, password unlock in Locker Pro): viewfinder corners + sweeping line, no face features
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
  check: `<svg class="bio-check-svg" viewBox="0 0 44 44" width="44" height="44" fill="none">
    <circle class="fillc" cx="22" cy="22" r="17" fill="rgba(48,209,88,0.16)"/>
    <circle class="ring" cx="22" cy="22" r="17" stroke="#30d158" stroke-width="2.4" stroke-linecap="round" transform="rotate(-90 22 22)"/>
    <path class="tick" d="M14 22.5l6 6 11-12.5" stroke="#30d158" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
};

function triggerBiometricMorph(type, label) {
  if (appState.currentView !== 'view-compact' || appState.alarmActive) return;     // never fight an open menu
  const kind = (type === 'fingerprint') ? 'fingerprint' : 'scan';   // face is gone: everything except a real fingerprint is a plain scan
  const box = document.getElementById('c-biometric-box');
  const glyph = document.getElementById('bio-glyph-wrap');
  const txt = document.getElementById('bio-label');
  if (!box || !glyph || !txt) return;

  clearTimeout(bioTimer); clearTimeout(bioAnimPhaseTimer); clearTimeout(bioStartTimer); clearTimeout(bioEndTimer);
  // a device HUD may be open: close it instantly
  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT);
  island.classList.remove('bt-hud-active', 'hud-out', 'hud-back');
  island.classList.add('bio-hud');   // biometric flow keeps its original animation timings (see styles.css)
  document.getElementById('c-bt-hud').classList.add('hidden');

  txt.textContent = label ? String(label) : 'Unlocked';
  glyph.innerHTML = BIO_SVGS[kind];
  box.classList.remove('hidden');

  // 1) window big enough, 2) old content blurs away, 3) island springs into the rounded square
  tryInvoke('resize_island', { width: 265, height: 112 });
  island.classList.add('hud-pre');
  bioStartTimer = setTimeout(() => {
    island.classList.remove('hud-pre');
    island.classList.add('biometric-active');
  }, 130);

  // scan, then the glyph blurs out and the tick springs in
  bioAnimPhaseTimer = setTimeout(() => {
    const cur = glyph.firstElementChild;
    if (cur) cur.classList.add('bio-leave');
    setTimeout(() => { glyph.innerHTML = BIO_SVGS.check; }, 150);
  }, 1150);

  // fade content, shrink back to the pill, restore the normal window
  bioTimer = setTimeout(() => {
    island.classList.add('hud-out');
    bioEndTimer = setTimeout(() => {
      island.classList.remove('biometric-active', 'hud-out');
      island.classList.add('hud-back');
      setTimeout(() => {
        box.classList.add('hidden');
        glyph.innerHTML = '';
        island.classList.remove('hud-back', 'bio-hud');
        hudRestoreWindow();
        renderCenter(); updateClocks(); refreshMedia();
      }, 560);
    }, 170);
  }, 2350);
}

// Inex App Locker / Biometric Unlock Pipe Listener
let lockerWrongTimer = null;
let lockerGlowTimer = null;
let lockerPromptSafetyTimer = null;
let testTransferTimer = null;
let lastLockerTs = 0;
let lastLockToast = { target: '', at: 0 };
// The locker sends a `locker_prompt` heartbeat every ~3 s for as long as its popup is open.
// The island keeps the lock status for exactly that long: every heartbeat renews this lease, and it
// only runs out (8 s) if the locker disappeared without telling us (crash / killed process).
const LOCKER_LEASE_MS = 8000;
function armLockerLease() {
  clearTimeout(lockerPromptSafetyTimer);
  lockerPromptSafetyTimer = setTimeout(() => {
    if (appState.lockerPrompting) {
      appState.lockerPrompting = false;
      renderCenter();
      updateClocks();
      refreshMedia();
    }
  }, LOCKER_LEASE_MS);
}

onTauriEvent('locker-unlock', (event) => {
  let payload = event.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) {}
  }
  if (!payload || typeof payload !== 'object') payload = {};

  // Locker events carry a millisecond `ts`. Drop one that is older than an event we already handled
  // (out-of-order delivery); a big backwards jump (clock change / locker restart) is treated as a new session.
  const evTs = Number(payload.ts) || 0;
  if (evTs) {
    if (evTs < lastLockerTs && lastLockerTs - evTs < 60000) return;
    lastLockerTs = evTs;
  }

  const evName = payload.event || (payload.type ? 'locker_unlock' : '');

  if (evName === 'locker_prompt') {
    // heartbeat while the prompt is already showing: just renew the lease, no re-render
    // (a heartbeat that finds no open prompt is ignored, so a late keep-alive can never re-open the status)
    if (payload.hb) { if (appState.lockerPrompting) armLockerLease(); return; }
    // 1. Password prompt appears -> Island shows Locked with lock icon
    appState.lockerPrompting = true;
    island.classList.remove('island-locker-glow', 'island-locker-wrong');
    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.remove('prompt-wrong');
    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) icoEl.classList.remove('lock-shake');
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = payload.target ? payload.target : 'Locked';
    renderCenter();

    armLockerLease();
  }
  else if (evName === 'locker_wrong') {
    // 2. Wrong password -> Red border on island, notch lock icon shakes
    appState.lockerPrompting = true;
    island.classList.remove('island-locker-glow');
    island.classList.add('island-locker-wrong');

    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.add('prompt-wrong');

    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) {
      icoEl.classList.remove('lock-shake');
      void icoEl.offsetWidth; // force reflow
      icoEl.classList.add('lock-shake');
    }
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = 'Wrong Password';
    renderCenter();
    armLockerLease();

    clearTimeout(lockerWrongTimer);
    lockerWrongTimer = setTimeout(() => {
      island.classList.remove('island-locker-wrong');
      if (promptEl) promptEl.classList.remove('prompt-wrong');
      if (icoEl) icoEl.classList.remove('lock-shake');
      if (txtEl && appState.lockerPrompting) {
        txtEl.textContent = payload.target ? payload.target : 'Locked';
      }
    }, 1200);
  }
  else if (evName === 'locker_cancel') {
    // 3. Prompt cancelled/closed -> Reset to normal
    appState.lockerPrompting = false;
    clearTimeout(lockerPromptSafetyTimer);
    island.classList.remove('island-locker-glow', 'island-locker-wrong');
    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.remove('prompt-wrong');
    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) icoEl.classList.remove('lock-shake');
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = 'Locked';
    renderCenter();
    updateClocks();
    refreshMedia();
  }
  else if (evName === 'locker_unlock') {
    // 4. Unlocked! Immediately clear prompting so user is NOT stuck on lock while browsing folder!
    appState.lockerPrompting = false;
    clearTimeout(lockerPromptSafetyTimer);
    clearTimeout(lockerWrongTimer);
    island.classList.remove('island-locker-wrong');
    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.remove('prompt-wrong');
    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) icoEl.classList.remove('lock-shake');
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = 'Locked';

    // Soft subtle green glow border
    island.classList.add('island-locker-glow');

    // Kind: face / fingerprint / unlock
    const kind = payload.type === 'fingerprint' ? 'fingerprint' : payload.type === 'charging' ? 'charging' : payload.type === 'low_battery' ? 'low_battery' : payload.type === 'alarm' ? 'alarm' : payload.type === 'transfer' ? 'transfer' : payload.type === 'bluetooth' ? 'bluetooth' : payload.type === 'caps' ? 'caps' : payload.type === 'num' ? 'num' : payload.type === 'download' ? 'download' : payload.type === 'download_done' ? 'download_done' : 'scan';
    const targetName = payload.target ? `${payload.target}` : 'Unlocked';

    renderCenter();
    if (kind === 'alarm') {
      if (typeof triggerTimerAlarm === 'function') triggerTimerAlarm();
    } else if (kind === 'scan' || kind === 'fingerprint') {
      triggerBiometricMorph(kind, targetName);
    } else if (kind === 'charging') {
      showDeviceHud({ iconHTML: BOLT_SVG, battery: true, plain: true, accent: 'green', name: 'Charging', tag: `${payload.target || '85%'} • MagSafe Power`, pct: parseInt(payload.target, 10) || 85, ms: 3200 });
    } else if (kind === 'low_battery') {
      showDeviceHud({ iconHTML: LOW_BATT_SVG, battery: true, plain: true, accent: 'amber', name: 'Low Battery', tag: `${payload.target || '18%'} • Connect Power`, pct: parseInt(payload.target, 10) || 18, ms: 3800 });
    } else if (kind === 'bluetooth') {
      if (typeof showBtConnectHud === 'function') {
        showBtConnectHud(payload.target || 'AirPods Pro', payload.kind || 'headphones', parseInt(payload.pct, 10) || 90);
      }
    } else if (kind === 'caps') {
      const capsSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 5 12h4v4h6v-4h4z"/><line x1="9" y1="20" x2="15" y2="20"/></svg>';
      showDeviceHud({ iconHTML: capsSvg, plain: false, accent: 'blue', name: 'Caps Lock', tag: 'On', ms: 2200 });
    } else if (kind === 'num') {
      const numSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M9 8v4M9 8l-1 1M14.5 8h1.5v8"/><path d="M8 16h2"/></svg>';
      showDeviceHud({ iconHTML: numSvg, plain: false, accent: 'blue', name: 'Num Lock', tag: 'On', ms: 2200 });
    } else if (kind === 'download') {
      const dlSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';
      showDeviceHud({ iconHTML: dlSvg, plain: true, accent: 'blue', name: payload.target || 'Inex-Island-Setup.exe', tag: 'Downloading • 3.5 MB', ms: 2500 });
    } else if (kind === 'download_done') {
      const dlDoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
      showDeviceHud({ iconHTML: dlDoneSvg, plain: true, accent: 'ok', name: payload.target || 'Inex-Island-Setup.exe', tag: 'Download Complete • 3.5 MB', ms: 4000 });
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
    } else {
      showToast(kind, `${targetName} Unlocked`, 1400);
    }

    clearTimeout(lockerGlowTimer);
    lockerGlowTimer = setTimeout(() => {
      island.classList.remove('island-locker-glow');
    }, 1400);
  }
  else if (evName === 'locker_pair' || evName === 'locker_unpair' || evName === 'locker_remove') {
    // Locker Pro status signals: phone paired / unpaired, folder or app removed from the locker.
    // The on/off switch lives ONLY in Locker Pro: if it is off, the locker sends nothing, so the island just shows what it receives.
    appState.lockerPrompting = false;
    clearTimeout(lockerPromptSafetyTimer);
    island.classList.remove('island-locker-wrong', 'island-locker-glow');
    const tgt = payload.target ? String(payload.target) : '';
    renderCenter();
    if (evName === 'locker_pair') showToast('phone', tgt ? `${tgt} Paired` : 'Phone Paired', 1800);
    else if (evName === 'locker_unpair') showToast('unphone', 'Phone Unpaired', 1800);
    else showToast('unlock', tgt ? `${tgt} Removed` : 'Removed', 1600);
  }
  else if (evName === 'locker_lock') {
    // Folder/app got locked (Add folder, tray "Lock Now", auto re-lock). There was NO handler for this
    // event before: the "Master Password" status then hung around until the old 12 s timer, and
    // "Lock Now" showed nothing at all.
    appState.lockerPrompting = false;
    clearTimeout(lockerPromptSafetyTimer);
    clearTimeout(lockerWrongTimer);
    island.classList.remove('island-locker-wrong', 'island-locker-glow');
    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.remove('prompt-wrong');
    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) icoEl.classList.remove('lock-shake');
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = 'Locked';

    const tgt = payload.target ? String(payload.target) : '';
    const nowMs = Date.now();
    // "password accepted" and "lock finished" can both arrive for one folder: show one toast
    if (lastLockToast.target === tgt && nowMs - lastLockToast.at < 3000) {
      renderCenter();
      updateClocks();
      refreshMedia();
      return;
    }
    lastLockToast = { target: tgt, at: nowMs };
    renderCenter();
    showToast('lock', tgt ? `${tgt} Locked` : 'Locked', 1400);
  }
});

// ---- File transfer in the notch (same animation for the P2P link and for direct sharing) ----
const XFER_UP = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';
const XFER_DOWN = '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="5 12 12 19 19 12"/>';

function xferDirection() {
  let send = false, recv = false;
  for (const e of rtcPeers.values()) {
    if (e.send && e.send.active) send = true;
    if (e.recv && e.recv.active) recv = true;
  }
  return send && recv ? 'both' : recv ? 'recv' : 'send';
}

function setXferDirectionUI() {
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

function setXferRing(pct) {
  const ring = document.getElementById('c-xfer-ring-fg');
  if (ring) ring.style.strokeDashoffset = String(66 * (1 - Math.max(0, Math.min(100, pct)) / 100));
}

function startCompactTransferUI() {
  appState.transferring = true;
  lastReportedPct = -1;
  const box = document.getElementById('c-transfer-anim');
  if (box) { box.dataset.dir = ''; box.classList.add('indeterminate'); }
  setXferDirectionUI();
  setXferRing(0);
  document.getElementById('c-transfer-pct').textContent = '0%';
  renderCenter();
}

function updateCompactTransferPct(pct, speed) {
  document.getElementById('c-transfer-pct').textContent = speed ? `${pct}% • ${speed}` : `${pct}%`;
  const box = document.getElementById('c-transfer-anim');
  if (box && pct > 0) box.classList.remove('indeterminate');
  setXferDirectionUI();
  setXferRing(pct);
}

function finishCompactTransferUI() {
  const completed = lastReportedPct >= 100;     // 100% reached = really finished (a cancel never gets there)
  const dir = appState.xferDir;
  appState.transferring = false;
  lastReportedPct = -1;
  endTransferStats();
  renderCenter();
  updateClocks();
  refreshMedia();
  if (completed) showToast('done', dir === 'recv' ? 'Received' : 'Sent', 1500);
}

// Windows password / PIN / credential prompts -> lock animation in the notch
// Native Credential / PIN prompt event (from WinEventHook)
onTauriEvent('native-prompt-changed', (event) => {
  const on = !!(event && event.payload && event.payload.active);
  if (on !== appState.prompting) {
    appState.prompting = on;
    renderCenter();
    if (!on) {
      updateClocks();
      // the prompt closed (if an explicit locker-unlock toast is already showing, don't overwrite it)
      if (SET.general && SET.general.lockToast && !appState.toast && !appState.lockerPrompting) showToast('unlock', 'Done', 1500);
    }
  }
});

// Windows lock screen (Win+L, Dynamic Lock, idle lock): when the PC is unlocked (password, PIN, fingerprint, face),
// Windows kernel notifies us natively via WTSRegisterSessionNotification (0% polling).
let lockPrev = null;
let lockUnlockT = null;
onTauriEvent('session-lock-changed', (event) => {
  if (SET.general && !SET.general.lockToast) { lockPrev = null; return; }
  const locked = event && event.payload && event.payload.locked;
  if (typeof locked !== 'boolean') return;
  if (lockPrev === true && locked === false && SET.general && SET.general.lockToast) {
    // let the desktop finish appearing before the island starts to move
    clearTimeout(lockUnlockT);
    lockUnlockT = setTimeout(() => triggerBiometricMorph('scan', 'Unlocked'), 450);
  }
  lockPrev = locked;
});


// 9. Media Transport Controls
document.getElementById('m-play').addEventListener('click', async () => {
  await invokeTauri('media_play_pause');
  setTimeout(pollSystemAndMedia, 250);
});
document.getElementById('m-next').addEventListener('click', async () => {
  await invokeTauri('media_next');
  setTimeout(pollSystemAndMedia, 250);
});
document.getElementById('m-prev').addEventListener('click', async () => {
  await invokeTauri('media_prev');
  setTimeout(pollSystemAndMedia, 250);
});

// 10. Focus Timer + Apple Crystal Alarm (100% Native Windows Sound, Zero Chromium AudioService)
let alarmChimeInterval = null;
let alarmAutoDismissTimeout = null;

function playAlarmChime() {
  invokeTauri('play_alarm_sound').catch(() => {});
}

let alarmStartT = null;
let alarmBackT = null;
let alarmCleanT = null;

// Closes any other island popup (device HUD, Face ID) at once: the timer-end card has priority.
function alarmClearOtherHuds() {
  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT);
  clearTimeout(bioTimer); clearTimeout(bioAnimPhaseTimer); clearTimeout(bioStartTimer); clearTimeout(bioEndTimer);
  island.classList.remove('bt-hud-active', 'biometric-active', 'bio-hud', 'hud-pre', 'hud-back', 'hud-out');
  const btHud = document.getElementById('c-bt-hud');
  if (btHud) btHud.classList.add('hidden');
  const bioBox = document.getElementById('c-biometric-box');
  if (bioBox) bioBox.classList.add('hidden');
}

function alarmLabel() {
  const secs = Math.round((appState.timerPresetMins || 0) * 60);
  if (secs >= 60 && secs % 60 === 0) return `Timer \u2022 ${secs / 60} min`;
  if (secs >= 60) return `Timer \u2022 ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return `Timer \u2022 ${secs} sec`;
}

// opts (clock alarm): { title, sub, snooze: true, ms }.  No opts = the focus-timer card.
function triggerTimerAlarm(opts) {
  opts = opts || {};
  if (appState.currentView !== 'view-compact') {
    goCompact();
  }

  const alarmBox = document.getElementById('c-alarm-box');
  if (!alarmBox) return;

  clearInterval(alarmChimeInterval);
  clearTimeout(alarmAutoDismissTimeout);
  clearTimeout(alarmStartT); clearTimeout(alarmBackT); clearTimeout(alarmCleanT);
  appState.alarmClosing = false;

  // nothing else running -> the full Mac-style show; with a transfer / media / popup running the card still comes on top
  const idle = !(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast || appState.mediaPlaying);

  alarmClearOtherHuds();
  appState.alarmActive = true;
  updateTimerChip();

  const sub = document.getElementById('alarm-sub');
  if (sub) sub.textContent = opts.sub || alarmLabel();
  const ttl = document.getElementById('alarm-title');
  if (ttl) ttl.textContent = opts.title || "Time's Up";
  const snz = document.getElementById('btn-alarm-snooze');
  if (snz) snz.classList.toggle('hidden', !opts.snooze);
  appState.alarmSnoozable = !!opts.snooze;
  appState.alarmOpts = opts;
  alarmBox.classList.remove('hidden');
  island.classList.remove('alarm-active', 'hud-out');
  island.classList.toggle('alarm-full', idle);

  // 1) window big enough, 2) old content blurs away, 3) island springs open
  tryInvoke('resize_island', { width: 256, height: 56 });  // same window as the device HUD
  island.classList.add('hud-pre');
  alarmStartT = setTimeout(() => {
    island.classList.remove('hud-pre');
    island.classList.add('alarm-active');
  }, 110);

  if (SET.notch && SET.notch.timerSound !== false) {
    playAlarmChime();
    alarmChimeInterval = setInterval(() => {
      if (appState.alarmActive && !appState.alarmClosing) {
        playAlarmChime();
      } else {
        clearInterval(alarmChimeInterval);
      }
    }, 2400);
  }

  alarmAutoDismissTimeout = setTimeout(() => {
    dismissTimerAlarm();
  }, opts.ms || 14000);
}

function dismissTimerAlarm() {
  clearInterval(alarmChimeInterval);
  clearTimeout(alarmAutoDismissTimeout);
  clearTimeout(alarmStartT);

  const alarmBox = document.getElementById('c-alarm-box');
  if (!alarmBox || !appState.alarmActive || appState.alarmClosing) return;
  appState.alarmClosing = true;

  // content fades, island shrinks back to the pill (no bounce), the old status comes back
  island.classList.remove('hud-pre');
  island.classList.add('alarm-active', 'hud-out');
  alarmBackT = setTimeout(() => {
    island.classList.remove('alarm-active', 'alarm-full', 'hud-out');
    island.classList.add('hud-back');
    alarmCleanT = setTimeout(() => {
      alarmBox.classList.add('hidden');
      island.classList.remove('hud-back');
      appState.alarmActive = false;
      appState.alarmClosing = false;
      hudRestoreWindow();
      renderCenter();
      updateClocks();
      refreshMedia();
    }, 560);
  }, 170);
}

// Timer started: the island pops open for a moment (Mac / iPhone style), then settles into icon + countdown.
const TIMER_HUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2"/><path d="M9.5 2.5h5"/></svg>';
function showTimerStartHud() {
  const secs = Math.round((appState.timerPresetMins || 0) * 60);
  const total = secs >= 60 && secs % 60 === 0 ? `${secs / 60} min` : secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs} sec`;
  showDeviceHud({ iconHTML: TIMER_HUD_SVG, plain: true, accent: 'amber', name: 'Timer', tag: `Started \u2022 ${total}`, ms: 2000 });
}
function announceTimerStart() {
  if (hudCanShow()) showTimerStartHud();
  else appState.timerStartPending = true;   // timer menu is open: play it when the island goes back to the pill (see switchView)
}

// The running timer is shown as a small chip while a transfer / popup owns the middle of the pill
// (when nothing else is busy the timer simply replaces the clock, also while media plays).
function updateTimerChip() {
  const busy = !!(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast);
  const on = !!appState.timerRunning && busy && !appState.alarmActive && appState.currentView === 'view-compact';
  island.classList.toggle('timer-chip-on', on);
  island.classList.toggle('timer-live', !!appState.timerRunning && !busy && !appState.alarmActive);
  if (on) {
    const t = document.getElementById('c-timer-chip-text');
    if (t) {
      const m = String(Math.floor(appState.timerSeconds / 60)).padStart(2, '0');
      const sec = String(appState.timerSeconds % 60).padStart(2, '0');
      t.textContent = `${m}:${sec}`;
    }
  }
}

function formatTimerDisplay() {
  const m = String(Math.floor(appState.timerSeconds / 60)).padStart(2, '0');
  const s = String(appState.timerSeconds % 60).padStart(2, '0');
  const disp = document.getElementById('timer-display');
  if (disp && !disp.querySelector('input')) {
    disp.textContent = `${m} : ${s}`;
  }

  const cClock = document.getElementById('c-clock');
  if (appState.timerRunning && !appState.transferring && !appState.prompting && !appState.lockerPrompting) {
    if (cClock) {
      cClock.textContent = `${m}:${s}`;
      cClock.classList.add('c-clock-timer');
    }
  } else {
    if (cClock) cClock.classList.remove('c-clock-timer');
  }
  updateTimerChip();
}

document.getElementById('btn-timer-toggle').addEventListener('click', function () {
  appState.timerRunning = !appState.timerRunning;
  this.textContent = appState.timerRunning ? '⏸ Pause' : '▶ Start';
  document.getElementById('act-timer')?.classList.toggle('active', appState.timerRunning);

  if (appState.timerRunning) {
    if (appState.timerSeconds === appState.timerPresetMins * 60) announceTimerStart();   // fresh start only, not resume after pause
    formatTimerDisplay();
    appState.timerInterval = setInterval(() => {
      if (appState.timerSeconds > 0) {
        appState.timerSeconds--;
        formatTimerDisplay();
      } else {
        clearInterval(appState.timerInterval);
        appState.timerRunning = false;
        document.getElementById('btn-timer-toggle').textContent = '▶ Start';
        document.getElementById('act-timer')?.classList.remove('active');
        appState.timerSeconds = appState.timerPresetMins * 60;
        formatTimerDisplay();
        updateClocks();
        triggerTimerAlarm();
      }
    }, 1000);
  } else {
    clearInterval(appState.timerInterval);
    const cClock = document.getElementById('c-clock');
    if (cClock) cClock.classList.remove('c-clock-timer');
    updateClocks();
    updateTimerChip();
  }
});

document.getElementById('btn-timer-reset').addEventListener('click', () => {
  clearInterval(appState.timerInterval);
  appState.timerRunning = false;
  appState.timerSeconds = appState.timerPresetMins * 60;
  document.getElementById('btn-timer-toggle').textContent = '▶ Start';
  document.getElementById('act-timer')?.classList.remove('active');
  const cClock = document.getElementById('c-clock');
  if (cClock) cClock.classList.remove('c-clock-timer');
  formatTimerDisplay();
  updateClocks();
});

// Type your own time: "12" = 12 minutes, "1:30" = 1 min 30 s, "90s" = 90 seconds
function parseTimerInput(v) {
  v = String(v).trim().toLowerCase();
  let m;
  if ((m = v.match(/^(\d{1,3})\s*:\s*(\d{1,2})$/))) return +m[1] * 60 + Math.min(59, +m[2]);
  if ((m = v.match(/^(\d{1,5})\s*s(ec)?$/))) return +m[1];
  if ((m = v.match(/^(\d{1,3})\s*m?(in)?$/))) return +m[1] * 60;
  return null;
}
function applyCustomTimer(secs) {
  clearInterval(appState.timerInterval);
  appState.timerRunning = false;
  document.getElementById('btn-timer-toggle').textContent = '▶ Start';
  document.getElementById('act-timer')?.classList.remove('active');
  appState.timerSeconds = secs;
  appState.timerPresetMins = secs / 60;
  document.querySelectorAll('.timer-presets button').forEach((b) => b.classList.remove('active'));
  const mm = Math.floor(secs / 60), ss = secs % 60;
  document.getElementById('focus-title-label').textContent = ss ? `FOCUS ${mm}:${String(ss).padStart(2, '0')}` : `FOCUS ${mm}M`;
  formatTimerDisplay();
  updateClocks();
}
function editTimer() {
  const disp = document.getElementById('timer-display');
  if (disp.querySelector('input') || appState.timerRunning) return;
  appState.keepOpen = true;                 // do not collapse while typing
  invokeTauri('focus_island');
  const inp = document.createElement('input');
  inp.className = 'timer-edit';
  inp.type = 'text';
  inp.maxLength = 6;
  inp.placeholder = 'min';
  inp.autocomplete = 'off';
  disp.textContent = '';
  disp.append(inp);
  let done = false;
  const finish = (apply) => {
    if (done) return;
    done = true;
    appState.keepOpen = false;
    const secs = apply ? parseTimerInput(inp.value) : null;
    inp.remove();
    if (secs && secs > 0 && secs <= 999 * 60) applyCustomTimer(secs);
    else formatTimerDisplay();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
  setTimeout(() => inp.focus(), 80);
}
document.getElementById('timer-display').addEventListener('click', editTimer);
document.getElementById('btn-timer-custom').addEventListener('click', editTimer);

document.querySelectorAll('.timer-presets button[data-min]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.timer-presets button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const mins = parseInt(btn.dataset.min, 10);
    appState.timerPresetMins = mins;
    appState.timerSeconds = mins * 60;
    document.getElementById('focus-title-label').textContent = `FOCUS ${mins}M`;
    formatTimerDisplay();
  });
});

// ==================== 10b. CALENDAR GRID ====================
let calCurrent = new Date();
const CAL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function renderCalendarGrid(dir) {
  const container = document.getElementById('cal-days-grid');
  const title = document.getElementById('cal-month-title');
  if (!container || !title) return;

  const year = calCurrent.getFullYear();
  const month = calCurrent.getMonth();
  title.innerHTML = `${CAL_MONTHS[month]}<span class="yr">${year}</span>`;

  const today = new Date();
  const isThisMonth = today.getFullYear() === year && today.getMonth() === month;
  const firstDayIndex = new Date(year, month, 1).getDay();

  // always 6 week rows (42 cells), so the menu never changes height between months
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - firstDayIndex + i);
    const cell = document.createElement('span');
    cell.className = 'cal-day';
    if (d.getMonth() !== month) cell.classList.add('muted');
    else if (d.getDay() === 0 || d.getDay() === 6) cell.classList.add('weekend');
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
      cell.classList.add('today');
    }
    cell.textContent = d.getDate();
    frag.appendChild(cell);
  }
  container.replaceChildren(frag);

  if (dir) {
    container.classList.remove('slide-next', 'slide-prev');
    void container.offsetWidth;
    container.classList.add(dir === 'prev' ? 'slide-prev' : 'slide-next');
  }
  const todayBtn = document.getElementById('btn-cal-today');
  if (todayBtn) todayBtn.classList.toggle('ghost', isThisMonth);

  // 6 rows need a bit more room than the other sub menus
  if (appState.currentView === 'view-calendar') {
    invokeTauri('resize_island', { width: 316, height: 268 + (hudIsFloating() ? 12 : 0) });
  }
}

function calShift(n) {
  calCurrent = new Date(calCurrent.getFullYear(), calCurrent.getMonth() + n, 1);   // day 1: Jan 31 + 1 month must not jump to March
  renderCalendarGrid(n > 0 ? 'next' : 'prev');
}

document.getElementById('btn-cal-prev')?.addEventListener('click', () => calShift(-1));
document.getElementById('btn-cal-next')?.addEventListener('click', () => calShift(1));
document.getElementById('btn-cal-today')?.addEventListener('click', () => {
  const now = new Date();
  const dir = (now.getFullYear() * 12 + now.getMonth()) < (calCurrent.getFullYear() * 12 + calCurrent.getMonth()) ? 'prev' : 'next';
  calCurrent = now;
  renderCalendarGrid(dir);
});
// mouse wheel flips months
let calWheelAt = 0;
document.querySelector('#view-calendar .cal-container')?.addEventListener('wheel', (e) => {
  e.preventDefault();
  const t = performance.now();
  if (t - calWheelAt < 200) return;
  calWheelAt = t;
  calShift(e.deltaY > 0 ? 1 : -1);
}, { passive: false });

// ==================== 10c. QUICK NOTES (BUILT-IN SCRATCHPAD) ====================
const noteArea = document.getElementById('notepad-textarea');
const noteCharCount = document.getElementById('notepad-char-count');

function updateNoteCount(len) {
  if (noteCharCount) noteCharCount.textContent = `${len} character${len === 1 ? '' : 's'}`;
}

if (noteArea) {
  const saved = localStorage.getItem('inex.island.notes') || '';
  noteArea.value = saved;
  updateNoteCount(saved.length);

  noteArea.addEventListener('input', (e) => {
    const val = e.target.value;
    try { localStorage.setItem('inex.island.notes', val); } catch (_) {}
    updateNoteCount(val.length);
  });
}

function focusNotepad() {
  if (noteArea) {
    appState.keepOpen = true;
    invokeTauri('focus_island');
    setTimeout(() => { noteArea.focus(); appState.keepOpen = false; }, 80);
  }
}

document.getElementById('btn-notepad-clear')?.addEventListener('click', () => {
  if (noteArea) {
    noteArea.value = '';
    try { localStorage.setItem('inex.island.notes', ''); } catch (_) {}
    updateNoteCount(0);
    showToast('unlock', 'Notes cleared', 1200);
  }
});

document.getElementById('btn-notepad-copy')?.addEventListener('click', async () => {
  if (!noteArea || !noteArea.value) {
    showToast('snip', 'Note is empty', 1200);
    return;
  }
  try {
    await navigator.clipboard.writeText(noteArea.value);
    showToast('snip', 'Copied to clipboard', 1200);
  } catch (_) {
    showToast('snip', 'Select all & Ctrl+C', 1500);
  }
});

// Real 5-Band Audio Visualizer (WASAPI Loopback + FFT ~32ms Event-Driven)
const cEqBars = [...document.querySelectorAll('#c-eq span')];
const mEqBars = [...document.querySelectorAll('#m-eq-bars span')];
let lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
let currentHeightsC = [2, 2, 2, 2, 2];
let currentHeightsM = [2, 2, 2, 2, 2];
// Cost notes (this is the only thing that keeps the WebView busy while music plays):
//  * bars are drawn with transform: scaleY (compositor only: no layout, no repaint);
//  * redraw at ~30 Hz, the same rate Rust sends data, with setTimeout instead of a 60-144 Hz rAF;
//  * when every bar has reached its target (silence, pause, no new data) the timer is NOT re-armed.
//    The next audio-visualization event, view change or play state change restarts it.
var eqRaf = 0; // timer id; var: referenced by refreshMedia() before this line runs
let eqQuietCount = 0;
const eqCompact = document.getElementById('c-eq');
const EQ_FRAME_MS = 33;
const EQ_H_COMPACT = 12;  // 2px rest + 10px range
const EQ_H_MEDIA = 20;    // 2px rest + 18px range

function eqKick() {
  if (!eqRaf) eqRaf = setTimeout(eqDraw, 0);
}

// Tauri event pushed by Rust WASAPI Loopback FFT worker (~32ms)
onTauriEvent('audio-visualization', (event) => {
  if (!SET.notch.eqSync || !appState.mediaPlaying) return;
  const freqs = (event.payload && event.payload.frequencies) || [];
  if (freqs.length >= 5) {
    lastFrequencies = freqs;
    const avg = freqs.reduce((a, b) => a + b, 0) / freqs.length;
    if (avg > 0.20) {
      eqQuietCount = 0;
      eqCompact.classList.remove('quiet');
    } else {
      eqQuietCount++;
      if (eqQuietCount > 50) eqCompact.classList.add('quiet');
    }
    eqKick();
  }
});

// Move one set of bars toward its targets. Returns true while anything is still moving.
function eqStep(bars, heights, range, H, isPlaying, sens, now) {
  let moving = false;
  bars.forEach((bar, i) => {
    let target = 2;
    if (isPlaying) {
      if (SET.notch.eqSync) {
        const val = lastFrequencies[i] ?? 0.18;
        const bandBoost = i === 4 ? 1.55 : (i === 3 ? 1.35 : (i === 2 ? 1.12 : 1.0));
        const norm = Math.max(0, (val - 0.18) / 0.82) * sens * bandBoost;
        target = 2 + Math.min(1, norm) * range;
      } else {
        target = 2 + (0.55 + 0.35 * Math.sin(now / 260 + i * 1.5)) * range;
      }
    }
    const d = target - heights[i];
    if (Math.abs(d) < 0.05) {
      heights[i] = target;
    } else {
      heights[i] += d * 0.7; // 0.45 per 60 Hz frame is about 0.7 per 30 Hz frame
      moving = true;
    }
    const sc = (heights[i] / H).toFixed(3);
    if (bar._sc !== sc) {
      bar._sc = sc;
      bar.style.transform = `scaleY(${sc})`;
    }
  });
  return moving;
}

function eqDraw() {
  eqRaf = 0;
  const sens = (SET.notch.eqSensitivity || 100) / 100;
  const isPlaying = appState.mediaPlaying;
  const now = performance.now();
  const view = appState.currentView;

  let moving = false;
  if (view === 'view-compact') moving = eqStep(cEqBars, currentHeightsC, 10, EQ_H_COMPACT, isPlaying, sens, now) || moving;
  if (view === 'view-media') moving = eqStep(mEqBars, currentHeightsM, 18, EQ_H_MEDIA, isPlaying, sens, now) || moving;

  // Without audio sync the bars run a decorative sine wave: that one needs the timer while playing.
  const animating = isPlaying && !SET.notch.eqSync && (view === 'view-compact' || view === 'view-media');
  if (moving || animating) eqRaf = setTimeout(eqDraw, EQ_FRAME_MS);
}

// Start/stop visualizer and animation loop based on playback state
function syncEq() {
  const active = appState.mediaPlaying && SET.notch && SET.notch.eqSync;
  invokeTauri('set_visualizer_active', { active }).catch(() => {});
  if (!appState.mediaPlaying) lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
  eqKick();
}

function chime() {
  invokeTauri('play_alarm_sound').catch(() => {});
}





// Widgets (Reliable Weather with Open-Meteo + Fast IP Geolocation, RAM, CPU, Disk, Battery)
const W_SVG = (inner) => `<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:2px;flex-shrink:0;">${inner}</svg>`;

const W_ICONS = {
  sun: W_SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
  moon: W_SVG('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  cloud_sun: W_SVG('<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.9 12.6a4 4 0 0 0-5.9-4.1"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>'),
  cloud: W_SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>'),
  rain: W_SVG('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="m8 19-1 3m5-3-1 3m5-3-1 3"/>'),
  storm: W_SVG('<path d="M19 16.9A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/><polyline points="13 11 9 17 15 17 11 23"/>'),
  snow: W_SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><line x1="8" y1="15" x2="8.01" y2="15"/><line x1="12" y1="17" x2="12.01" y2="17"/><line x1="16" y1="15" x2="16.01" y2="15"/>')
};

const WMO_CODES = {
  0: { day: W_ICONS.sun, night: W_ICONS.moon, text: 'Clear' },
  1: { day: W_ICONS.cloud_sun, night: W_ICONS.moon, text: 'Mostly Clear' },
  2: { day: W_ICONS.cloud_sun, night: W_ICONS.cloud, text: 'Partly Cloudy' },
  3: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Overcast' },
  45: { day: W_ICONS.cloud_sun, night: W_ICONS.moon, text: 'Hazy' },
  48: { day: W_ICONS.cloud_sun, night: W_ICONS.moon, text: 'Hazy' },
  51: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Drizzle' },
  53: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Drizzle' },
  55: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Drizzle' },
  56: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Drizzle' },
  57: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Drizzle' },
  61: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Rain' },
  63: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Rain' },
  65: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Heavy Rain' },
  66: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Rain' },
  67: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Rain' },
  71: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow' },
  73: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow' },
  75: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Heavy Snow' },
  77: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow' },
  80: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Showers' },
  81: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Showers' },
  82: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Heavy Showers' },
  85: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow Showers' },
  86: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Heavy Snow' },
  95: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm' },
  96: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm' },
  99: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm' }
};

const W_DOT_SVG = (inner) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:inline-block;vertical-align:-1px;margin-right:2px;flex-shrink:0;">${inner}</svg>`;

const W_DOT_ICONS = {
  sun: W_DOT_SVG('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="4.5" r="1.2"/><circle cx="12" cy="19.5" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="19.5" cy="12" r="1.2"/><circle cx="6.7" cy="6.7" r="1.2"/><circle cx="17.3" cy="17.3" r="1.2"/><circle cx="6.7" cy="17.3" r="1.2"/><circle cx="17.3" cy="6.7" r="1.2"/>'),
  moon: W_DOT_SVG('<circle cx="13" cy="5" r="1.2"/><circle cx="11" cy="7" r="1.2"/><circle cx="9" cy="9.5" r="1.2"/><circle cx="8" cy="12.5" r="1.2"/><circle cx="8.5" cy="15.5" r="1.2"/><circle cx="10.5" cy="18" r="1.2"/><circle cx="13" cy="19" r="1.2"/><circle cx="18" cy="7" r="0.9"/><circle cx="19" cy="13" r="0.9"/>'),
  cloud_sun: W_DOT_SVG('<circle cx="8" cy="13" r="1.3"/><circle cx="11" cy="11.5" r="1.3"/><circle cx="14" cy="11.5" r="1.3"/><circle cx="17" cy="13" r="1.3"/><circle cx="6" cy="16" r="1.3"/><circle cx="9" cy="16" r="1.3"/><circle cx="12" cy="16" r="1.3"/><circle cx="15" cy="16" r="1.3"/><circle cx="18" cy="16" r="1.3"/><circle cx="12" cy="5.5" r="1.2"/><circle cx="16" cy="7.5" r="1.2"/>'),
  cloud: W_DOT_SVG('<circle cx="8" cy="12" r="1.3"/><circle cx="11" cy="10.5" r="1.3"/><circle cx="14" cy="10.5" r="1.3"/><circle cx="17" cy="12" r="1.3"/><circle cx="6" cy="15" r="1.3"/><circle cx="9" cy="15" r="1.3"/><circle cx="12" cy="15" r="1.3"/><circle cx="15" cy="15" r="1.3"/><circle cx="18" cy="15" r="1.3"/>'),
  rain: W_DOT_SVG('<circle cx="8" cy="11" r="1.2"/><circle cx="11" cy="9.5" r="1.2"/><circle cx="14" cy="9.5" r="1.2"/><circle cx="17" cy="11" r="1.2"/><circle cx="6" cy="13.5" r="1.2"/><circle cx="9" cy="13.5" r="1.2"/><circle cx="12" cy="13.5" r="1.2"/><circle cx="15" cy="13.5" r="1.2"/><circle cx="18" cy="13.5" r="1.2"/><circle cx="8" cy="18" r="1"/><circle cx="13" cy="18" r="1"/><circle cx="18" cy="18" r="1"/><circle cx="7" cy="21" r="1"/><circle cx="12" cy="21" r="1"/><circle cx="17" cy="21" r="1"/>'),
  storm: W_DOT_SVG('<circle cx="8" cy="10.5" r="1.2"/><circle cx="11" cy="9" r="1.2"/><circle cx="14" cy="9" r="1.2"/><circle cx="17" cy="10.5" r="1.2"/><circle cx="6" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/><circle cx="12" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><circle cx="18" cy="13" r="1.2"/><path d="M12 15l-2 4h3l-1 4" stroke="currentColor" stroke-width="1.8" fill="none"/>'),
  snow: W_DOT_SVG('<circle cx="8" cy="11" r="1.2"/><circle cx="11" cy="9.5" r="1.2"/><circle cx="14" cy="9.5" r="1.2"/><circle cx="17" cy="11" r="1.2"/><circle cx="6" cy="13.5" r="1.2"/><circle cx="9" cy="13.5" r="1.2"/><circle cx="12" cy="13.5" r="1.2"/><circle cx="15" cy="13.5" r="1.2"/><circle cx="18" cy="13.5" r="1.2"/><circle cx="8" cy="18" r="1.1"/><circle cx="13" cy="18" r="1.1"/><circle cx="17" cy="18" r="1.1"/>')
};

function getActiveWeatherIcon() {
  if (SET?.appearance?.themeStyle === 'matrix') {
    const code = weather.code || 0;
    const isDay = weather.isDay !== false;
    if (code === 0) return isDay ? W_DOT_ICONS.sun : W_DOT_ICONS.moon;
    if (code === 1 || code === 2) return isDay ? W_DOT_ICONS.cloud_sun : W_DOT_ICONS.cloud;
    if (code === 3 || code === 45 || code === 48) return W_DOT_ICONS.cloud;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return W_DOT_ICONS.rain;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return W_DOT_ICONS.snow;
    if (code >= 95) return W_DOT_ICONS.storm;
    return isDay ? W_DOT_ICONS.sun : W_DOT_ICONS.moon;
  }
  return weather.iconSvg || W_ICONS.sun;
}

const weather = { text: '', iconSvg: W_ICONS.sun, condition: '', at: 0, key: '', place: '', loc: null, locAt: 0, locFailAt: 0, busy: false };
try {
  const cw = JSON.parse(localStorage.getItem('inex.weather.cached') || 'null');
  if (cw && cw.text && Date.now() - cw.at < 60 * 60 * 1000) {
    weather.text = cw.text;
    weather.iconSvg = cw.iconSvg || W_ICONS.sun;
    weather.condition = cw.condition || '';
    weather.place = cw.place || '';
    weather.at = cw.at;
  }
} catch (_) {}

// Fast IP-based geolocation (no Windows Location COM delays or process locks)
async function detectLocation() {
  const LOC_TTL = 6 * 60 * 60 * 1000, FAIL_TTL = 5 * 60 * 1000;
  if (!weather.loc) {
    try {
      const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null');
      if (sv && sv.loc && Date.now() - sv.at < LOC_TTL) { weather.loc = sv.loc; weather.locAt = sv.at; }
    } catch (_) {}
  }
  if (weather.loc && Date.now() - weather.locAt < LOC_TTL) return weather.loc;
  if (weather.locFailAt && Date.now() - weather.locFailAt < FAIL_TTL) return weather.loc;

  let loc = null;
  const tries = [
    async () => {
      const res = await fetch('https://ipapi.co/json/');
      if (res.ok) {
        const d = await res.json();
        const lat = d.latitude || d.lat, lon = d.longitude || d.lon;
        if (lat && lon) return { lat: +lat, lon: +lon, city: d.city || '' };
      }
      return null;
    },
    async () => {
      const res = await fetch('https://ipwho.is/');
      if (res.ok) {
        const d = await res.json();
        if (d && d.success !== false) return { lat: +d.latitude, lon: +d.longitude, city: d.city || '' };
      }
      return null;
    },
    async () => {
      const res = await fetch('https://freeipapi.com/api/json');
      if (res.ok) {
        const d = await res.json();
        if (d && d.latitude && d.longitude) return { lat: +d.latitude, lon: +d.longitude, city: d.cityName || '' };
      }
      return null;
    }
  ];

  for (const t of tries) {
    try {
      const r = await t();
      if (r && isFinite(r.lat) && isFinite(r.lon)) { loc = r; break; }
    } catch (_) {}
  }

  if (loc) {
    weather.loc = loc; weather.locAt = Date.now(); weather.locFailAt = 0;
    try { localStorage.setItem('inex.loc', JSON.stringify({ loc, at: weather.locAt })); } catch (_) {}
  } else {
    weather.locFailAt = Date.now();
  }
  return loc;
}

async function refreshWeather() {
  if (weather.busy) return;
  weather.busy = true;
  try {
    if (!SET.weather.enabled) {
      weather.text = '';
      renderWidgets();
      return;
    }
    const unit = SET.weather.unit === 'F' ? 'F' : 'C';
    const loc = await detectLocation();
    if (!loc) {
      weather.text = ''; weather.place = ''; weather.at = 0; weather.key = '';
      renderWidgets();
      return;
    }
    const ck = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    const key = `${ck}|${unit}`;
    if (weather.text && weather.key === key && Date.now() - weather.at < 20 * 60 * 1000) return;
    weather.key = key;
    weather.at = Date.now();

    let tempStr = '', code = 0, isDay = true;
    try {
      const unitParam = unit === 'F' ? '&temperature_unit=fahrenheit' : '';
      const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day&timezone=auto${unitParam}`);
      if (wRes.ok) {
        const wData = await wRes.json();
        const tVal = wData?.current?.temperature_2m;
        if (typeof tVal === 'number') {
          tempStr = `${Math.round(tVal)}°${unit}`;
          code = wData.current.weather_code ?? 0; weather.code = code;
          isDay = wData.current.is_day === 1; weather.isDay = isDay;
        }
      }
    } catch (_) {}

    if (!tempStr) {
      try {
        const r = await fetch(`https://wttr.in/${ck}?format=j1`);
        if (r.ok) {
          const cur = (await r.json())?.current_condition?.[0];
          const val = cur ? (unit === 'F' ? cur.temp_F : cur.temp_C) : undefined;
          if (val !== undefined) tempStr = `${Math.round(+val)}°${unit}`;
        }
      } catch (_) {}
    }

    const wmo = WMO_CODES[code] || { day: W_ICONS.sun, night: W_ICONS.moon, text: 'Clear' };
    weather.text = tempStr;
    weather.iconSvg = isDay ? wmo.day : wmo.night;
    weather.condition = wmo.text;
    weather.place = loc.city || '';
    if (!weather.text) weather.at = 0;
    try { localStorage.setItem('inex.weather.cached', JSON.stringify({ text: weather.text, iconSvg: weather.iconSvg, condition: weather.condition, place: weather.place, at: Date.now() })); } catch (_) {}
    renderWidgets();
  } finally {
    weather.busy = false;
  }
}

// bytes per second -> short text for the Net Speed widget: "512 K/s", "2.4 M/s", "12 M/s"
function fmtNet(b) {
  if (!(b > 0)) return '0 K/s';
  const k = b / 1024;
  if (k < 1000) return Math.round(k) + ' K/s';
  const m = k / 1024;
  return (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' M/s';
}

function widgetHtml(kind) {
  const s = appState.stats;
  switch (kind) {
    case 'weather': return SET.weather.enabled && weather.text ? `${getActiveWeatherIcon()}<span>${weather.text}</span>` : '';
    case 'ram': return s ? `RAM ${s.ram_pct}%` : '';
    case 'cpu': return s ? `CPU ${s.cpu_pct}%` : '';
    case 'gpu': return s ? `GPU ${s.gpu_pct ?? 0}%` : '';
    case 'disk': return s ? `Disk ${s.disk_pct}%` : '';
    case 'battery': return s && s.battery_pct >= 0 ? `${s.battery_pct}%` : '';
    case 'net': return appState.net ? `<span class="net2"><b>↓ ${fmtNet(appState.net[0])}</b><b>↑ ${fmtNet(appState.net[1])}</b></span>` : '';
    default: return '';
  }
}

function renderWidgets() {
  const left = widgetHtml(SET.widgets.left), right = widgetHtml(SET.widgets.right);
  const cTemp = document.getElementById('c-temp');
  const cRam = document.getElementById('c-ram');
  if (cTemp) cTemp.innerHTML = left;
  if (cRam) cRam.innerHTML = right;
  document.getElementById('c-left-box').classList.toggle('has-widget', !!left);
  document.getElementById('c-right-box').classList.toggle('has-widget', !!right);

  cTemp.title = SET.widgets.left === 'weather' && weather.place ? `Forecast • ${weather.place}` : '';
  cRam.title = SET.widgets.right === 'weather' && weather.place ? `Forecast • ${weather.place}` : '';

  const topLeft = document.getElementById('top-left-label');
  const calLeft = document.getElementById('cal-left-label');
  const topRam = document.getElementById('top-ram-label');
  const calRam = document.getElementById('cal-ram-label');
  if (topLeft) topLeft.innerHTML = left;
  if (calLeft) calLeft.innerHTML = left;
  if (topRam) topRam.innerHTML = right;
  if (calRam) calRam.innerHTML = right;
}

function batteryOverlays(stats) {
  if (!(stats.battery_pct >= 0)) return;            // desktop PC: no battery
  const g = SET.general;
  // charger plugged in / removed
  if (appState.prevCharging !== undefined && stats.charging !== appState.prevCharging && g.chargeToast) {
    if (stats.charging && hudCanShow()) {
      showDeviceHud({
        iconHTML: BOLT_SVG,
        battery: true,
        plain: true,
        accent: 'green',
        name: 'Charging',
        tag: `${stats.battery_pct}% • MagSafe Power`,
        pct: stats.battery_pct,
        ms: 3200
      });
    } else if (stats.charging) {
      showToast('bolt', `Charging ${stats.battery_pct}%`, 2400);
    } else if (hudCanShow()) {
      showDeviceHud({
        iconHTML: BATT_SVG,
        battery: true,
        plain: true,
        name: 'On Battery',
        tag: `${stats.battery_pct}% Remaining`,
        pct: stats.battery_pct,
        ms: 2800
      });
    } else {
      showToast('battery', `On battery ${stats.battery_pct}%`, 2400);
    }
  }
  appState.prevCharging = stats.charging;

  // low battery alert HUD
  const low = g.lowBatteryAlert && !stats.charging && stats.battery_pct <= g.lowBattery;
  if (low && !appState.lowShown) {
    if (hudCanShow()) {
      showDeviceHud({
        iconHTML: LOW_BATT_SVG,
        battery: true,
        plain: true,
        accent: stats.battery_pct <= 10 ? 'red' : 'amber',
        name: 'Low Battery',
        tag: `${stats.battery_pct}% • Connect to Power`,
        pct: stats.battery_pct,
        ms: 4000
      });
      appState.lowShown = true;
    } else if (showToast('low', `Low battery ${stats.battery_pct}%`, 4500)) {
      appState.lowShown = true;
    }
  }
  if (!low && (stats.charging || stats.battery_pct > g.lowBattery + 3)) appState.lowShown = false;
}

function setBtCaption(devices) {
  const first = (devices || []).find((d) => d.connected);
  let txt = appState.btRadio && first ? first.name : '';
  if (txt && SET.overlays.btBattery) {
    const pct = btBatteryFor(first.name);
    if (pct !== null) txt += ` • ${pct}%`;
  }
  document.getElementById('bt-cap').textContent = txt;
}
async function refreshBtCaption() {
  if (!slotRunning.has('bt')) return;
  if (!appState.btRadio) { setBtCaption([]); return; }
  setBtCaption(await invokeTauri('get_bt_devices'));
}
// Mic in-use dot. Rust (privacy.rs) watches Windows Core Audio capture sessions and sends
//   "privacy-changed" {kind: "mic", app: "<app name>" | null}
// This part only draws the dot. Setting: overlays.privacyDot
let privMic = null;                          // name of the app using it, or null
let privLast = null;                         // last on/off value sent to Rust

function renderPrivacyDot() {
  const el = document.getElementById('c-priv');
  if (!el) return;
  const on = !!(SET.overlays && SET.overlays.privacyDot);
  const mic = on ? privMic : null;
  const micEl = el.querySelector('.mic');
  if (micEl) micEl.classList.toggle('hidden', !mic);
  el.classList.toggle('hidden', !mic);
  el.title = mic ? `Microphone: ${mic}` : '';
}

onTauriEvent('privacy-changed', (event) => {
  const p = event.payload || {};
  if (p.kind === 'mic') privMic = p.app || null;
  renderPrivacyDot();
});

// Tell Rust when the setting turns on or off (the first call also starts the watcher thread).
async function applyPrivacy() {
  const on = !!(SET.overlays && SET.overlays.privacyDot);
  if (on !== privLast) {
    privLast = on;
    try {
      const r = await invokeTauri('privacy_watch_start', { enabled: on });
      privMic = typeof r === 'string' ? r : (Array.isArray(r) ? (r[0] || null) : null);
    } catch (_) { privLast = null; }
  }
  renderPrivacyDot();
}
// ==================== 14c. CLIPBOARD HISTORY SHELF ====================
const CLIPBOARD_STORAGE_KEY = 'inex.island.clipboard.v1';
let clipboardItems = [];

function loadClipboardHistory() {
  try {
    const raw = localStorage.getItem(CLIPBOARD_STORAGE_KEY);
    clipboardItems = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(clipboardItems)) clipboardItems = [];
  } catch (_) {
    clipboardItems = [];
  }
}

function saveClipboardHistory() {
  try {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(clipboardItems.slice(0, 25)));
  } catch (_) {}
}

function formatRelativeTime(ts) {
  if (!ts) return 'Just now';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 30) return 'Just now';
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function addClipboardText(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();
  if (!clean || clean.length < 1) return false;

  // Don't duplicate the top item
  if (clipboardItems.length > 0 && clipboardItems[0].text === clean) {
    return false;
  }

  // Remove existing match if already in list to bump to top
  const existIdx = clipboardItems.findIndex((it) => it.text === clean);
  if (existIdx >= 0) {
    clipboardItems.splice(existIdx, 1);
  }

  clipboardItems.unshift({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    text: clean,
    time: Date.now()
  });

  if (clipboardItems.length > 25) {
    clipboardItems = clipboardItems.slice(0, 25);
  }

  saveClipboardHistory();
  if (appState.currentView === 'view-clipboard') {
    renderClipboardList();
  }
  return true;
}

function renderClipboardList() {
  const container = document.getElementById('clipboard-list');
  if (!container) return;

  if (clipboardItems.length === 0) {
    container.innerHTML = `
      <div class="clipboard-empty">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none" opacity="0.4"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        <span>No copied text yet</span>
        <small style="opacity:0.4; font-size:9.5px;">Copy text anywhere (Ctrl+C)</small>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  clipboardItems.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'clipboard-item';
    card.title = 'Click to copy';

    const header = document.createElement('div');
    header.className = 'clipboard-item-header';

    const timeSpan = document.createElement('span');
    timeSpan.textContent = `${formatRelativeTime(item.time)} • ${item.text.length} chars`;

    const actions = document.createElement('div');
    actions.className = 'clipboard-item-actions';

    const copyTag = document.createElement('span');
    copyTag.className = 'clipboard-copy-tag';
    copyTag.textContent = 'Copied!';

    const delBtn = document.createElement('button');
    delBtn.className = 'clipboard-del-btn';
    delBtn.title = 'Remove';
    delBtn.innerHTML = '✕';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      clipboardItems = clipboardItems.filter((x) => x.id !== item.id);
      saveClipboardHistory();
      renderClipboardList();
    });

    actions.appendChild(copyTag);
    actions.appendChild(delBtn);
    header.appendChild(timeSpan);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'clipboard-item-text';
    body.textContent = item.text;

    card.appendChild(header);
    card.appendChild(body);

    card.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.text);
        card.classList.add('copied');
        showToast('snip', 'Copied to clipboard', 1200);
        setTimeout(() => { card.classList.remove('copied'); }, 1100);
      } catch (_) {
        showToast('snip', 'Copy failed', 1200);
      }
    });

    container.appendChild(card);
  });
}

async function checkSystemClipboard() {
  try {
    if (document.hasFocus() && navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) addClipboardText(text);
    }
  } catch (_) {}
}

function openClipboardView() {
  checkSystemClipboard().then(renderClipboardList);
}

// Initialise
loadClipboardHistory();

document.getElementById('btn-clipboard-clear')?.addEventListener('click', () => {
  if (clipboardItems.length === 0) return;
  clipboardItems = [];
  saveClipboardHistory();
  renderClipboardList();
  showToast('unlock', 'Clipboard cleared', 1200);
});

// Periodic and event-driven clipboard capture when user interacts
window.addEventListener('focus', checkSystemClipboard);
document.getElementById('island')?.addEventListener('mouseenter', checkSystemClipboard);

// System-wide copy -> little "Copied" popup in the island (Windows tells us the clipboard changed, no matter which app copied)
const CLIP_HUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path class="clip-tick" d="M8.5 14.5l2.5 2.5 4.5-5"/></svg>';
let clipHudAt = 0;

onTauriEvent('clipboard-copied', async () => {
  if (SET.general && SET.general.copyToast === false) return; // Strict toggle: OFF means do NOTHING!
  let text = await tryInvoke('get_clipboard_text', {});
  if (!text || typeof text !== 'string') {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch (_) {}
  }
  if (!text || typeof text !== 'string' || !text.trim()) return;
  addClipboardText(text);

  // our own copy buttons already show a toast; do not stack a second popup
  if (appState.toast || !(SET.general.copyToast !== false)) return;
  const now = Date.now();
  if (now - clipHudAt < 1200) return;
  clipHudAt = now;
  const one = text.replace(/\s+/g, ' ').trim();
  showDeviceHud({
    iconHTML: CLIP_HUD_SVG, plain: true,
    name: 'Copied',
    tag: one ? (one.length > 24 ? one.slice(0, 24) + '\u2026' : one) : 'Copied to Clipboard',
    ms: 1700
  });
});
let resizeDebounce = null;

function applySettings() {
  applyTheme(SET);
  applySlots();
  island.dataset.menu = SET.appearance.menuStyle;
  const validTheme = ['default', 'matrix'].includes(SET.appearance.themeStyle) ? SET.appearance.themeStyle : 'default';
  island.dataset.theme = validTheme;
  island.setAttribute('data-mode', SET.notch.mode);
  island.setAttribute('data-style', SET.notch.style || 'attached');
  island.setAttribute('data-theme', validTheme);
  if (SET.notch.mode !== 'smart') island.classList.remove('smart-hidden');
  
  const targetZoom = (SET.appearance.scale || 100) / 100;
  island.style.zoom = targetZoom;
  island.classList.toggle('no-anim', SET.appearance.animations === false);
  
  const isFloating = SET.notch && SET.notch.style === 'floating';
  if (appState.currentView === 'view-compact' || !appState.currentView) {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      invokeTauri('resize_island', { width: 265, height: isFloating ? 48 : 36 });
    }, 35);
  } else if (appState.lastWin) {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      invokeTauri('resize_island', appState.lastWin);
    }, 35);
  }
  renderQuickActionTiles();
  document.getElementById('view-media').classList.toggle('no-ambient', !SET.notch.ambientGlow);
  document.getElementById('c-media-btn').classList.toggle('glow', SET.notch.compactGlow);
  if (SET.share.deviceName) myDeviceName = SET.share.deviceName;
  updateClocks();
  renderWidgets();
  if (typeof syncLoadTimer === 'function') syncLoadTimer();
  applyPrivacy();
  refreshWeather();
  syncEq();
  refreshMedia();
}

onSettings((incoming) => { SET = incoming; applySettings(); pollSystemAndMedia(); });
applySettings();
// Weather: one request every 12 min. After a failure wait longer each time (2, 4, 8 ... up to 15 min).
let weatherTimer = null, weatherFails = 0;
function nextWeatherDelay() {
  if (weather.text) { weatherFails = 0; return 12 * 60 * 1000; }
  weatherFails = Math.min(weatherFails + 1, 6);
  return Math.min(15 * 60 * 1000, 2 * 60 * 1000 * Math.pow(2, weatherFails - 1));
}
function scheduleWeather(ms) {
  clearTimeout(weatherTimer);
  weatherTimer = setTimeout(async () => {
    if (!document.hidden) await refreshWeather();
    scheduleWeather(nextWeatherDelay());
  }, ms);
}
scheduleWeather(12 * 60 * 1000);
// back on screen after a long pause: refresh (refreshWeather keeps its own 10 min cache)
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshWeather(); });

// ---- Intro animation: wait until Rust has placed + shown the window, then play it ----
(function introAnimation() {
  let played = false;
  const play = () => {
    if (played) return;
    played = true;
    island.classList.remove('intro-pre');
    island.classList.add('intro-play');
    const done = () => island.classList.remove('intro-play');
    island.addEventListener('animationend', done, { once: true });
    setTimeout(done, 1500);
  };
  (async () => {
    if (!(window.__TAURI__ && window.__TAURI__.core)) { play(); return; }
    for (let i = 0; i < 150; i++) {            // up to ~18 s (slow boots)
      try {
        if (await window.__TAURI__.core.invoke('island_visible')) { play(); return; }
      } catch (e) { break; }
      await new Promise((r) => setTimeout(r, 120));
    }
    play();                                     // never leave the island invisible
  })();
})();

// Background Auto-Update check (runs ~25s after boot if Auto Update is enabled)
setTimeout(async () => {
  if (!SET.general?.autoUpdate) return;
  try {
    const res = await invokeTauri('check_update');
    if (res && res.available && res.latest_version) {
      showToast('spark', `Update v${res.latest_version} available! Open Settings`, 6000);
    }
  } catch (_) {}
}, 25000);

// ==================== 11. CLOCK ALARMS (quick tile "Alarm") ====================
// Alarms live in localStorage ("inex.alarms.v1"): [{ id, h, m, on, daily }]  (h = 0-23).
// A once-alarm switches itself off after it rang. Snooze rings again after 9 minutes.
const ALARM_KEY = 'inex.alarms.v1';
const ALARM_SNOOZE_MS = 9 * 60 * 1000;
let alarms = [];
try { const a = JSON.parse(localStorage.getItem(ALARM_KEY) || '[]'); if (Array.isArray(a)) alarms = a.filter((x) => x && Number.isFinite(x.h) && Number.isFinite(x.m)); } catch (_) {}
let alarmPick = { h: 7, m: 30, daily: false };
let alarmSnoozeAt = 0;          // ms timestamp, 0 = no snooze pending
let alarmLastFired = '';        // "<id>@<yyyy-mm-dd hh:mm>": never ring twice in one minute

function saveAlarms() {
  try { localStorage.setItem(ALARM_KEY, JSON.stringify(alarms)); } catch (_) {}
  scheduleNextAlarm();
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtAlarmTime(h, m) {
  if (SET.general && SET.general.hour24) return `${pad2(h)}:${pad2(m)}`;
  return `${((h + 11) % 12) + 1}:${pad2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
function nextAlarmMs(a, from) {
  const d = new Date(from); d.setHours(a.h, a.m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function renderAlarmPicker() {
  const h24 = !!(SET.general && SET.general.hour24);
  const hh = h24 ? alarmPick.h : ((alarmPick.h + 11) % 12) + 1;
  document.getElementById('alarm-pick-h').textContent = pad2(hh);
  document.getElementById('alarm-pick-m').textContent = pad2(alarmPick.m);
  const ap = document.getElementById('alarm-pick-ampm');
  ap.classList.toggle('hidden', h24);
  ap.textContent = alarmPick.h >= 12 ? 'PM' : 'AM';
  document.getElementById('alarm-pick-daily').classList.toggle('on', alarmPick.daily);
}
function renderAlarmList() {
  const list = document.getElementById('alarm-list');
  if (!list) return;
  list.innerHTML = '';
  if (!alarms.length) {
    list.innerHTML = '<div class="empty-hint">No alarms yet. Pick a time and tap Add.</div>';
  }
  [...alarms].sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m)).forEach((a) => {
    const row = document.createElement('div');
    row.className = 'alarm-row' + (a.on ? '' : ' off');
    const t = document.createElement('div');
    t.className = 'alarm-row-time';
    t.textContent = fmtAlarmTime(a.h, a.m);
    const sub = document.createElement('small');
    sub.textContent = a.daily ? 'Every day' : 'Once';
    t.appendChild(sub);
    const sw = document.createElement('label');
    sw.className = 'ios-switch';
    sw.innerHTML = '<input type="checkbox"><span class="slider"></span>';
    const cb = sw.querySelector('input');
    cb.checked = !!a.on;
    cb.addEventListener('change', () => { a.on = cb.checked; saveAlarms(); renderAlarmList(); });
    const del = document.createElement('button');
    del.className = 'alarm-del';
    del.title = 'Delete';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    del.addEventListener('click', () => { alarms = alarms.filter((x) => x !== a); saveAlarms(); renderAlarmList(); });
    row.append(t, sw, del);
    list.appendChild(row);
  });
  const lbl = document.getElementById('alarm-next-label');
  if (lbl) {
    const now = Date.now();
    const next = alarms.filter((a) => a.on).map((a) => nextAlarmMs(a, now)).sort((a, b) => a - b)[0];
    if (next) {
      const mins = Math.max(1, Math.round((next - now) / 60000));
      lbl.textContent = mins >= 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${mins}m`;
    } else lbl.textContent = '';
  }
}
function openAlarmView() { renderAlarmPicker(); renderAlarmList(); }

function alarmStep(kind) {
  if (kind === 'h+') alarmPick.h = (alarmPick.h + 1) % 24;
  else if (kind === 'h-') alarmPick.h = (alarmPick.h + 23) % 24;
  else if (kind === 'm+') alarmPick.m = (alarmPick.m + 1) % 60;
  else if (kind === 'm-') alarmPick.m = (alarmPick.m + 59) % 60;
  renderAlarmPicker();
}
document.querySelectorAll('#view-alarm .alarm-step').forEach((b) => {
  // tap = one step, hold = keeps stepping
  let rep = null, hold = null;
  const stop = () => { clearTimeout(hold); clearInterval(rep); };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    alarmStep(b.dataset.step);
    hold = setTimeout(() => { rep = setInterval(() => alarmStep(b.dataset.step), 70); }, 380);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
});
document.getElementById('alarm-pick-ampm')?.addEventListener('click', () => { alarmPick.h = (alarmPick.h + 12) % 24; renderAlarmPicker(); });
document.getElementById('alarm-pick-daily')?.addEventListener('click', () => { alarmPick.daily = !alarmPick.daily; renderAlarmPicker(); });
document.getElementById('alarm-add')?.addEventListener('click', () => {
  if (alarms.length >= 12) { showToast('done', 'Max 12 alarms', 1400); return; }
  const dup = alarms.find((a) => a.h === alarmPick.h && a.m === alarmPick.m && !!a.daily === alarmPick.daily);
  if (dup) dup.on = true;
  else alarms.push({ id: Date.now().toString(36), h: alarmPick.h, m: alarmPick.m, on: true, daily: alarmPick.daily });
  saveAlarms();
  renderAlarmList();
});

function ringClockAlarm(a, snoozed) {
  triggerTimerAlarm({
    title: snoozed ? 'Snoozed alarm' : 'Alarm',
    sub: a ? fmtAlarmTime(a.h, a.m) : 'Wake up',
    snooze: true,
    ms: 60000
  });
  appState.lastRungAlarm = a || null;
}
function snoozeClockAlarm() {
  alarmSnoozeAt = Date.now() + ALARM_SNOOZE_MS;
  scheduleNextAlarm();
}

let alarmTimer = null;
function scheduleNextAlarm() {
  if (alarmTimer) {
    clearTimeout(alarmTimer);
    alarmTimer = null;
  }
  const now = Date.now();

  if (alarmSnoozeAt && alarmSnoozeAt > now) {
    const diff = Math.max(50, alarmSnoozeAt - now);
    alarmTimer = setTimeout(() => {
      alarmSnoozeAt = 0;
      ringClockAlarm(appState.lastRungAlarm, true);
      scheduleNextAlarm();
    }, diff);
    return;
  }

  const active = alarms.filter((a) => a.on);
  if (!active.length) return; // 0 active alarms = 0 timers, 0% CPU!

  const nowDate = new Date();
  let minDiff = Infinity;
  let target = null;
  for (const a of active) {
    const diff = nextAlarmMs(a, nowDate) - now;
    if (diff > 0 && diff < minDiff) {
      minDiff = diff;
      target = a;
    }
  }

  if (target && minDiff < Infinity) {
    alarmTimer = setTimeout(() => {
      const cur = new Date();
      const currentH = cur.getHours();
      const currentM = cur.getMinutes();
      const stamp = `${cur.getFullYear()}-${cur.getMonth()}-${cur.getDate()} ${currentH}:${currentM}`;
      const key = `${target.id}@${stamp}`;
      if (alarmLastFired !== key) {
        alarmLastFired = key;
        if (!target.daily) {
          target.on = false;
          saveAlarms();
          if (appState.currentView === 'view-alarm') renderAlarmList();
        }
        ringClockAlarm(target, false);
      }
      scheduleNextAlarm();
    }, minDiff);
  }
}
scheduleNextAlarm();

// Catch missed alarms if PC was sleeping/hibernating and wakes up
onTauriEvent('system-resumed', () => {
  const now = new Date();
  const currentH = now.getHours();
  const currentM = now.getMinutes();
  for (const a of alarms) {
    if (!a.on) continue;
    if (a.h === currentH && a.m === currentM) {
      ringClockAlarm(a, false);
      if (!a.daily) {
        a.on = false;
        saveAlarms();
        if (appState.currentView === 'view-alarm') renderAlarmList();
      }
    }
  }
  scheduleNextAlarm();
});

// ==================== 12. CAPS LOCK / NUM LOCK INDICATOR ====================
// Rust (lock-keys-changed event) sends native Win32 low-level keyboard notifications with 0% polling.
const CAPS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 5 12h4v4h6v-4h4z"/><line x1="9" y1="20" x2="15" y2="20"/></svg>';
const NUM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M9 8v4M9 8l-1 1M14.5 8h1.5v8"/><path d="M8 16h2"/></svg>';

onTauriEvent('lock-keys-changed', (event) => {
  const g = SET.general || {};
  const payload = (event && event.payload) || {};
  const { caps, num, changed } = payload;
  if (changed === 'caps') {
    if (!g.capsToast) return; // Strict setting: OFF means do NOTHING!
    showDeviceHud({ iconHTML: CAPS_SVG, plain: !caps, accent: caps ? 'blue' : '', name: 'Caps Lock', tag: caps ? 'On' : 'Off', ms: 1500 });
  } else if (changed === 'num') {
    if (!g.numToast) return; // Strict setting: OFF means do NOTHING!
    showDeviceHud({ iconHTML: NUM_SVG, plain: !num, accent: num ? 'blue' : '', name: 'Num Lock', tag: num ? 'On' : 'Off', ms: 1500 });
  }
});

// ==================== 13. DOWNLOAD PROGRESS / COMPLETE HUD ====================
// Rust (downloads-changed event) sends native Win32 directory change notifications with 0% polling.
const DL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';
const DL_DONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
const dlTrack = new Map();       // partial file name -> { size, changedAt, firstAt }
const dlSeenRecent = new Set();
let dlSeeded = false;
let dlOpenName = null;           // finished file the HUD would open on click
let dlScanBusy = false;

function dlSize(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}
function dlClean(name) {
  const n = name.replace(/\.(crdownload|part|opdownload|download|partial)$/i, '');
  return /^unconfirmed \d+/i.test(n) ? 'New download' : n;
}

async function handleDownloadsChanged() {
  if (dlScanBusy) return;
  if (!(SET.general && SET.general.downloadHud)) {
    island.classList.remove('dl-active'); dlTrack.clear(); dlSeeded = false; return;
  }
  dlScanBusy = true;
  try {
    const r = await tryInvoke('downloads_scan', {});
    if (!r || !Array.isArray(r.partials)) return;
    const now = Date.now();
    const cur = new Set();
    let started = null;
    for (const f of r.partials) {
      cur.add(f.name);
      const t = dlTrack.get(f.name);
      if (!t) {
        dlTrack.set(f.name, { size: f.size, changedAt: now, firstAt: now });
        if (dlSeeded && f.age_secs <= 15 && !started) started = f;
      } else if (f.size !== t.size) { t.size = f.size; t.changedAt = now; }
    }
    // vanished partial = finished (or cancelled): finished only if a fresh file appeared
    let finished = null;
    for (const [name, t] of [...dlTrack]) {
      if (cur.has(name)) continue;
      dlTrack.delete(name);
      if (!dlSeeded || now - t.firstAt < 1000) continue;
      const base = dlClean(name).toLowerCase();
      const fresh = (r.recent || []).filter((f) => f.age_secs <= 20 && !dlSeenRecent.has(f.name));
      finished = fresh.find((f) => f.name.toLowerCase() === base) || fresh[0] || null;
    }
    (r.recent || []).forEach((f) => dlSeenRecent.add(f.name));
    if (dlSeenRecent.size > 400) dlSeenRecent.clear();
    dlSeeded = true;

    const active = [...dlTrack.values()].some((t) => now - t.changedAt < 4000);
    island.classList.toggle('dl-active', active && appState.currentView === 'view-compact');

    if (finished) {
      dlOpenName = finished.name;
      showDeviceHud({ iconHTML: DL_DONE_SVG, plain: true, accent: 'ok', name: finished.name, tag: `Download Complete • ${dlSize(finished.size)}`, ms: 4200 });
    } else if (started) {
      showDeviceHud({ iconHTML: DL_SVG, plain: true, accent: 'blue', name: dlClean(started.name), tag: `Downloading • ${dlSize(started.size)}`, ms: 2200 });
    }
  } finally {
    dlScanBusy = false;
  }
}
onTauriEvent('downloads-changed', handleDownloadsChanged);
document.getElementById('c-bt-hud')?.addEventListener('click', (e) => {
  if (!dlOpenName || !island.classList.contains('bt-hud-active')) return;
  if (!document.getElementById('bt-hud-name') || document.getElementById('bt-hud-name').textContent !== dlOpenName) return;
  e.stopPropagation();
  invokeTauri('open_download', { name: dlOpenName });
});
