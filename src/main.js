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
    click: () => invokeTauri('launch_notepad')
  }
};

function applySlots() {
  let a = SET.slots && SET.slots.a;
  let b = SET.slots && SET.slots.b;
  if (!SLOT_DEFS[a]) a = 'wifi';
  if (!SLOT_DEFS[b]) b = 'bt';
  if (a === b) b = a === 'bt' ? 'wifi' : 'bt';
  const want = new Set([a, b]);
  // grid order: slot A, P2P, slot B, Tray  (same 2x2 layout as before)
  document.getElementById('tile-p2p').style.order = 2;
  document.getElementById('tile-tray').style.order = 4;
  Object.entries(SLOT_DEFS).forEach(([id, def]) => {
    const tile = document.getElementById(def.el);
    const on = want.has(id);
    tile.classList.toggle('hidden', !on);
    if (on) tile.style.order = id === a ? 1 : 3;
    if (on && !slotRunning.has(id)) { slotRunning.add(id); def.start(); }
    if (!on && slotRunning.has(id)) { slotRunning.delete(id); def.stop(); }
  });
}

// Microphone slot: real system mute of the default capture device
async function refreshMic() {
  const m = await invokeTauri('get_mic_muted');
  const t = document.getElementById('tile-mic');
  const none = m === null || m === undefined;
  t.classList.toggle('muted', m === true);
  t.classList.toggle('active', m === false);
  document.getElementById('mic-sub').textContent = none ? 'No mic' : m ? 'Muted' : 'On';
  document.getElementById('mic-cap').textContent = none ? 'No mic' : m ? 'Muted' : '';
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
}

function openMedia() {
  switchView('view-media', 'state-media', 316, appState.volOpen ? MEDIA_H_VOL : MEDIA_H);
  island.classList.toggle('vol-open', appState.volOpen);
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
    document.getElementById('c-clock').textContent = str;
  }
  document.getElementById('ctrl-clock-tab').textContent = `‹ ${str} ›`;
  document.getElementById('cal-back-clock').textContent = `‹ ${str} ›`;
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
  const curTimeEl = document.getElementById('m-cur-time');
  const totTimeEl = document.getElementById('m-tot-time');
  const progFillEl = document.getElementById('m-prog-fill');
  const sliderEl = document.getElementById('m-seek-slider');

  if (curTimeEl) curTimeEl.textContent = fmtTime(pos);
  if (totTimeEl) totTimeEl.textContent = dur > 0 ? `-${fmtTime(dur - pos)}` : '--:--';
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  if (progFillEl) progFillEl.style.width = `${pct}%`;
  if (sliderEl && !appState.mediaSeeking) {
    sliderEl.value = Math.round(pct * 10);
  }
}

// Tick media progress smoothly every 250ms (no backwards snapping)
setInterval(() => {
  if (appState.mediaPlaying && !appState.mediaSeeking && appState.mediaDuration > 0) {
    renderMediaProgress();
  }
}, 250);

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

setInterval(updateClocks, 1000);
updateClocks();

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

let pollBusy = false;
async function pollLight() {
  if (document.hidden || pollBusy) return;
  pollBusy = true;
  try { await refreshStats(); } finally { pollBusy = false; }
}
setInterval(pollLight, 3000);
// safety nets only (the events below do the real work)
setInterval(() => { if (!document.hidden) refreshRadios(); }, 30000);
setInterval(() => { if (!document.hidden && appState.mediaPlaying) refreshMedia(); }, 2000);
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

// 3. Compact Bar Clicks
document.getElementById('c-center-trigger').addEventListener('click', (e) => {
  if (e.target.closest('#c-incoming-alert')) return;
  switchView('view-control', 'state-control', 316, 256);
  refreshBtCaption();
  if (slotRunning.has('mic')) refreshMic();
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
document.getElementById('ctrl-clock-tab').addEventListener('click', () => {
  if (!SET.notch.calendarTimer) return;
  switchView('view-calendar', 'state-calendar', 346, 210);
});
document.getElementById('cal-back-clock').addEventListener('click', () => {
  switchView('view-control', 'state-control', 316, 256);
});

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
onTauriEvent('bluetooth-changed', () => {
  clearTimeout(btEvT);
  btEvT = setTimeout(() => {
    refreshBtCaption();
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

document.getElementById('tile-p2p').addEventListener('click', () => {
  switchView('view-p2p', 'state-sub', 316, 208);
});
document.getElementById('tile-tray').addEventListener('click', openTrayView);

document.querySelectorAll('.back-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchView('view-control', 'state-control', 316, 256);
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

// 5. Quick Action Row
document.getElementById('act-settings').addEventListener('click', () => invokeTauri('open_settings'));
// Keep screen awake (replaces the old Do Not Disturb button). One parked thread in Rust, 0 % CPU.
document.getElementById('act-awake').addEventListener('click', async () => {
  const btn = document.getElementById('act-awake');
  const want = !btn.classList.contains('active');
  const on = await invokeTauri('set_keep_awake', { on: want });
  btn.classList.toggle('active', on === true);
  btn.title = on === true ? 'Keep screen awake: ON' : 'Keep screen awake: off';
});
document.getElementById('act-timer').addEventListener('click', () => {
  switchView('view-calendar', 'state-calendar', 346, 210);
});
document.getElementById('act-snip').addEventListener('click', () => {
  goCompact();
  invokeTauri('take_snip');
});
document.getElementById('act-lock').addEventListener('click', () => invokeTauri('lock_screen'));

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
document.getElementById('m-bt-btn').addEventListener('click', () => openBtView());
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

document.getElementById('btn-gen-code').addEventListener('click', async () => {
  appState.isCodeHost = true;
  appState.manuallyDisconnected.clear();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  document.getElementById('btn-gen-code').classList.add('hidden');
  const badge = document.getElementById('code-display-box');
  badge.classList.remove('hidden');
  document.getElementById('my-p2p-code').textContent = code;
  document.getElementById('btn-exit-room')?.classList.remove('hidden');
  await startFirebaseSignalingRoom(code, true);
});

document.getElementById('code-display-box').addEventListener('click', () => {
  const code = document.getElementById('my-p2p-code').textContent;
  navigator.clipboard?.writeText(code);
});

document.getElementById('btn-join-code').addEventListener('click', async () => {
  appState.isCodeHost = false;
  appState.manuallyDisconnected.clear();
  const code = document.getElementById('input-peer-code').value.trim();
  if (code.length < 4) return;
  document.getElementById('btn-exit-room')?.classList.remove('hidden');
  await startFirebaseSignalingRoom(code, false);
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
  document.getElementById('tile-p2p').classList.toggle('offer', pending);
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
    exitBtn.classList.toggle('hidden', !appState.roomCode);
  }
  const count = appState.peers.length;
  const listEl = document.getElementById('p2p-peers-list');
  const badge = document.getElementById('c-peer-badge');
  const countSpan = document.getElementById('c-peer-count');
  const tileP2P = document.getElementById('tile-p2p');

  document.getElementById('tile-p2p-sub').textContent = `${count}/5 Peers`;
  document.getElementById('p2p-cap').textContent = count > 0 ? `${count} peer${count > 1 ? 's' : ''}` : '';
  tileP2P.classList.toggle('active', count > 0);

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
    listEl.innerHTML = `<div class="empty-hint">${msg}</div>`;
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
  island.classList.toggle('transferring', busy);
  document.getElementById('c-clock').classList.toggle('hidden', busy);
  document.getElementById('c-transfer-anim').classList.toggle('hidden', !(appState.transferring && !isPrompt && !toast));
  document.getElementById('c-prompt-anim').classList.toggle('hidden', !(isPrompt && !toast));
  document.getElementById('c-toast').classList.toggle('hidden', !toast);
  updateCompactStateClasses();
}

// ---- Short status popups: charger, low battery, unlock ----
const SVG_A = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">';
const TOAST_ICONS = {
  unlock: SVG_A + '<rect x="4" y="11" width="16" height="10" rx="2"/><path class="lock-shackle" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  lock: SVG_A + '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  face: SVG_A + '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><path d="M10 15c.8.7 1.8 1 2 1s1.2-.3 2-1"/></svg>',
  fingerprint: SVG_A + '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .13-5.35 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/><path d="M17 19a10 10 0 0 1-5 2"/><path d="M18.7 18.2a12 12 0 0 0 1.3-4.2"/></svg>',
  bolt: SVG_A + '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  battery: SVG_A + '<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/></svg>',
  low: SVG_A + '<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="10" x2="6" y2="14"/></svg>'
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

// Inex App Locker / Biometric Unlock Pipe Listener
let lockerWrongTimer = null;
let lockerGlowTimer = null;
let lockerPromptSafetyTimer = null;

onTauriEvent('locker-unlock', (event) => {
  let payload = event.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) {}
  }
  if (!payload || typeof payload !== 'object') payload = {};

  const evName = payload.event || (payload.type ? 'locker_unlock' : '');

  if (evName === 'locker_prompt') {
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

    clearTimeout(lockerPromptSafetyTimer);
    lockerPromptSafetyTimer = setTimeout(() => {
      if (appState.lockerPrompting) {
        appState.lockerPrompting = false;
        renderCenter();
      }
    }, 12000);
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
    const kind = payload.type === 'face' ? 'face' : payload.type === 'fingerprint' ? 'fingerprint' : 'unlock';
    const targetName = payload.target ? `${payload.target} Unlocked` : 'Unlocked';

    renderCenter();
    showToast(kind, targetName, 1400);

    clearTimeout(lockerGlowTimer);
    lockerGlowTimer = setTimeout(() => {
      island.classList.remove('island-locker-glow');
    }, 1400);
  }
});

function startCompactTransferUI() {
  appState.transferring = true;
  document.getElementById('c-transfer-pct').textContent = '0%';
  renderCenter();
}

function updateCompactTransferPct(pct) {
  document.getElementById('c-transfer-pct').textContent = `${pct}%`;
}

function finishCompactTransferUI() {
  appState.transferring = false;
  endTransferStats();
  renderCenter();
  updateClocks();
  refreshMedia();
}

// Windows password / PIN / credential prompts -> lock animation in the notch
async function pollNativePrompt() {
  const r = await tryInvoke('native_prompt', {});
  const on = r === 'password';
  if (on !== appState.prompting) {
    appState.prompting = on;
    renderCenter();
    if (!on) {
      updateClocks();
      // the prompt closed (if an explicit locker-unlock toast is already showing, don't overwrite it)
      if (SET.general.lockToast && !appState.toast && !appState.lockerPrompting) showToast('unlock', 'Done', 1500);
    }
  }
}
setInterval(pollNativePrompt, 400);

// Windows lock screen (Win+L, Dynamic Lock, idle lock): when the PC is unlocked, play the unlock animation
let lockPrev = null;
async function pollLock() {
  const r = await tryInvoke('is_session_locked', {});
  if (typeof r !== 'boolean') return;
  if (lockPrev === true && r === false && SET.general.lockToast) showToast('unlock', 'Unlocked', 1900);
  lockPrev = r;
}
setInterval(pollLock, 1200);


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

// 10. Focus Timer + Reset Button
function formatTimerDisplay() {
  const m = String(Math.floor(appState.timerSeconds / 60)).padStart(2, '0');
  const s = String(appState.timerSeconds % 60).padStart(2, '0');
  document.getElementById('timer-display').textContent = `${m} : ${s}`;
  if (appState.timerRunning && !appState.transferring) {
    document.getElementById('c-clock').textContent = `${m}:${s}`;
  }
}

document.getElementById('btn-timer-toggle').addEventListener('click', function () {
  appState.timerRunning = !appState.timerRunning;
  this.textContent = appState.timerRunning ? '⏸ Pause' : '▶ Start';
  document.getElementById('act-timer').classList.toggle('active', appState.timerRunning);

  if (appState.timerRunning) {
    appState.timerInterval = setInterval(() => {
      if (appState.timerSeconds > 0) {
        appState.timerSeconds--;
        formatTimerDisplay();
      } else {
        clearInterval(appState.timerInterval);
        appState.timerRunning = false;
        document.getElementById('btn-timer-toggle').textContent = '▶ Start';
        document.getElementById('act-timer').classList.remove('active');
        if (SET.notch.timerSound) chime();
        setTimeout(updateClocks, 2000);
      }
    }, 1000);
  } else {
    clearInterval(appState.timerInterval);
    updateClocks();
  }
});

document.getElementById('btn-timer-reset').addEventListener('click', () => {
  clearInterval(appState.timerInterval);
  appState.timerRunning = false;
  appState.timerSeconds = appState.timerPresetMins * 60;
  document.getElementById('btn-timer-toggle').textContent = '▶ Start';
  document.getElementById('act-timer').classList.remove('active');
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
  document.getElementById('act-timer').classList.remove('active');
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

// Real 5-Band Audio Visualizer (WASAPI Loopback + FFT ~32ms Event-Driven)
const cEqBars = [...document.querySelectorAll('#c-eq span')];
const mEqBars = [...document.querySelectorAll('#m-eq-bars span')];
let lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
let currentHeightsC = [2, 2, 2, 2, 2];
let currentHeightsM = [2, 2, 2, 2, 2];
var eqRaf = 0; // var: referenced by refreshMedia() before this line runs
let eqQuietCount = 0;
const eqCompact = document.getElementById('c-eq');

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
  }
});

function eqDraw() {
  const sens = (SET.notch.eqSensitivity || 100) / 100;
  const isPlaying = appState.mediaPlaying;

  cEqBars.forEach((bar, i) => {
    let target = 2;
    if (isPlaying) {
      if (SET.notch.eqSync) {
        const val = lastFrequencies[i] ?? 0.18;
        const bandBoost = i === 4 ? 1.55 : (i === 3 ? 1.35 : (i === 2 ? 1.12 : 1.0));
        const norm = Math.max(0, (val - 0.18) / 0.82) * sens * bandBoost;
        target = 2 + Math.min(1, norm) * 10;
      } else {
        const t = performance.now();
        target = 2 + (0.55 + 0.35 * Math.sin(t / 260 + i * 1.5)) * 10;
      }
    }
    currentHeightsC[i] += (target - currentHeightsC[i]) * 0.45;
    bar.style.height = currentHeightsC[i].toFixed(1) + 'px';
  });

  mEqBars.forEach((bar, i) => {
    let target = 2;
    if (isPlaying) {
      if (SET.notch.eqSync) {
        const val = lastFrequencies[i] ?? 0.18;
        const bandBoost = i === 4 ? 1.55 : (i === 3 ? 1.35 : (i === 2 ? 1.12 : 1.0));
        const norm = Math.max(0, (val - 0.18) / 0.82) * sens * bandBoost;
        target = 2 + Math.min(1, norm) * 18;
      } else {
        const t = performance.now();
        target = 2 + (0.55 + 0.35 * Math.sin(t / 260 + i * 1.5)) * 18;
      }
    }
    currentHeightsM[i] += (target - currentHeightsM[i]) * 0.45;
    bar.style.height = currentHeightsM[i].toFixed(1) + 'px';
  });

  if (!isPlaying && currentHeightsC.every((h) => h < 2.1) && currentHeightsM.every((h) => h < 2.1)) {
    eqRaf = 0;
    return;
  }
  eqRaf = requestAnimationFrame(eqDraw);
}

// Start/stop visualizer and animation loop based on playback state
function syncEq() {
  const active = appState.mediaPlaying && SET.notch && SET.notch.eqSync;
  invokeTauri('set_visualizer_active', { active }).catch(() => {});
  if (appState.mediaPlaying) {
    if (!eqRaf) eqRaf = requestAnimationFrame(eqDraw);
  } else {
    lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
    if (!eqRaf) eqRaf = requestAnimationFrame(eqDraw);
  }
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175, 1568].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.start(t0); o.stop(t0 + 0.55);
    });
  } catch (_) {}
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
      const res = await fetch('http://ip-api.com/json/?fields=status,lat,lon,city,country');
      if (res.ok) {
        const d = await res.json();
        if (d && d.lat && d.lon) return { lat: +d.lat, lon: +d.lon, city: d.city || '' };
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
          code = wData.current.weather_code ?? 0;
          isDay = wData.current.is_day === 1;
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

function widgetHtml(kind) {
  const s = appState.stats;
  switch (kind) {
    case 'weather': return SET.weather.enabled && weather.text ? `${weather.iconSvg || W_ICONS.sun}<span>${weather.text}</span>` : '';
    case 'ram': return s ? `RAM ${s.ram_pct}%` : '';
    case 'cpu': return s ? `CPU ${s.cpu_pct}%` : '';
    case 'disk': return s ? `Disk ${s.disk_pct}%` : '';
    case 'battery': return s && s.battery_pct >= 0 ? `${s.battery_pct}%` : '';
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
    if (stats.charging) showToast('bolt', `Charging ${stats.battery_pct}%`, 2400);
    else showToast('battery', `On battery ${stats.battery_pct}%`, 2400);
  }
  appState.prevCharging = stats.charging;
  // low battery
  const low = g.lowBatteryAlert && !stats.charging && stats.battery_pct <= g.lowBattery;
  if (low && !appState.lowShown) {
    if (showToast('low', `Low battery ${stats.battery_pct}%`, 4500)) appState.lowShown = true;
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

let resizeDebounce = null;

function applySettings() {
  applyTheme(SET);
  applySlots();
  island.dataset.menu = SET.appearance.menuStyle;
  island.setAttribute('data-mode', SET.notch.mode);
  island.setAttribute('data-style', SET.notch.style || 'attached');
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
  document.getElementById('act-timer').classList.toggle('hidden', !SET.notch.calendarTimer);
  document.getElementById('view-media').classList.toggle('no-ambient', !SET.notch.ambientGlow);
  document.getElementById('c-media-btn').classList.toggle('glow', SET.notch.compactGlow);
  if (SET.share.deviceName) myDeviceName = SET.share.deviceName;
  updateClocks();
  renderWidgets();
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
