// GENERATED from main-parts/*.js by scripts/build-main.mjs. Edit the parts, not this file.
import { load as loadSettings, save as saveSettings, subscribe as onSettings, applyTheme, menuSurface } from './shared.js';

let SET = loadSettings();
applyTheme(SET);

const CODE_TTL_MS = 3 * 60 * 1000; // a host / reply code stays valid for 3 minutes
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
  peers: [], // Connected WebRTC peers: [{ id, name }]
  traySelect: null, // { peerId, picked:Set } while choosing which tray files to send
  draggingOut: false,
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

let currentMacSubTarget = null;
function isBtViewOpen() {
  return appState.currentView === 'view-bt' || (currentMacSubTarget && currentMacSubTarget.id === 'view-bt');
}
function isWifiViewOpen() {
  return appState.currentView === 'view-wifi' || (currentMacSubTarget && currentMacSubTarget.id === 'view-wifi');
}

// WebRTC Connection Store: peerId -> { pc, dc, name, makingOffer, outgoingQueue }
const rtcPeers = new Map();

// Nominal island width of the wide views (Mac menu, compact bar with ears): 500px menu + 2×17px ears + safety margin.
// Only used as the size reported to Rust (clickable area); the OS window itself is fixed.
const ISLAND_WIN_W = 548;
const MEDIA_H = 166;
const MEDIA_H_VOL = 198;

// The OS window is made ONE big transparent size by Rust at startup and is never resized again; the island
// animates purely in CSS. reportIslandSize() only tells Rust how big the island is (logical px x UI scale), and
// Rust uses that rectangle to let clicks pass through to the apps underneath everywhere else.
async function invokeTauri(cmd, args = {}) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  return null;
}

function reportIslandSize(size) {
  appState.islandSize = { width: size.width, height: size.height };
  const k = SET.appearance.scale / 100;
  return invokeTauri('set_island_hit', { width: Math.round(size.width * k), height: Math.round(size.height * k) }).catch(() => {});
}

function playStatusSound(category, kind) {
  const s = SET.sounds;
  if (s && s.enabled === false) return;
  if (s && category && s[category] === false) return;
  invokeTauri('play_status_sound', { kind: kind || category }).catch(() => {});
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
      if (typeof dropTileClick === 'function') dropTileClick();
      else switchView('view-inexdrop', 'state-sub', 316, 208);
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
  if (SET.appearance && SET.appearance.menuLayout === 'mac') {
    want.add('wifi');
    want.add('bt');
  }

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
let micMutedState = null;
function renderMic(m) {
  micMutedState = m;
  const none = m === null || m === undefined;
  const t = document.getElementById('tile-mic');
  if (t) {
    t.classList.toggle('muted', m === true);
    t.classList.toggle('active', m === false);
    document.getElementById('mic-sub').textContent = none ? 'No mic' : m ? 'Muted' : 'On';
    document.getElementById('mic-cap').textContent = none ? 'No mic' : m ? 'Muted' : '';
  }
  // Mac menu mic tile
  const mt = document.getElementById('mac-tile-mic');
  if (mt) {
    mt.classList.toggle('muted', m === true);
    mt.classList.toggle('active', m === false);
    const ms = document.getElementById('mac-mic-sub');
    if (ms) ms.textContent = none ? 'No mic' : m ? 'Muted' : 'On';
  }
}
async function refreshMic() {
  renderMic(await invokeTauri('get_mic_muted'));
}
async function toggleMic() {
  await invokeTauri('set_mic_muted', { muted: micMutedState !== true });
  refreshMic();
}
document.getElementById('tile-mic').addEventListener('click', () => SLOT_DEFS.mic.click());
document.getElementById('mac-tile-mic')?.addEventListener('click', () => toggleMic());
refreshMic();
document.getElementById('tile-notepad').addEventListener('click', () => SLOT_DEFS.notepad.click());

let _wasCompactBusy = false;
function updateCompactStateClasses() {
  const isPrompt = !!(appState.prompting || appState.lockerPrompting);
  const isBusy = !!(appState.transferring || isPrompt || appState.toast);
  const hasBadges = appState.trayFiles.length > 0 || appState.peers.length > 0;
  if (_wasCompactBusy && !isBusy && island.classList.contains('state-compact') &&
      !island.classList.contains('bt-hud-active') && !island.classList.contains('alarm-active') &&
      !island.classList.contains('biometric-active')) {
    triggerCloseEase(650);
  } else if (!_wasCompactBusy && isBusy) {
    cancelCloseEase();
  }
  _wasCompactBusy = isBusy;
  island.classList.toggle('has-toast', !!appState.toast);
  island.classList.toggle('has-badges', hasBadges && !appState.mediaPlaying && !isBusy);
  island.classList.toggle('media-active', !!appState.mediaPlaying && !isBusy);
}

let _menuCloseT = null;
function triggerCloseEase(ms) {
  clearTimeout(_menuCloseT);
  island.classList.add('menu-closing');
  _menuCloseT = setTimeout(() => island.classList.remove('menu-closing'), ms || 700);
}
function cancelCloseEase() {
  clearTimeout(_menuCloseT);
  island.classList.remove('menu-closing');
}
function switchView(viewId, stateClass, winWidth, winHeight) {
  appState.keepOpen = false;
  if (typeof closeMacSub === 'function') closeMacSub();
  if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
  if (appState.currentView === 'view-bt' && viewId !== 'view-bt') {
    appState.btBusy = false;
    invokeTauri('bt_discovery', { on: false }); // new-device discovery only runs while the list is open
  }
  if (appState.currentView === 'view-clipboard' && viewId !== 'view-clipboard' && typeof closeClipboardView === 'function') {
    closeClipboardView(); // revoke thumbnail blob URLs & free DOM immediately on close
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const target = document.getElementById(viewId);
  if (target) target.classList.add('active');

  // Menu -> pill: tag the island for the length of the shrink so CSS can use the no-bounce close curve
  // (the "media playing" pill otherwise uses the grow-spring, which undershoots the target size and bounces back).
  const wasCompact = island.classList.contains('state-compact');
  if (stateClass === 'state-compact' && !wasCompact) {
    triggerCloseEase(700);
  } else {
    cancelCloseEase();
  }

  island.classList.remove(
    'state-compact', 'state-drop', 'state-control', 'state-control-mac',
    'state-tray', 'state-tray-mac', 'state-sub', 'state-media', 'state-calendar'
  );
  island.classList.add(stateClass);
  appState.currentView = viewId;
  if (typeof syncDropRail === 'function') syncDropRail(viewId);   // Inex Drop <-> P2P side rail
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

  let win = { width: winWidth, height: effH };
  if (viewId === 'view-compact' && typeof compactIslandSize === 'function') win = compactIslandSize(win);
  reportIslandSize(win);

  if (viewId === 'view-compact' && appState.timerStartPending) {
    appState.timerStartPending = false;
    setTimeout(() => { if (appState.timerRunning && typeof showTimerStartHud === 'function') showTimerStartHud(); }, 450);
  }
}

function applyMacMenuConfig() {
  const cfg = (SET.macMenu && typeof SET.macMenu === 'object') ? SET.macMenu : {};
  const map = {
    clock: cfg.showClock !== false,
    weather: cfg.showWeather !== false && (!SET.weather || SET.weather.enabled !== false),
    stats: cfg.showStats !== false,
    media: cfg.showMedia !== false && (!SET.notch || SET.notch.musicMode !== false),
    sliders: cfg.showSliders !== false,
  };
  Object.keys(map).forEach((k) => {
    const el = document.querySelector(`#view-control-mac [data-mac="${k}"]`);
    if (el) el.classList.toggle('hidden', !map[k]);
  });
  const batEl = document.getElementById('mac-stat-bat');
  if (batEl && appState.stats) {
    batEl.classList.toggle('hidden', !(appState.stats.battery_pct >= 0));
  }
  const topBat = document.getElementById('mac-battery');
  if (topBat && appState.stats) {
    topBat.classList.toggle('hidden', !(appState.stats.battery_pct >= 0 && cfg.showBattery !== false));
  }
}

function openControlMenu() {
  if (SET.appearance && SET.appearance.menuLayout === 'mac') {
    applyMacMenuConfig();
    invokeTauri('wifi_backend', { on: true }).catch(() => {});
    invokeTauri('bt_backend', { on: true }).catch(() => {});
    switchView('view-control-mac', 'state-control-mac', ISLAND_WIN_W, 218);
    if (typeof refreshRadios === 'function') refreshRadios().catch(() => {});
    if (typeof refreshLoad === 'function') refreshLoad().catch(() => {});
    if (typeof syncMacStatsUI === 'function') syncMacStatsUI();
    if (typeof syncMacWeatherUI === 'function') syncMacWeatherUI();
    if (typeof syncMacMediaUI === 'function') syncMacMediaUI();
    if (typeof updateTrayUI === 'function') updateTrayUI();
    if (typeof updateDropTile === 'function') updateDropTile();
    if (typeof renderMediaProgress === 'function') renderMediaProgress();
  } else {
    switchView('view-control', 'state-control', 316, 292);
  }
  try { refreshBtCaption(); } catch (_) {}
  if (slotRunning.has('mic')) try { refreshMic(); } catch (_) {}
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
  switchView('view-compact', 'state-compact', ISLAND_WIN_W, 36);
}

// Mac-style menu static controls (lock & settings)
document.getElementById('mac-lock-btn')?.addEventListener('click', () => invokeTauri('lock_screen'));
document.getElementById('mac-awake-btn')?.addEventListener('click', async () => {
  const on = await invokeTauri('set_keep_awake', { on: !awakeState });
  awakeState = on === true;
  syncAwakeUi();
});
document.getElementById('mac-settings-btn')?.addEventListener('click', () => invokeTauri('open_settings'));

let _cycleIdx = 0;
let _cycleTimer = null;

const COMPACT_STAT_ICONS = {
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 12 6 12 9 5 14 19 17 12 22 12"/></svg>',
  ram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="3"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="16" y1="11" x2="16" y2="13"/></svg>',
  battery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="2" y="7" width="16" height="10" rx="2.5"/><rect x="4.5" y="9.5" width="9.5" height="5" rx="1" fill="currentColor" stroke="none"/><path d="M20.5 10.5v3" stroke-linecap="round" stroke-width="2.2"/></svg>',
  charging: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  weather: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg>'
};

function renderCompactChip(iconSvg, text, cls) {
  const c = cls ? ` ${cls}` : '';
  return `<span class="c-stat-chip${c}">${iconSvg}<span>${escHtml(text)}</span></span>`;
}

function formatCompactCenterHtml(timeStr) {
  const mode = (SET.notch && SET.notch.compactContent) || 'clock';
  if (mode === 'clock') return { html: false, val: timeStr };
  const stats = appState.stats;
  const pick = (k) => {
    if (k === 'weather') {
      if (!(SET.weather && SET.weather.enabled !== false && typeof weather !== 'undefined' && weather.text)) return null;
      const ico = (typeof getActiveWeatherIcon === 'function' ? getActiveWeatherIcon() : '') || COMPACT_STAT_ICONS.weather;
      const wCls = (weather.isDay === false) ? 'is-night' : 'is-weather';
      return { html: true, val: renderCompactChip(ico, weather.text, wCls) };
    }
    if (k === 'cpu') {
      if (!stats) return null;
      const cls = stats.cpu_pct >= 85 ? 'is-cpu is-crit' : stats.cpu_pct >= 65 ? 'is-cpu is-warn' : 'is-cpu';
      return { html: true, val: renderCompactChip(COMPACT_STAT_ICONS.cpu, `${stats.cpu_pct}%`, cls) };
    }
    if (k === 'ram') {
      if (!stats) return null;
      const cls = stats.ram_pct >= 85 ? 'is-ram is-crit' : stats.ram_pct >= 70 ? 'is-ram is-warn' : 'is-ram';
      return { html: true, val: renderCompactChip(COMPACT_STAT_ICONS.ram, `${stats.ram_pct}%`, cls) };
    }
    if (k === 'battery') {
      if (!(stats && stats.battery_pct >= 0)) return null;
      const cls = !stats.charging ? (stats.battery_pct <= 15 ? 'is-bat is-crit' : stats.battery_pct <= 30 ? 'is-bat is-warn' : 'is-bat') : 'is-bat';
      const ico = stats.charging ? COMPACT_STAT_ICONS.charging : COMPACT_STAT_ICONS.battery;
      return { html: true, val: renderCompactChip(ico, `${stats.battery_pct}%`, cls) };
    }
    return { html: false, val: timeStr };
  };
  if (mode === 'cycle') {
    const order = ['clock', 'weather', 'cpu', 'ram', 'battery'].filter((k) => !!pick(k));
    if (!order.length) return { html: false, val: timeStr };
    return pick(order[_cycleIdx % order.length]) || { html: false, val: timeStr };
  }
  return pick(mode) || { html: false, val: timeStr };
}

function syncCompactCycleTimer() {
  const want = SET.notch && SET.notch.compactContent === 'cycle' && !document.hidden;
  if (want && !_cycleTimer) {
    _cycleTimer = setInterval(() => {
      _cycleIdx = (_cycleIdx + 1) % 60;
      updateClocks();
    }, 5000);
  } else if (!want && _cycleTimer) {
    clearInterval(_cycleTimer);
    _cycleTimer = null;
  }
}

let _lastCenterRender = '';
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
    const res = formatCompactCenterHtml(str);
    const sig = `${res.html ? 'H' : 'T'}:${res.val}`;
    if (cClock && sig !== _lastCenterRender) {
      _lastCenterRender = sig;
      if (res.html) cClock.innerHTML = res.val;
      else cClock.textContent = res.val;
    }
  }
  const ctrlClock = document.getElementById('ctrl-clock-tab');
  if (ctrlClock && ctrlClock.textContent !== str) ctrlClock.textContent = str;
  const macClock = document.getElementById('mac-clock');
  if (macClock && macClock.textContent !== str) macClock.textContent = str;
  const macDate = document.getElementById('mac-date');
  if (macDate) {
    const dateStr = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (macDate.textContent !== dateStr) macDate.textContent = dateStr;
  }
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

  if (appState.currentView !== 'view-media' && appState.currentView !== 'view-control-mac') return;

  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  const macProgEl = document.getElementById('mac-prog-fill');
  if (macProgEl && !appState.mediaSeeking) {
    macProgEl.style.setProperty('--v', pct.toFixed(1));
  }
  const macSlider = document.getElementById('mac-seek-slider');
  if (macSlider && !appState.mediaSeeking) {
    const v = Math.round(pct * 10);
    if (macSlider.value != v) macSlider.value = v;
  }
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
  const macWantsMedia = appState.currentView === 'view-control-mac' && (!SET.macMenu || SET.macMenu.showMedia !== false);
  const want = (appState.currentView === 'view-media' || macWantsMedia) && appState.mediaPlaying && appState.mediaDuration > 0;
  if (want && !mediaTickT) {
    mediaTickT = setInterval(() => {
      if (!appState.mediaSeeking) renderMediaProgress();
    }, 250);
  } else if (!want && mediaTickT) {
    clearInterval(mediaTickT);
    mediaTickT = null;
  }
}

// Interactive Media Timeline Seek Bar (Classic + Control Deck)
function handleSeekInput(sliderVal) {
  if (appState.mediaDuration <= 0) return;
  appState.mediaSeeking = true;
  const pct = Number(sliderVal) / 1000;
  const targetSec = pct * appState.mediaDuration;
  const mFill = document.getElementById('m-prog-fill');
  const mCur = document.getElementById('m-cur-time');
  const mTot = document.getElementById('m-tot-time');
  if (mFill) mFill.style.width = `${pct * 100}%`;
  if (mCur) mCur.textContent = fmtTime(targetSec);
  if (mTot) mTot.textContent = `-${fmtTime(appState.mediaDuration - targetSec)}`;
  const macFill = document.getElementById('mac-prog-fill');
  if (macFill) macFill.style.setProperty('--v', (pct * 100).toFixed(1));
}

async function handleSeekCommit(sliderVal) {
  if (appState.mediaDuration <= 0) {
    appState.mediaSeeking = false;
    return;
  }
  const pct = Number(sliderVal) / 1000;
  const targetSec = pct * appState.mediaDuration;
  mediaBackendPos = targetSec;
  mediaBackendTime = Date.now();
  appState.mediaProgressSec = targetSec;
  await invokeTauri('seek_media', { positionSec: targetSec });
  setTimeout(() => { appState.mediaSeeking = false; }, 300);
}

['m-seek-slider', 'mac-seek-slider'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', (e) => handleSeekInput(e.target.value));
  el.addEventListener('change', (e) => handleSeekCommit(e.target.value));
});

// Artwork & Dominant Ambient Color
function setAmb(rgb) {
  ['view-media', 'mac-media', 'island'].forEach((id) => document.getElementById(id)?.style.setProperty('--amb', rgb));
}

async function loadMediaArt() {
  const url = await invokeTauri('get_media_art');
  const cArt = document.getElementById('c-art'), mArt = document.getElementById('m-art'), macArt = document.getElementById('mac-art');
  const cFb = document.getElementById('c-art-fallback'), mFb = document.getElementById('m-art-fallback'), macFb = document.getElementById('mac-art-fallback');

  if (!url) {
    appState.loadedArtUrl = '';
    [cArt, mArt, macArt].forEach((i) => {
      if (!i) return;
      i.classList.add('hidden');
      i.src = '';
    });
    [cFb, mFb, macFb].forEach((i) => { if (i) i.style.display = ''; });
    setAmb('70, 130, 180');
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
    if (cArt) cArt.src = url;
    if (mArt) mArt.src = url;
    if (macArt) macArt.src = url;
    [cArt, mArt, macArt].forEach((i) => { if (i) i.classList.remove('hidden'); });
    [cFb, mFb, macFb].forEach((i) => { if (i) i.style.display = 'none'; });
    const c = dominantColor(img);
    setAmb(c);
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

function sourceBadgeMeta(src) {
  const s = (src || '').toLowerCase();
  if (s.includes('spotify')) {
    return {
      cls: 'src-spotify',
      svg: '<svg viewBox="0 0 24 24" fill="#1ed760"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.34c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.18.48.66.3 1.02zm1.44-3.3c-.3.42-.84.6-1.26.3-3.24-1.98-8.16-2.58-11.94-1.38-.48.12-1.02-.12-1.14-.6-.12-.48.12-1.02.6-1.14 4.32-1.32 9.72-.66 13.44 1.62.36.18.54.78.3 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.3c-.6.18-1.2-.18-1.38-.72-.18-.6.18-1.2.72-1.38 4.26-1.26 11.28-1.02 15.72 1.62.54.3.72 1.02.42 1.56-.3.42-1.02.6-1.56.3z"/></svg>'
    };
  }
  if (s.includes('youtube')) {
    if (s.includes('music')) {
      return {
        cls: 'src-youtube-music',
        svg: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7.5" stroke="#ffffff" stroke-width="1.6"/><polygon points="10,8.5 16,12 10,15.5" fill="#ffffff"/></svg>'
      };
    }
    return {
      cls: 'src-youtube',
      svg: '<svg viewBox="0 0 24 24" fill="#ffffff"><path d="M9.5 7.4v9.2L17.2 12 9.5 7.4z"/></svg>'
    };
  }
  if (s.includes('apple')) {
    return {
      cls: 'src-apple',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 4v10.2a2.8 2.8 0 1 1-1.8-2.6V7.5l-6 1.5v6.8a2.8 2.8 0 1 1-1.8-2.6V6.2L16 4z"/></svg>'
    };
  }
  if (s.includes('vlc')) {
    return {
      cls: 'src-vlc',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 7.5 18H5v2h14v-2h-2.5L12 3z"/></svg>'
    };
  }
  if (s.includes('chrome') || s.includes('edge') || s.includes('firefox') || s.includes('brave') || s.includes('opera')) {
    return {
      cls: 'src-browser',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="8"/><path d="M4.5 12h15M12 4a11 11 0 0 1 0 16M12 4a11 11 0 0 0 0 16"/></svg>'
    };
  }
  return {
    cls: '',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
  };
}

function updateSourceBadge(badgeId, icoId, _nameId, source) {
  const badge = document.getElementById(badgeId);
  const ico = document.getElementById(icoId);
  if (!badge) return;
  const label = (source || '').trim();
  if (!label) {
    badge.className = 'src-corner hidden';
    badge.title = '';
    delete badge.dataset.src;
    return;
  }
  if (badge.dataset.src !== label) {
    badge.dataset.src = label;
    const meta = sourceBadgeMeta(label);
    badge.className = `src-corner${meta.cls ? ' ' + meta.cls : ''}`;
    badge.title = `Playing from ${label}`;
    if (ico) ico.innerHTML = meta.svg;
  }
  badge.classList.remove('hidden');
}

function syncMacMediaUI() {
  const m = appState.cachedMedia;
  const hasMedia = !!(m && m.title && m.title.trim());
  const isPlaying = !!(hasMedia && appState.mediaPlaying);
  const titleEl = document.getElementById('mac-title');
  const artistEl = document.getElementById('mac-artist');
  const playSvg = document.getElementById('mac-play-svg');
  const macArt = document.getElementById('mac-art');
  const macFb = document.getElementById('mac-art-fallback');
  const progEl = document.getElementById('mac-prog-fill');
  document.getElementById('mac-media')?.classList.toggle('has-media', hasMedia);

  const _t = hasMedia ? m.title : 'Not Playing';
  if (titleEl && titleEl.textContent !== _t) titleEl.textContent = _t;   // same text: keep the sliding animation running
  if (artistEl) {
    const _a = !hasMedia
      ? 'Spotify / YouTube'
      : isPlaying
        ? (m.artist || 'Playing on PC')
        : (m.artist ? `${m.artist} (Paused)` : 'Paused on PC');
    if (artistEl.textContent !== _a) artistEl.textContent = _a;
  }
  updateSourceBadge('mac-source-badge', 'mac-source-ico', 'mac-source-name', hasMedia ? m.source : '');
  if (playSvg) {
    playSvg.innerHTML = isPlaying
      ? '<rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/>'
      : '<polygon points="6 3 20 12 6 21"/>';
  }
  if (macArt && macFb) {
    if (hasMedia && appState.loadedArtUrl) {
      if (macArt.src !== appState.loadedArtUrl) macArt.src = appState.loadedArtUrl;
      macArt.classList.remove('hidden');
      macFb.style.display = 'none';
    } else {
      macArt.src = '';
      macArt.classList.add('hidden');
      macFb.style.display = '';
    }
  }
  if (progEl && !hasMedia) progEl.style.setProperty('--v', '0');
}

document.querySelector('#mac-media .mx-media-top')?.addEventListener('click', () => {
  if (appState.cachedMedia && appState.cachedMedia.title) openMedia();
});

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
  setAmb('70, 130, 180');
  if (playSvg) playSvg.innerHTML = `<polygon points="6 3 20 12 6 21"/>`;
  if (mEqBars) mEqBars.style.visibility = 'hidden';
  if (mTitle) mTitle.textContent = 'Not Playing';
  if (mArtist) mArtist.textContent = 'Spotify / YouTube';
  updateSourceBadge('m-source-badge', 'm-source-ico', 'm-source-name', '');
  syncMacMediaUI();

  appState.mediaProgressSec = 0;
  appState.mediaDuration = 0;
  if (typeof syncMediaTick === 'function') syncMediaTick();
  renderMediaProgress();

  island.classList.remove('media-active');
  syncMacMediaUI();
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
  appState.cachedMedia = media;
  updateSourceBadge('m-source-badge', 'm-source-ico', 'm-source-name', media.source || '');

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

  syncMacMediaUI();
  updateCompactStateClasses();
  syncEq();
}

async function refreshRadios() {
  const macOn = SET.appearance && SET.appearance.menuLayout === 'mac';
  // only ask about radios whose slot is shown (or always in Mac layout)
  const [wifiOn, btOn] = await Promise.all([
    (slotRunning.has('wifi') || macOn) ? invokeTauri('get_radio_state', { kind: 'wifi' }) : null,
    (slotRunning.has('bt') || macOn) ? invokeTauri('get_radio_state', { kind: 'bt' }) : null
  ]);
  if (typeof wifiOn === 'boolean') applyRadio('wifi', wifiOn);
  if (typeof btOn === 'boolean') applyRadio('bt', btOn);
}

const MAC_GAUGE_ARC = 80.1;   // 270 degrees of the r=17 ring
function setMacStatMeter(wrapId, valId, barId, pct, critAt, warnAt, lowIsBad, subId, subText) {
  const wrap = document.getElementById(wrapId);
  const val = document.getElementById(valId);
  const bar = document.getElementById(barId);
  if (!wrap || !val) return;
  const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  val.textContent = `${n}%`;
  if (bar) bar.style.strokeDasharray = `${(n / 100 * MAC_GAUGE_ARC).toFixed(1)} 106.8`;
  if (subId) {
    const sub = document.getElementById(subId);
    if (sub && sub.textContent !== (subText || '')) sub.textContent = subText || '';
  }

  const isCrit = lowIsBad ? n <= critAt : n >= critAt;
  const isWarn = !isCrit && (lowIsBad ? n <= warnAt : n >= warnAt);
  wrap.classList.toggle('crit', isCrit);
  wrap.classList.toggle('warn', isWarn);
}

async function syncMacStatsUI() {
  const s = appState.stats;
  if (!s) return;

  // 1. Top bar laptop battery indicator (if battery present on PC/laptop)
  const batTop = document.getElementById('mac-battery');
  if (batTop) {
    const hasBat = s.battery_pct >= 0;
    const showBat = hasBat && (SET.macMenu?.showBattery !== false);
    batTop.classList.toggle('hidden', !showBat);
    if (showBat) {
      const pctEl = document.getElementById('mac-bat-pct');
      if (pctEl) pctEl.textContent = `${s.battery_pct}%`;
      const lvl = Math.max(1, Math.min(10, Math.round((s.battery_pct / 100) * 10)));
      const lvlEl = document.getElementById('mac-bat-level');
      if (lvlEl) lvlEl.setAttribute('width', lvl);
      const bolt = document.getElementById('mac-bat-bolt');
      if (bolt) bolt.classList.toggle('hidden', !s.charging);
      batTop.classList.toggle('charging', !!s.charging);
      batTop.classList.toggle('low', s.battery_pct <= 20 && !s.charging);
    }
  }

  // 2. Mini Stats Card: CPU & RAM OR Connected Bluetooth Device Card OR Laptop Battery
  const mode = SET.macMenu?.statsMode || 'sys';
  const macStatsCard = document.getElementById('mac-stats');
  const cpuStat = document.getElementById('mac-stat-cpu');
  const ramStat = document.getElementById('mac-stat-ram');
  const extraStat = document.getElementById('mac-stat-extra');
  const btCard = document.getElementById('mac-stat-bt');

  if (mode === 'bt') {
    let btDev = null;
    let btDevPct = -1;
    try {
      const devices = await invokeTauri('get_bt_devices');
      if (Array.isArray(devices)) {
        btDev = devices.find((d) => d.connected);
      }
      if (btDev) {
        const bl = await invokeTauri('get_bt_batteries');
        if (Array.isArray(bl) && bl.length) appState.btBatt = bl;
        const p = btBatteryFor(btDev.name);
        if (p !== null && p !== undefined) btDevPct = p;
        // Windows may not report the battery immediately after connecting.
        if (btDevPct < 0 && (appState._macBtTries || 0) < 3) {
          appState._macBtTries = (appState._macBtTries || 0) + 1;
          setTimeout(syncMacStatsUI, 3000);
        } else if (btDevPct >= 0) {
          appState._macBtTries = 0;
        }
      }
    } catch (_) {}

    if (btDev) {
      if (macStatsCard) macStatsCard.classList.remove('hidden');
      if (cpuStat) cpuStat.classList.add('hidden');
      if (ramStat) ramStat.classList.add('hidden');
      if (extraStat) extraStat.classList.add('hidden');
      if (btCard) {
        btCard.classList.remove('hidden');
        const nameEl = document.getElementById('mac-bt-dev-name');
        if (nameEl) nameEl.textContent = btDev.name;
        const tagEl = document.getElementById('mac-bt-dev-tag');
        if (tagEl) tagEl.textContent = 'Connected';
        const icoEl = document.getElementById('mac-bt-dev-ico');
        if (icoEl) {
          const kind = btDev.kind || 'bt';
          const isBuds = (kind === 'headphones' || !kind || kind === 'bt') && /airpod|buds|earbud|earphone|airdope|tws|pods|wf-/i.test(btDev.name || '');
          icoEl.innerHTML = isBuds && typeof BUDS_SVG !== 'undefined' ? BUDS_SVG.replace(/budg/g, 'budg-card') : ((typeof DEV_ICONS !== 'undefined' && DEV_ICONS[kind]) ? DEV_ICONS[kind] : (typeof DEV_ICONS !== 'undefined' && DEV_ICONS.bt ? DEV_ICONS.bt : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>'));
          icoEl.className = 'mx-bt-ico';
        }
        const pctEl = document.getElementById('mac-bt-dev-pct');
        const ringEl = document.getElementById('mac-bt-dev-ring');
        if (pctEl) pctEl.textContent = btDevPct >= 0 ? `${btDevPct}%` : 'Connected';
        if (ringEl) {
          if (btDevPct >= 0) {
            const circ = 66; // 2 * PI * 10.5
            const offset = circ * (1 - Math.max(0, Math.min(100, btDevPct)) / 100);
            ringEl.style.strokeDashoffset = offset;
            ringEl.style.stroke = btDevPct <= 15 ? '#ff453a' : btDevPct <= 30 ? '#ff9f0a' : '#30d158';
            if (ringEl.parentElement) ringEl.parentElement.style.display = 'block';
          } else {
            if (ringEl.parentElement) ringEl.parentElement.style.display = 'none';
          }
        }
      }
      return;
    }

    // Bluetooth mode selected, but no Bluetooth device connected: hide stats card completely so media expands!
    if (macStatsCard) macStatsCard.classList.add('hidden');
    return;
  }

  if (macStatsCard) macStatsCard.classList.remove('hidden');
  if (btCard) btCard.classList.add('hidden');

  if (mode === 'battery' && s.battery_pct >= 0) {
    if (cpuStat) cpuStat.classList.add('hidden');
    if (ramStat) ramStat.classList.add('hidden');
    if (extraStat) {
      extraStat.classList.remove('hidden');
      const lbl = document.getElementById('mac-extra-lbl');
      if (lbl) lbl.textContent = s.charging ? 'CHG' : 'BAT';
      setMacStatMeter('mac-stat-extra', 'mac-extra-val', 'mac-extra-bar', s.battery_pct, 15, 30, true, 'mac-extra-sub', s.charging ? 'Charging' : 'On battery');
    }
    return;
  }

  if (mode === 'disk') {
    if (cpuStat) cpuStat.classList.add('hidden');
    if (ramStat) ramStat.classList.add('hidden');
    if (extraStat) {
      extraStat.classList.remove('hidden');
      const lbl = document.getElementById('mac-extra-lbl');
      if (lbl) lbl.textContent = 'DISK';
      setMacStatMeter('mac-stat-extra', 'mac-extra-val', 'mac-extra-bar', s.disk_pct, 90, 75, false, 'mac-extra-sub', 'C: used');
    }
    return;
  }

  // Default: CPU & RAM
  if (cpuStat) cpuStat.classList.remove('hidden');
  if (ramStat) ramStat.classList.remove('hidden');
  if (extraStat) extraStat.classList.add('hidden');
  setMacStatMeter('mac-stat-cpu', 'mac-cpu-val', 'mac-cpu-bar', s.cpu_pct, 85, 65, false, 'mac-cpu-sub', s.cpu_temp > 0 ? `${Math.round(s.cpu_temp)}\u00B0C` : '');
  setMacStatMeter('mac-stat-ram', 'mac-ram-val', 'mac-ram-bar', s.ram_pct, 85, 70, false, 'mac-ram-sub', s.ram_used_gb > 0 ? `${s.ram_used_gb.toFixed(1)} GB` : '');
}

async function refreshStats() {
  const stats = await invokeTauri('get_sys_stats');
  if (stats) {
    appState.stats = stats;
    updateClocks();
    renderWidgets();
    syncMacStatsUI();
    batteryOverlays(stats);
    const macWifiSub = document.getElementById('mac-wifi-sub');
    if (macWifiSub && appState.wifiRadio) {
      macWifiSub.textContent = (stats.wifi_name && stats.wifi_name !== 'Not connected') ? stats.wifi_name : 'On';
    }
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
  if (document.hidden) return false;
  if (appState.currentView === 'view-control-mac') return !SET.macMenu || SET.macMenu.showStats !== false;
  if (appState.currentView !== 'view-compact') return false;
  const compactNeedsLoad = ['cpu', 'ram', 'cycle'].includes(SET.notch?.compactContent);
  if (compactNeedsLoad) return true;
  if (SET.widgets && SET.widgets.enabled === false) return false;   // Hover Widgets switched off
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
  updateClocks();
  renderWidgets();
  syncMacStatsUI();
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
  const tryListen = () => {
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
      const r = window.__TAURI__.event.listen(name, fn);
      if (r && r.catch) r.catch((e) => console.warn('event listen failed:', name, e));
    } else {
      setTimeout(tryListen, 80);
    }
  };
  tryListen();
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
onTauriEvent('settings-changed', (e) => {
  try {
    if (e && e.payload) {
      const raw = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload);
      localStorage.setItem('inex.settings.v1', raw);
    }
  } catch (_) {}
  if (typeof loadSettings === 'function' && typeof scheduleApplySettings === 'function') {
    SET = loadSettings();
    scheduleApplySettings();   // coalesced: one apply per frame, not one per event
  }
});
pollSystemAndMedia();
syncLoadTimer();

// 3. Compact Bar Clicks (Whole compact notch expands into control menu on click)
const compactBarEl = document.querySelector('.compact-bar');
if (compactBarEl) {
  compactBarEl.addEventListener('click', (e) => {
    if (e.target.closest('#c-media-btn, #c-eq, #c-tray-btn, #c-peer-badge, #c-incoming-alert, #c-transfer-cancel-btn, #btn-hud-accept, #btn-hud-decline, #c-alarm-box, #btn-alarm-snooze, #btn-alarm-dismiss')) {
      return;
    }
    if (island.classList.contains('alarm-active')) {
      if (typeof dismissTimerAlarm === 'function') dismissTimerAlarm();
      return;
    }
    if (typeof currentOffer !== 'undefined' && currentOffer) {
      if (SET.appearance && SET.appearance.menuLayout === 'mac') {
        openMacDrop('qs');
      } else {
        openQsView();
      }
      return;
    }
    openControlMenu();
  });
}
document.getElementById('c-center-trigger')?.addEventListener('click', (e) => {
  if (e.target.closest('#c-incoming-alert')) return;
  if (island.classList.contains('alarm-active')) {
    if (typeof dismissTimerAlarm === 'function') dismissTimerAlarm();
    return;
  }
  if (typeof currentOffer !== 'undefined' && currentOffer) {
    if (SET.appearance && SET.appearance.menuLayout === 'mac') {
      openMacDrop('qs');
    } else {
      openQsView();
    }
    return;
  }
  openControlMenu();
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
  openP2PView();
});

// Small delay + real hover check: while the island animates the pointer can touch its edge for one frame,
// which fired mouseleave and closed the media player right after it opened.
let _leaveT = null;
let _pointerOutside = false;   // set by Rust (fixed window mode): the cursor is outside the island, :hover may be stale
island.addEventListener('mouseenter', () => { _pointerOutside = false; clearTimeout(_leaveT); });
island.addEventListener('mouseleave', () => {
  if (appState.keepOpen) return;      // typing a Wi-Fi password: do not collapse
  clearTimeout(_leaveT);
  _leaveT = setTimeout(() => {
    if (appState.keepOpen || (island.matches(':hover') && !_pointerOutside)) return;
    if (appState.currentView !== 'view-compact') {
      goCompact();
    }
  }, 140);
});

// 4. Control Center Navigation & Sub-Menus
// (Clock in main menu is display-only; subviews navigate back via their left back-arrow)

// Fixed window mode: Rust tells us when the cursor enters / leaves the island (the window is click-through outside it).
onTauriEvent('island_pointer', (ev) => {
  const inside = !!(ev && ev.payload);
  _pointerOutside = !inside;
  if (!inside) island.dispatchEvent(new MouseEvent('mouseleave'));
});
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
  if (!isWifiViewOpen() || appState.keepOpen) return;
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
      setTimeout(() => { if (isWifiViewOpen()) loadWifiList(); }, 700);
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
  if (!isBtViewOpen() || appState.btBusy) return;
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
            setTimeout(() => { if (isBtViewOpen()) loadBtList(true); }, 500);
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
  if (!box || !isBtViewOpen() || appState.btBusy || appState.btPairing) return;
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
  if (!isBtViewOpen()) return;
  await loadBtList(true);
  if (r !== 'ok') showBtNote(BT_PAIR_ERR[r] || 'Could not pair, try again');
}

// Windows asks a question while pairing: confirm a number / show a number / type a PIN
function showBtPrompt(p) {
  if (!p) return;
  if (!isBtViewOpen()) {
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
let btHudEndT = null;
let btHudPrompt = false;   // true while the HUD is the file-transfer Accept / Decline card
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
function hudUiScale() { return Math.max(0.8, ((SET.appearance && SET.appearance.scale) || 100) / 100); }
function hudIslandSize() {
  // Nominal size of the HUD / popup pill; reportIslandSize() applies SET.appearance.scale to it.
  return { width: ISLAND_WIN_W, height: hudIsFloating() ? 64 : 54 };
}
// Transfer / toast / lock-prompt popups use the SAME island size as the Bluetooth HUD.
function popupIsBusy() { return !!(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast); }

// Island size for the compact view: the HUD size while a status popup (transfer / toast / prompt) is open,
// the small notch size otherwise. Used when the menu closes or Settings change, so the clickable area never
// shrinks under an open popup.
function compactIslandSize(win) {
  if (popupIsBusy() && !(island.classList.contains('alarm-active') || island.classList.contains('bt-hud-active')
      || island.classList.contains('biometric-active') || island.classList.contains('bio-hud'))) {
    popupSizeOn = true;
    return hudIslandSize();
  }
  return win;
}

function hudRestoreSize() {
  if (!hudCanShow() || appState.alarmActive) return;   // the timer-end card keeps its own size
  if (popupIsBusy()) { reportIslandSize(hudIslandSize()); return; }   // a popup is still open: keep the HUD size
  reportIslandSize({ width: ISLAND_WIN_W, height: hudIsFloating() ? 48 : 36 });
}

let popupSizeOn = false, popupSizeT = null;
function syncPopupSize(busy) {
  if (appState.currentView !== 'view-compact') return;
  if (appState.alarmActive || island.classList.contains('bt-hud-active') || island.classList.contains('hud-pre')
      || island.classList.contains('biometric-active') || island.classList.contains('bio-hud')) return;   // those own the island size
  clearTimeout(popupSizeT);
  if (busy) {
    popupSizeOn = true;
    reportIslandSize(hudIslandSize());
  } else if (popupSizeOn) {
    // let the pill finish shrinking before the clickable area gets small again
    popupSizeT = setTimeout(() => {
      popupSizeOn = false;
      // a biometric morph / device HUD / alarm may have started during the 650 ms wait (e.g. the locker prompt closes
      // and the unlock morph begins right away): they own the size now, shrinking it here would cut the animation's clickable area
      if (island.classList.contains('bio-hud') || island.classList.contains('biometric-active') || island.classList.contains('hud-pre')
          || island.classList.contains('bt-hud-active') || island.classList.contains('alarm-active') || appState.alarmActive) return;
      if (!popupIsBusy()) hudRestoreSize();
    }, 650);
  }
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

  const alreadyOpen = island.classList.contains('bt-hud-active') && !island.classList.contains('hud-out') && !hud.classList.contains('hidden');
  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT); clearTimeout(btHudEndT);
  btHudPrompt = !!o.actions;
  // another HUD may be open: close it instantly
  clearTimeout(bioTimer); clearTimeout(bioAnimPhaseTimer); clearTimeout(bioStartTimer); clearTimeout(bioEndTimer);
  island.classList.remove('biometric-active', 'hud-out', 'hud-back', 'bio-hud');
  document.getElementById('c-biometric-box').classList.add('hidden');

  ico.className = 'bt-hud-icon' + (o.plain ? ' plain' : '') + (o.accent ? ' ' + o.accent : '');
  ico.innerHTML = o.iconHTML;
  nameEl.textContent = o.name || 'Device';
  tagEl.textContent = o.tag || 'Connected';
  const actBox = document.getElementById('bt-hud-actions');
  if (actBox) actBox.classList.toggle('hidden', !o.actions);

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

  const win = hudIslandSize();
  if (typeof cancelCloseEase === 'function') cancelCloseEase();
  if (alreadyOpen) {
    // the pill is already out (e.g. next file request right after "saved"): keep it open, only swap the content
    reportIslandSize(win);
    hud.classList.add('hidden');
    void hud.offsetWidth;              // restarts the content animation
    hud.classList.remove('hidden');
  } else {
    hud.classList.remove('hidden');
    // 1) window big enough, 2) old content blurs away, 3) island springs open
    reportIslandSize(win);   // wider/taller than the HUD so the spring overshoot is never clipped
    island.classList.add('hud-pre');
    btHudStartT = setTimeout(() => {
      island.classList.remove('hud-pre');
      island.classList.add('bt-hud-active');
    }, 110);
  }

  btHudTimer = setTimeout(() => hideDeviceHud(), o.ms || 3200);
}

// Closes the device HUD with the normal exit animation (or at once when instant = true)
function hideDeviceHud(instant) {
  const hud = document.getElementById('c-bt-hud');
  if (!hud) return;
  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT); clearTimeout(btHudEndT);
  btHudPrompt = false;
  const finish = () => {
    hud.classList.add('hidden');
    island.classList.remove('bt-hud-active', 'hud-out', 'hud-back', 'hud-pre');
    hudRestoreSize();
    renderCenter(); updateClocks(); refreshMedia();
  };
  if (instant || hud.classList.contains('hidden')) {
    if (!hud.classList.contains('hidden')) finish();
    return;
  }
  island.classList.add('hud-out');
  btHudBackT = setTimeout(() => {
    island.classList.remove('bt-hud-active', 'hud-out');
    island.classList.add('hud-back');
    btHudEndT = setTimeout(() => {
      hud.classList.add('hidden');
      island.classList.remove('hud-back');
      hudRestoreSize();
      renderCenter(); updateClocks(); refreshMedia();
    }, 600);
  }, 170);
}

function showBtConnectHud(name, kind, battPct) {
  playStatusSound('bluetooth', 'bluetooth');
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
    if (isBtViewOpen()) loadBtList(true);
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
  openP2PView();
});
document.getElementById('tile-tray').addEventListener('click', openTrayView);

document.querySelectorAll('.back-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    openControlMenu();
  });
});

function applyRadio(kind, on) {
  if (kind === 'wifi') {
    appState.wifiRadio = on;
    document.getElementById('tile-wifi').classList.toggle('active', on);
    if (!on) document.getElementById('wifi-sub').textContent = 'Off';
    document.getElementById('wifi-master-toggle').checked = on;
    const macTile = document.getElementById('mac-tile-wifi');
    const macSub = document.getElementById('mac-wifi-sub');
    if (macTile) macTile.classList.toggle('active', on);
    if (macSub) {
      if (!on) macSub.textContent = 'Off';
      else if (appState.stats && appState.stats.wifi_name && appState.stats.wifi_name !== 'Not connected') macSub.textContent = appState.stats.wifi_name;
      else macSub.textContent = 'On';
    }
  } else {
    appState.btRadio = on;
    document.getElementById('tile-bt').classList.toggle('active', on);
    document.getElementById('bt-sub').textContent = on ? 'On' : 'Off';
    document.getElementById('bt-master-toggle').checked = on;
    const macTile = document.getElementById('mac-tile-bt');
    const macSub = document.getElementById('mac-bt-sub');
    if (macTile) macTile.classList.toggle('active', on);
    if (macSub && !on) macSub.textContent = 'Off';
    else if (macSub && on && macSub.textContent === 'Off') macSub.textContent = 'On';
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
  restart: 'Restart Inex Island',
  notepad: 'Quick Notes',
  drop: 'Inex Drop'
};

let awakeState = false;

// Keep-awake button exists in both menus (Classic tile row + Mac top bar): keep both in step
function syncAwakeUi() {
  const title = awakeState ? 'Keep screen awake: ON' : 'Keep screen awake: off';
  ['act-awake', 'mac-awake-btn'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active', awakeState);
    el.title = title;
  });
}

function renderQuickActionTiles() {
  const row = document.getElementById('quick-icons-row');
  if (!row) return;
  const list = (SET.menu && Array.isArray(SET.menu.actionTiles) && SET.menu.actionTiles.length)
    ? SET.menu.actionTiles
    : ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings'];

  row.innerHTML = '';
  list.slice(0, 7).forEach((id) => {   // the row fits 7 circles at most
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
        syncAwakeUi();
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
        switchView('view-clipboard', 'state-sub', ISLAND_WIN_W, 260);
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
  const valEl = document.getElementById('val-vol');
  if (valEl) valEl.textContent = `${level}%`;
  const s = document.getElementById('slider-vol');
  if (s) {
    s.value = level;
    s.style.setProperty('--val', `${level}%`);
  }
  const ms = document.getElementById('m-vol-slider');
  if (ms) {
    ms.value = level;
    ms.style.setProperty('--val', `${level}%`);
  }
  const macVal = document.getElementById('mac-val-vol');
  if (macVal) macVal.textContent = `${level}%`;
  const macSlider = document.getElementById('mac-slider-vol');
  if (macSlider) macSlider.value = level;
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
  reportIslandSize({ width: ISLAND_WIN_W, height: appState.volOpen ? MEDIA_H_VOL : MEDIA_H });
});
document.getElementById('m-bt-btn').addEventListener('click', () => openAudioView());
invokeTauri('get_system_volume').then((v) => { if (typeof v === 'number') setVolumeUI(v); });

document.getElementById('slider-vol').addEventListener('input', (e) => handleVolumeChange(e.target.value));
document.getElementById('mac-slider-vol')?.addEventListener('input', (e) => handleVolumeChange(e.target.value));
document.getElementById('m-vol-slider').addEventListener('input', (e) => handleVolumeChange(e.target.value));

function syncBrightTextAndApply(level, commit) {
  const n = parseInt(level, 10);
  const vEl = document.getElementById('val-bright');
  if (vEl) vEl.textContent = `${n}%`;
  const s = document.getElementById('slider-bright');
  if (s) {
    s.value = n;
    s.style.setProperty('--val', `${n}%`);
  }
  const mvEl = document.getElementById('mac-val-bright');
  if (mvEl) mvEl.textContent = `${n}%`;
  const ms = document.getElementById('mac-slider-bright');
  if (ms) ms.value = n;
  if (commit) invokeTauri('set_system_brightness', { level: n });
}

document.getElementById('slider-bright').addEventListener('change', (e) => syncBrightTextAndApply(e.target.value, true));
document.getElementById('slider-bright').addEventListener('input', (e) => syncBrightTextAndApply(e.target.value, false));
document.getElementById('mac-slider-bright')?.addEventListener('change', (e) => syncBrightTextAndApply(e.target.value, true));
document.getElementById('mac-slider-bright')?.addEventListener('input', (e) => syncBrightTextAndApply(e.target.value, false));
// Brightness follows Windows (Fn keys, quick settings, auto-brightness) through an event, no polling
function setBrightUI(level) {
  if (typeof level !== 'number') return;
  const s = document.getElementById('slider-bright');
  if (s) {
    if (s.dataset.drag !== '1') s.value = level;
    s.style.setProperty('--val', `${level}%`);
  }
  const valEl = document.getElementById('val-bright');
  if (valEl) valEl.textContent = `${level}%`;
  const ms = document.getElementById('mac-slider-bright');
  if (ms && ms.dataset.drag !== '1') ms.value = level;
  const mvEl = document.getElementById('mac-val-bright');
  if (mvEl) mvEl.textContent = `${level}%`;
}
document.getElementById('slider-bright').addEventListener('pointerdown', (e) => { e.target.dataset.drag = '1'; });
document.getElementById('mac-slider-bright')?.addEventListener('pointerdown', (e) => { e.target.dataset.drag = '1'; });
window.addEventListener('pointerup', () => {
  const s = document.getElementById('slider-bright'); if (s) s.dataset.drag = '';
  const ms = document.getElementById('mac-slider-bright'); if (ms) ms.dataset.drag = '';
});
onTauriEvent('brightness-changed', (e) => setBrightUI(e && e.payload));
invokeTauri('get_system_brightness').then(setBrightUI);
setTimeout(() => invokeTauri('get_system_brightness').then(setBrightUI), 5000);

// Mac in-place subview management (keeps 500x210 locked, zero window resize or jitter)
currentMacSubTarget = null;
function openMacSub(viewId, title, from) {
  if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
  closeMacSub();
  const src = document.getElementById(viewId);
  const mount = document.getElementById('mac-sub-mount');
  const actionsSlot = document.getElementById('mac-sub-actions');
  if (!src || !mount) return;
  currentMacSubTarget = { id: viewId, parent: src.parentNode, next: src.nextSibling };
  mount.appendChild(src);
  src.classList.add('active', 'in-mac-sub');
  const titleEl = document.getElementById('mac-sub-title');
  if (titleEl) titleEl.textContent = title;

  if (actionsSlot) {
    actionsSlot.innerHTML = '';
    const headerRight = src.querySelector('.bt-header-right, .panel-top-right, .qs-header-right, .cal-nav-bar, .top-tool-btn');
    if (headerRight) {
      currentMacSubTarget.actions = headerRight;
      currentMacSubTarget.actionsParent = headerRight.parentNode;
      currentMacSubTarget.actionsNext = headerRight.nextSibling;
      actionsSlot.appendChild(headerRight);
    }
    if (viewId === 'view-p2p') mountP2PBarItems(actionsSlot);   // Generate / code / Cancel / status sit in the Back line, like Wi-Fi / Bluetooth
  }

  document.getElementById('mac-right-home')?.classList.add('hidden');
  const subPanel = document.getElementById('mac-right-sub');
  if (subPanel) {
    subPanel.classList.remove('from-bottom');
    subPanel.classList.remove('hidden');
    if (from === 'bottom') {
      const host = subPanel.parentElement;
      host.classList.add('mx-clip');                       // the panel slides in from under the bottom edge
      void subPanel.offsetWidth;
      subPanel.classList.add('from-bottom');
      setTimeout(() => host.classList.remove('mx-clip'), 420);
    }
  }

  if (viewId === 'view-wifi') {
    invokeTauri('wifi_backend', { on: true }).catch(() => {});
    if (typeof loadWifiList === 'function') loadWifiList();
  }
  if (viewId === 'view-bt') {
    invokeTauri('bt_backend', { on: true }).catch(() => {});
    invokeTauri('bt_discovery', { on: true }).catch(() => {});
    if (typeof loadBtList === 'function') loadBtList();
  }
  if (viewId === 'view-tray' && typeof updateTrayUI === 'function') updateTrayUI();
  if (viewId === 'view-calendar' && typeof renderCalendarGrid === 'function') renderCalendarGrid();
  if (viewId === 'view-notepad' && typeof focusNotepad === 'function') focusNotepad();
  if (viewId === 'view-clipboard' && typeof openClipboardView === 'function') openClipboardView();
  if (viewId === 'view-alarm' && typeof openAlarmView === 'function') openAlarmView();
  if (viewId === 'view-inexdrop' && typeof refreshDropUI === 'function') refreshDropUI();
  if (typeof syncDropRail === 'function') syncDropRail(viewId);   // Quick Share <-> P2P side rail (only for those two views)
}

// P2P: move its option controls into the Back line (right side) and put them back on close
function mountP2PBarItems(slot) {
  const wrap = document.createElement('div');
  wrap.className = 'mx-p2p-actions';
  currentMacSubTarget.moved = [];
  ['btn-gen-code', 'code-display-box', 'p2p-expiry-timer', 'btn-exit-room', 'p2p-status-pill'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    currentMacSubTarget.moved.push({ el, parent: el.parentNode, next: el.nextSibling });
    wrap.appendChild(el);
  });
  slot.appendChild(wrap);
}

function closeMacSub() {
  if (!currentMacSubTarget) return;
  const el = document.getElementById(currentMacSubTarget.id);
  if (currentMacSubTarget.moved) {
    for (let i = currentMacSubTarget.moved.length - 1; i >= 0; i--) {
      const m = currentMacSubTarget.moved[i];
      if (m.parent) m.parent.insertBefore(m.el, m.next);
    }
  }
  if (currentMacSubTarget.actions && currentMacSubTarget.actionsParent) {
    currentMacSubTarget.actionsParent.insertBefore(currentMacSubTarget.actions, currentMacSubTarget.actionsNext);
  }
  const actionsSlot = document.getElementById('mac-sub-actions');
  if (actionsSlot) actionsSlot.innerHTML = '';
  if (el && currentMacSubTarget.parent) {
    el.classList.remove('active', 'in-mac-sub');
    currentMacSubTarget.parent.insertBefore(el, currentMacSubTarget.next);
  }
  if (currentMacSubTarget.id === 'view-bt') {
    invokeTauri('bt_discovery', { on: false });
  }
  if (currentMacSubTarget.id === 'view-clipboard' && typeof closeClipboardView === 'function') {
    closeClipboardView();
  }
  currentMacSubTarget = null;
  island.classList.remove('has-rail');
  document.getElementById('mac-right-sub')?.classList.add('hidden');
  document.getElementById('mac-right-home')?.classList.remove('hidden');
}

document.getElementById('mac-sub-back')?.addEventListener('click', () => {
  const sp = document.getElementById('mac-right-sub');
  if (sp && sp.classList.contains('from-bottom') && !sp.classList.contains('sinking')) {
    const host = sp.parentElement;
    host.classList.add('mx-clip');
    sp.classList.add('sinking');                           // goes back down the same way it came
    setTimeout(() => { sp.classList.remove('sinking'); host.classList.remove('mx-clip'); closeMacSub(); }, 210);
  } else closeMacSub();
});

// Mac 2x2 Control Center tiles
// Clicking tile body toggles power directly (just like normal mode); clicking chevron or right-click opens in-place subpanel
document.getElementById('mac-tile-wifi')?.addEventListener('click', (e) => {
  if (e.target.closest('.mx-tile-chev')) openMacSub('view-wifi', 'Wi-Fi');
  else toggleRadio('wifi', !appState.wifiRadio);
});
document.getElementById('mac-tile-wifi')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMacSub('view-wifi', 'Wi-Fi');
});

document.getElementById('mac-tile-bt')?.addEventListener('click', (e) => {
  if (e.target.closest('.mx-tile-chev')) openMacSub('view-bt', 'Bluetooth');
  else toggleRadio('bt', !appState.btRadio);
});
document.getElementById('mac-tile-bt')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMacSub('view-bt', 'Bluetooth');
});

// Same as the classic tile: Quick Share selected = left click anywhere on the tile turns it on / off.
// Only the chevron, an incoming offer / running transfer, or P2P mode (no on/off) goes inside. Right click always goes inside.
document.getElementById('mac-tile-drop')?.addEventListener('click', (e) => {
  if (currentOffer || inTransfer || e.target.closest('.mx-tile-chev')) {
    openMacDrop();
  } else {
    dropTileClick();
  }
});
document.getElementById('mac-tile-drop')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMacDrop();
});

document.getElementById('mac-tray-btn')?.addEventListener('click', () => {
  if (macTrayPaneOpen()) closeMacTrayPane();   // tray icon again = back to the menu
  else openMacTrayView(false);
});

// Mac Quick Actions strip: open right in place inside Control Deck
document.querySelectorAll('#mac-quick-row .mx-q').forEach((btn) => {
  btn.addEventListener('click', () => {
    const act = btn.dataset.action;
    if (act === 'notepad') openMacSub('view-notepad', 'Quick Notes', 'bottom');
    else if (act === 'clipboard') openMacSub('view-clipboard', 'Clipboard', 'bottom');
    else if (act === 'timer') openMacSub('view-timer', 'Focus Timer', 'bottom');
    else if (act === 'alarm') openMacSub('view-alarm', 'Alarm', 'bottom');
    else if (act === 'calendar') openMacSub('view-calendar', 'Calendar', 'bottom');
  });
});

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
    openControlMenu();
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
async function addDroppedPaths(paths, target) {
  const metas = (await tryInvoke('file_info', { paths })) || [];
  let added = 0;
  for (const m of metas) {
    if (appState.trayFiles.some((t) => t.path === m.path)) continue;
    appState.trayFiles.push({ id: trayIdSeq++, name: m.name, size: m.size, path: m.path });
    added++;
  }
  if (!added && !metas.length) { goCompact(); return; } // folders / unreadable items are skipped
  updateTrayUI();
  if (isMacMenu()) {
    if (target === 'drop') macSendToInexDrop(); else openMacTrayView(false);
    return;
  }
  openTrayView();
}

// Only the files ticked in the tray go to the phone (nothing ticked = all of them, like P2P)
function getSelectedTrayFiles() {
  const all = appState.trayFiles || [];
  const picked = all.filter((f) => appState.traySelectedIds && appState.traySelectedIds.has(f.id));
  return picked.length ? picked : [...all];
}

async function stageTrayFilesForPhone() {
  const files = getSelectedTrayFiles().filter((f) => f.path);
  await invokeTauri('clear_staged_files');      // whatever was pushed before must not tag along
  for (const f of files) await invokeTauri('stage_file_for_phone', { path: f.path });
  return files.length;
}

let dropLeaveTimeout = null;

function onNativeDrop(p) {
  if (!p) return;
  if (isMacMenu()) { onNativeDropMac(p); return; }
  if (p.type === 'enter' || p.type === 'over') {
    clearTimeout(dropLeaveTimeout);
    if (!appState.draggingOut && appState.currentView !== 'view-drop') {
      switchView('view-drop', 'state-drop', ISLAND_WIN_W, 92);
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

// ---------- Mac menu mode: tray + Inex Drop open as a two-panel view (Inex Drop | Drop files here) ----------
function isMacMenu() { return !!(SET.appearance && SET.appearance.menuLayout === 'mac'); }
const MAC_TRAY_H = 172;

// which panel is under the mouse (position = client px from the native drag events)
function macDropTargetAt(pos) {
  if (!pos || typeof pos.x !== 'number') return null;
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
  const panel = el && el.closest ? el.closest('#view-tray-mac [data-drop-target]') : null;
  return panel ? panel.dataset.dropTarget : null;
}

function setMacDropHover(t) {
  appState.macDropTarget = t;
  document.querySelectorAll('#view-tray-mac [data-drop-target]').forEach((el) => {
    el.classList.toggle('over', el.dataset.dropTarget === t);
  });
  const sub = document.getElementById('mt-drop-sub');
  if (sub) sub.textContent = t === 'drop' ? 'Release to send' : 'Send to phone';
}

// Tray opened from the Control Deck: the tray (Inex Drop | Drop files here) fills the WHOLE body, only the top strip
// (clock, weather, icons) stays. The Tray icon in the strip toggles it. No resize, no animation.
// (functions + var on purpose: switchView can run before this part has executed)
var macTrayHome = null;
function macTrayPaneOpen() { return !!macTrayHome; }

function openMacTrayPane() {
  const deck = document.getElementById('view-control-mac');
  const tray = document.getElementById('view-tray-mac');
  if (!deck || !tray) return;
  if (macTrayHome) { renderMacTray(); return; }
  if (typeof closeMacSub === 'function') closeMacSub();
  macTrayHome = { parent: tray.parentNode, next: tray.nextSibling };
  deck.appendChild(tray);
  tray.classList.add('active', 'in-mac-tray');
  tray.classList.remove('dragging');
  deck.classList.add('tray-open');
  document.getElementById('mac-tray-btn')?.classList.add('on');
  renderMacTray();
  setMacDropHover(null);
}

function closeMacTrayPane() {
  if (!macTrayHome) return;
  const tray = document.getElementById('view-tray-mac');
  if (tray) {
    tray.classList.remove('active', 'in-mac-tray', 'dragging');
    macTrayHome.parent.insertBefore(tray, macTrayHome.next);
  }
  macTrayHome = null;
  document.getElementById('view-control-mac')?.classList.remove('tray-open');
  document.getElementById('mac-tray-btn')?.classList.remove('on');
}

function openMacTrayView(byDrag) {
  appState.macTrayByDrag = !!byDrag;
  if (!byDrag) {                       // Tray icon / after a drop: inside the Control Deck
    if (appState.currentView !== 'view-control-mac') openControlMenu();
    openMacTrayPane();
    return;
  }
  renderMacTray();
  switchView('view-tray-mac', 'state-tray-mac', ISLAND_WIN_W, MAC_TRAY_H);
  document.getElementById('view-tray-mac')?.classList.toggle('dragging', !!byDrag);
  setMacDropHover(null);
}

function renderMacTray() {
  const files = appState.trayFiles || [];
  const empty = document.getElementById('mt-empty');
  const filled = document.getElementById('mt-filled');
  if (!empty || !filled) return;
  empty.classList.toggle('hidden', files.length > 0);
  filled.classList.toggle('hidden', files.length === 0);
  document.getElementById('mt-count').textContent = `Tray · ${files.length} file${files.length === 1 ? '' : 's'}`;
  const list = document.getElementById('mt-files');
  list.innerHTML = '';
  files.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'mt-file';
    card.title = f.name;
    card.innerHTML = `
      <button class="mt-del" title="Remove file">×</button>
      <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
      <div class="mt-fname">${escHtml(f.name)}</div>`;
    card.querySelector('.mt-del').addEventListener('click', (e) => {
      e.stopPropagation();
      appState.trayFiles = appState.trayFiles.filter((t) => t.id !== f.id);
      if (appState.traySelectedIds) appState.traySelectedIds.delete(f.id);
      updateTrayUI();
    });
    // press + move = drag the file out
    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.mt-del')) return;
      const sx = e.clientX, sy = e.clientY;
      const cleanup = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', cleanup); };
      const move = (ev) => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) { cleanup(); startDragOut(f); }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', cleanup);
    });
    list.appendChild(card);
  });
}

// Dropped / sent to Inex Drop in the Mac menu: whatever mode the side switch has selected is used.
//  Quick Share -> turns on by itself (files are staged for the phone)
//  P2P         -> NO code is generated for you; with a connected peer the files are offered to it, otherwise the
//                 P2P panel opens and you press Generate yourself
async function macSendToInexDrop() {
  const files = appState.trayFiles || [];
  if (getDropMode() === 'p2p') {
    if (files.length && (appState.peers || []).length > 0) {
      appState.peers.forEach((p) => offerFilesToPeer(p.id, [...files]));
    } else if (files.length) {
      showToast('info', 'Press Generate, connect a peer, then send', 2200);
    }
    openMacDrop('p2p');
    return;
  }
  if (files.length > 0) await stageTrayFilesForPhone();
  if (!dropActive) await startInexDrop();
  openMacDrop('qs');
}

function onNativeDropMac(p) {
  if (p.type === 'enter' || p.type === 'over') {
    clearTimeout(dropLeaveTimeout);
    if (appState.draggingOut) return;
    if (macTrayPaneOpen() || appState.currentView === 'view-tray-mac') document.getElementById('view-tray-mac').classList.add('dragging');
    else openMacTrayView(true);
    if (p.position) setMacDropHover(macDropTargetAt(p.position));
  } else if (p.type === 'leave') {
    clearTimeout(dropLeaveTimeout);
    dropLeaveTimeout = setTimeout(() => {
      const inPane = macTrayPaneOpen();
      if (appState.draggingOut || (!inPane && appState.currentView !== 'view-tray-mac')) return;
      setMacDropHover(null);
      document.getElementById('view-tray-mac').classList.remove('dragging');
      if (!inPane && appState.macTrayByDrag) goCompact();   // opened only by the drag: close again. Opened by the Tray icon: stay.
    }, 200);
  } else if (p.type === 'drop') {
    clearTimeout(dropLeaveTimeout);
    if (appState.draggingOut) { appState.draggingOut = false; goCompact(); return; }
    const target = (p.position && macDropTargetAt(p.position)) || appState.macDropTarget || 'tray';
    setMacDropHover(null);
    document.getElementById('view-tray-mac')?.classList.remove('dragging');
    appState.macTrayByDrag = false;
    if (p.paths && p.paths.length) addDroppedPaths(p.paths, target); else goCompact();
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
    onNativeDrop({ type: 'enter', paths, position: e && e.payload && e.payload.position });
  });
  onTauriEvent('shelf-drag-over', (e) => {
    onNativeDrop({ type: 'over', position: e && e.payload && e.payload.position });
  });
  onTauriEvent('shelf-drag-leave', () => {
    onNativeDrop({ type: 'leave' });
  });
  onTauriEvent('shelf-drag-drop', (e) => {
    const paths = e && e.payload && e.payload.paths;
    onNativeDrop({ type: 'drop', paths, position: e && e.payload && e.payload.position });
  });

  // Tauri 2 standard drag-drop handler on webviewWindow / window / webview
  const bindTauriHandler = (w) => {
    if (!w || !w.onDragDropEvent) return false;
    try {
      const r = w.onDragDropEvent((e) => {
        const payload = e && e.payload;
        if (!payload) return;
        if (payload.type === 'enter' || payload.type === 'over') {
          onNativeDrop({ type: 'enter', paths: payload.paths, position: payload.position });
        } else if (payload.type === 'leave') {
          onNativeDrop({ type: 'leave' });
        } else if (payload.type === 'drop') {
          onNativeDrop({ type: 'drop', paths: payload.paths, position: payload.position });
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
  onTauriEvent('tauri://drag-enter', (e) => onNativeDrop({ type: 'enter', paths: e?.payload?.paths, position: e?.payload?.position }));
  onTauriEvent('tauri://drag-over', (e) => onNativeDrop({ type: 'over', paths: e?.payload?.paths, position: e?.payload?.position }));
  onTauriEvent('tauri://drag-leave', () => onNativeDrop({ type: 'leave' }));
  onTauriEvent('tauri://drag-drop', (e) => onNativeDrop({ type: 'drop', paths: e?.payload?.paths, position: e?.payload?.position }));

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
  if (isMacMenu()) { openMacTrayView(false); return; }
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
  const macTrayBadge = document.getElementById('mac-tray-badge');
  if (macTrayBadge) { macTrayBadge.textContent = count; macTrayBadge.classList.toggle('hidden', count === 0); }
  document.getElementById('mac-tray-btn')?.setAttribute('title', `File Tray (${count} File${count === 1 ? '' : 's'})`);
  document.getElementById('c-tray-btn').classList.toggle('hidden', count === 0);
  if (typeof renderMacTray === 'function') renderMacTray();
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

document.getElementById('mt-clear')?.addEventListener('click', () => {
  appState.trayFiles = [];
  if (appState.traySelectedIds) appState.traySelectedIds.clear();
  updateTrayUI();
});

// Left panel of the Mac tray view = Inex Drop
document.getElementById('mt-drop')?.addEventListener('click', () => macSendToInexDrop());

document.getElementById('btn-clear-tray').addEventListener('click', () => {
  appState.trayFiles = [];
  appState.traySelect = null;
  if (appState.traySelectedIds) appState.traySelectedIds.clear();
  document.getElementById('tray-peer-picker').classList.add('hidden');
  updateTrayUI();
});

// The tray has ONE share button. What it does depends on the mode selected inside Inex Drop.
document.getElementById('btn-tray-inexdrop')?.addEventListener('click', async () => {
  if (getDropMode() === 'p2p') { trayP2PShare(); return; }
  if (appState.trayFiles && appState.trayFiles.length > 0) {
    await stageTrayFilesForPhone();
  }
  if (typeof openDropView === 'function') openDropView();
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
      openP2PView();
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

function trayP2PShare() {
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
    reportIslandSize({ width: ISLAND_WIN_W, height: 218 });
    return;
  }
  appState.traySelect = null;
  renderPeerPicker();
  island.classList.add('picker-open');
  reportIslandSize({ width: ISLAND_WIN_W, height: 252 });
}

function sendTrayFiles(peerId, files) {
  appState.traySelect = null;
  goCompact();
  offerFilesToPeer(peerId, files);
  updateTrayUI();
}


// ==================== 08. P2P PEERS (WebRTC DATA CHANNEL, NO SERVER) ====================
// How a link is made (host code / reply code) lives in 09b. This part owns what happens once a peer
// exists: data channel, heartbeat, ordered message queue, cleanup. Nothing here runs until a peer connects.

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
  if (peerId === 'direct-peer') {
    closeDirectSessions();
    setDirectState({ phase: 'standby' });   // link is gone: back to the Generate / paste screen
  }
  syncConnectedPeersList();
  refreshTransferUI();
}

function disconnectPeer(peerId) {
  const entry = rtcPeers.get(peerId);
  if (entry && entry.dc && entry.dc.readyState === 'open') {
    try { entry.dc.send(JSON.stringify({ type: 'bye', peerId: myPeerId })); } catch (_) {}
  }
  cleanupPeer(peerId);
  showToast('unlock', 'Disconnected', 1400);
}

window.addEventListener('beforeunload', () => {
  for (const entry of rtcPeers.values()) {
    try { if (entry.dc && entry.dc.readyState === 'open') entry.dc.send('{"type":"bye"}'); } catch (_) {}
  }
});
// ==================== 09b. P2P LINK: DIRECT 1-ON-1, NO SERVER ====================
// Nothing runs (no RTCPeerConnection, no timer, no network) until you press Generate or paste a code.
// Handshake = two short copy-paste codes:
//   HOST   : Generate -> host code (click it to copy) -> send it to the friend
//   FRIEND : paste / drop it in the box -> a reply code is made (and copied) -> send it back
//   HOST   : paste / drop the reply code in the same box -> connected
// A code is valid for 3 minutes (CODE_TTL_MS) and is dead as soon as the link is up.
// (var + functions on purpose: other parts call these before this part has run)

var directHostSession = null;   // { pc, dc, sid, code, expiresAt }
var directJoinSession = null;   // { pc, replyCode, expiresAt }
var directTimer = null;         // 3-minute expiry of the code that is waiting
var directTick = null;          // 1 s countdown in the header
var directGenSeq = 0;           // Cancel bumps it, so a half-made code is thrown away
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
    case 'generating': return 'Creating your code…';
    case 'offer-ready': return 'Click the code to copy it and send it to your friend. Then paste their reply code above.';
    case 'joining': return 'Joining…';
    case 'reply-ready': return 'Reply code copied. Send it back to your friend (valid 3 minutes).';
    case 'connecting': return 'Connecting…';
    default: return 'Generate a code, or paste a code from your friend.';
  }
}

function directCodePreview(code) {
  const flat = String(code || '').replace(/[\s-]/g, '');
  return flat.length > 14 ? `${flat.slice(0, 9)} … ${flat.slice(-4)}` : flat;
}

function updateDirectCountdown() {
  const el = document.getElementById('p2p-expiry-timer');
  if (!el || !directUi.expiresAt) return;
  const rem = Math.max(0, Math.floor((directUi.expiresAt - Date.now()) / 1000));
  el.textContent = `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
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

  gen.classList.toggle('hidden', connected || !(ph === 'standby' || ph === 'generating'));
  gen.classList.toggle('busy', ph === 'generating');
  gen.textContent = ph === 'generating' ? 'Generating…' : 'Generate';

  const box = $('code-display-box');
  const codeEl = $('my-p2p-code');
  const code = hosting ? directUi.code : (replying ? directUi.replyCode : '');
  box.classList.toggle('hidden', !code);
  if (code) {
    if (box.dataset.shown !== code) {          // a new code: small pop-in animation
      box.dataset.shown = code;
      box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop');
    }
    if (!box.classList.contains('copied')) codeEl.textContent = directCodePreview(code);
  } else {
    box.dataset.shown = '';
    box.classList.remove('copied');
  }

  const joinBox = $('p2p-join-box');
  joinBox.classList.toggle('hidden', connected || !(ph === 'standby' || ph === 'offer-ready'));
  const inp = $('input-peer-code');
  if (inp) inp.placeholder = hosting ? 'Paste friend\u2019s reply code' : 'Paste or drop code';
  const joinBtn = $('btn-join-code');
  if (joinBtn) joinBtn.textContent = hosting ? 'Connect' : 'Join';

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
    try {
      await navigator.clipboard.writeText(replyCode);
      showToast('done', 'Reply code copied', 1600);
    } catch (_) {}
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
  $('btn-gen-code')?.addEventListener('click', handleDirectGenOffer);
  $('btn-exit-room')?.addEventListener('click', handleDirectDisconnect);

  const inp = $('input-peer-code');
  const submit = () => { if (inp && handleDirectCodeInput(inp.value)) inp.value = ''; };
  $('btn-join-code')?.addEventListener('click', submit);
  inp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  inp?.addEventListener('paste', (e) => {          // pasting a code starts it straight away
    const t = ((e.clipboardData || window.clipboardData).getData('text') || '').trim();
    if (!t) return;
    e.preventDefault();
    inp.value = handleDirectCodeInput(t) ? '' : t;
  });

  // click the code = copy it
  const box = $('code-display-box');
  box?.addEventListener('animationend', () => box.classList.remove('pop'));
  box?.addEventListener('click', async () => {
    const code = directUi.phase === 'reply-ready' ? directUi.replyCode : directUi.code;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); } catch (_) { showToast('lock', 'Copy failed', 1500); return; }
    box.classList.add('copied');
    $('my-p2p-code').textContent = 'Copied ✓';
    clearTimeout(box._copyT);
    box._copyT = setTimeout(() => { box.classList.remove('copied'); renderP2PView(); }, 1200);
  });

  // drop a text code anywhere on the view (files keep going to the tray)
  const body = $('p2p-body');
  const hasText = (e) => {
    const t = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    return t.includes('text/plain') && !t.includes('Files');
  };
  ['dragenter', 'dragover'].forEach((n) => body?.addEventListener(n, (e) => {
    if (!hasText(e)) return;
    e.preventDefault(); e.stopPropagation();
    body.classList.add('drop-over');
  }));
  body?.addEventListener('dragleave', () => body.classList.remove('drop-over'));
  body?.addEventListener('drop', (e) => {
    body.classList.remove('drop-over');
    if (!hasText(e)) return;
    e.preventDefault(); e.stopPropagation();
    handleDirectCodeInput(e.dataTransfer.getData('text/plain'));
  });
})();
// ======================================================================================
// Quick Share: Native offline local file sharing with Android & Windows devices
// Reverse-engineered Google Nearby / Quick Share protocol over Wi-Fi / LAN & Bluetooth
// ======================================================================================

let dropActive = false;
let inTransfer = false;
let isScanning = false;
let transferPaused = false;
let selectedFiles = [];
const discoveredDevices = new Map();
let currentOffer = null;
let offerExpireTimer = null;
let xferHideTimer = null;
let lastSendSuccess = false;
let selListOpen = false;

function fileCategory(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)) return 'image';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'apk'].includes(ext)) return 'zip';
  return 'file';
}

const FILE_ICONS = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  zip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><rect x="10" y="8" width="4" height="4" rx="1"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6z"/><polyline points="15 2 15 6 19 6"/><path d="M4 7v13a2 2 0 0 0 2 2h9"/></svg>'
};

function getFileIcon(name) {
  return FILE_ICONS[fileCategory(name)] || FILE_ICONS.file;
}

function getBatchIcon(names) {
  if (!names || names.length <= 1) return getFileIcon((names && names[0]) || '');
  const cats = new Set(names.map(fileCategory));
  return cats.size === 1 ? FILE_ICONS[[...cats][0]] : FILE_ICONS.files;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function promptTitle(p) {
  const count = p.count || 1;
  return count > 1 ? `${count} files` : (p.name || 'File');
}

// Island notch prompt HUD
function showPromptHud(p) {
  playStatusSound('transfer', 'transfer');
  if (typeof showDeviceHud === 'function') {
    showDeviceHud({
      iconHTML: getBatchIcon(p.names || [p.name]),
      plain: true,
      name: promptTitle(p),
      tag: `${fmtBytes(p.size || p.total)} • ${p.device || 'Phone'}`,
      actions: true,
      ms: 15000
    });
  }
}

function closePromptHud(instant) {
  if (typeof hideDeviceHud === 'function' && typeof btHudPrompt !== 'undefined' && btHudPrompt) {
    hideDeviceHud(!!instant);
  }
}

function clearPrompt() {
  currentOffer = null;
  clearTimeout(offerExpireTimer);
  closePromptHud(true);
  if (typeof updateDropTile === 'function') updateDropTile();
}

// ONE menu size for Quick Share and P2P (the P2P panel size)
var DROP_W = 316, DROP_H = 208;

function openQsView() {
  if (SET.appearance && SET.appearance.menuLayout === 'mac') { openMacDrop('qs'); return; }
  switchView('view-inexdrop', 'state-sub', DROP_W, DROP_H);
  refreshDropUI();
}

function openP2PView() {
  if (SET.appearance && SET.appearance.menuLayout === 'mac') { openMacDrop('p2p'); return; }
  switchView('view-p2p', 'state-sub', DROP_W, DROP_H);
}

// Opens whichever mode is selected (chevron, right click, tray, quick action)
function openDropView() {
  if (getDropMode() === 'p2p') openP2PView(); else openQsView();
}

// Tile left click: Quick Share = turn on / off, P2P = go inside (P2P has no on / off)
function dropTileClick() {
  if (getDropMode() === 'p2p') openP2PView(); else toggleInexDrop();
}

async function refreshDropUI() {
  let status = null;
  try {
    status = await invokeTauri('get_quick_share_status');
  } catch (_) {}

  dropActive = !!(status && status.running);

  const tileDrop = document.getElementById('tile-drop');
  if (tileDrop) {
    tileDrop.classList.toggle('active', dropActive);
  }
  const macDrop = document.getElementById('mac-tile-drop');
  if (macDrop) macDrop.classList.toggle('active', dropActive);

  const dropText = inTransfer ? 'Transferring' : (dropActive ? 'Ready' : 'Off');
  const subEl = document.getElementById('tile-drop-sub');
  if (subEl) subEl.textContent = dropText;
  const macDropSub = document.getElementById('mac-drop-sub');
  if (macDropSub) macDropSub.textContent = dropText;

  if (typeof updateDropTile === 'function') updateDropTile();

  const pill = document.getElementById('drop-status-pill');
  const toggle = document.getElementById('qs-master-toggle');
  if (toggle) toggle.checked = dropActive;

  const boxIdle = document.getElementById('drop-state-idle');
  const boxActive = document.getElementById('drop-state-active');
  const boxPrompt = document.getElementById('drop-state-prompt');

  if (currentOffer) {
    if (pill) { pill.textContent = 'Incoming...'; pill.className = 'status-tag warn'; }
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxActive) boxActive.classList.add('hidden');
    if (boxPrompt) boxPrompt.classList.remove('hidden');

    const devEl = document.getElementById('prompt-sender-name');
    const fileEl = document.getElementById('prompt-file-name');
    const sizeEl = document.getElementById('prompt-file-size');
    const iconEl = document.getElementById('prompt-file-icon');
    const pinEl = document.getElementById('prompt-pin');

    const firstFile = (currentOffer.files && currentOffer.files[0]) || {};
    const fName = firstFile.name || 'File';
    const displayTitle = (currentOffer.count || 1) > 1
      ? `${currentOffer.count} files (incl. ${fName})`
      : fName;

    if (devEl) devEl.textContent = currentOffer.device || 'Android Device';
    if (fileEl) fileEl.textContent = displayTitle;
    if (sizeEl) sizeEl.textContent = fmtBytes(currentOffer.total || firstFile.size);
    if (iconEl) iconEl.innerHTML = getBatchIcon(currentOffer.files ? currentOffer.files.map(f => f.name) : [fName]);
    if (pinEl) pinEl.textContent = currentOffer.pin || '----';

    if (typeof updateDropTile === 'function') updateDropTile();
    return;
  }
  if (boxPrompt) boxPrompt.classList.add('hidden');

  if (!dropActive) {
    if (pill) { pill.textContent = 'Off'; pill.className = 'status-tag'; }
    if (boxIdle) boxIdle.classList.remove('hidden');
    if (boxActive) boxActive.classList.add('hidden');
    return;
  }

  // Active
  if (pill) {
    if (inTransfer) {
      pill.textContent = 'Transferring'; pill.className = 'status-tag ok';
    } else if (isScanning) {
      pill.textContent = 'Scanning...'; pill.className = 'status-tag warn';
    } else {
      pill.textContent = 'Ready'; pill.className = 'status-tag ok';
    }
  }

  if (boxIdle) boxIdle.classList.add('hidden');
  if (boxActive) { boxActive.classList.remove('hidden'); boxActive.classList.toggle('is-xfer', !!inTransfer); }

  const myNameEl = document.getElementById('qs-my-name');
  if (myNameEl && status && status.device_name) {
    myNameEl.textContent = status.device_name;
  }

  // Sync staged files from Rust if selectedFiles is empty
  if (selectedFiles.length === 0) {
    try {
      const staged = await invokeTauri('get_staged_quick_share_files');
      if (Array.isArray(staged) && staged.length > 0) {
        selectedFiles = staged;
      }
    } catch (_) {}
  }

  renderSelection();
}

function renderSelection() {
  const box = document.getElementById('qs-selected-box');
  const txt = document.getElementById('qs-selected-text');
  const list = document.getElementById('qs-selected-list');
  const hint = document.getElementById('qs-scan-hint');
  const scanTxt = document.getElementById('qs-scan-text');

  if (!box || !txt) return;

  if (selectedFiles.length === 0) {
    box.classList.add('hidden');
    box.classList.remove('open');
    if (list) { list.classList.add('hidden'); list.innerHTML = ''; }
    selListOpen = false;
    if (hint) { hint.classList.add('idle'); }
    if (scanTxt) scanTxt.textContent = 'Pick files to find nearby devices';
    clearDiscoveredDevices();
    stopScanning();
    return;
  }

  box.classList.remove('hidden');
  // one file: its name; more: only a number (tap the chip to see what is inside)
  txt.textContent = selectedFiles.length === 1
    ? baseName(selectedFiles[0])
    : `${selectedFiles.length} items selected`;

  if (list) {
    list.innerHTML = '';
    selectedFiles.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'qs-sel-row';
      row.textContent = baseName(f);
      row.title = f;
      list.appendChild(row);
    });
    list.classList.toggle('hidden', !selListOpen);
  }
  box.classList.toggle('open', selListOpen);

  if (hint) {
    hint.classList.remove('idle');
    if (scanTxt) {
      scanTxt.textContent = discoveredDevices.size > 0
        ? 'Nearby devices'
        : 'Looking for nearby devices...';
    }
  }

  if (dropActive && !inTransfer && !isScanning) {
    startScanning();
  }
}

async function startScanning() {
  if (!dropActive || inTransfer || isScanning) return;
  try {
    isScanning = true;
    await invokeTauri('start_quick_share_scan');
    const pill = document.getElementById('drop-status-pill');
    if (pill && !inTransfer) {
      pill.textContent = 'Scanning...'; pill.className = 'status-tag warn';
    }
  } catch (err) {
    console.error('start_quick_share_scan error:', err);
  }
}

async function stopScanning() {
  if (!isScanning) return;
  isScanning = false;
  try {
    await invokeTauri('stop_quick_share_scan');
  } catch (_) {}
  const pill = document.getElementById('drop-status-pill');
  if (pill && dropActive && !inTransfer) {
    pill.textContent = 'Ready'; pill.className = 'status-tag ok';
  }
}

function clearDiscoveredDevices() {
  discoveredDevices.clear();
  const list = document.getElementById('qs-devices-list');
  if (list) list.innerHTML = '';
}

function addDiscoveredDevice(dev) {
  const key = dev.key || `${dev.ip}:${dev.port}`;
  if (discoveredDevices.has(key)) return;
  discoveredDevices.set(key, dev);

  const list = document.getElementById('qs-devices-list');
  if (!list) return;

  const item = document.createElement('div');
  item.className = 'qs-device-item';
  item.dataset.key = key;

  const isPc = dev.dev_type === 3;
  const avatarIcon = isPc
    ? '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';

  item.innerHTML = `
    <div class="qs-device-avatar">${avatarIcon}</div>
    <div style="flex:1;min-width:0;">
      <div class="qs-device-name">${escapeHtml(dev.name)}</div>
    </div>
  `;

  item.addEventListener('click', () => {
    sendFilesToDevice(dev);
  });

  list.appendChild(item);

  const scanTxt = document.getElementById('qs-scan-text');
  if (scanTxt && selectedFiles.length > 0) {
    scanTxt.textContent = 'Nearby devices';
  }
}

function removeDiscoveredDevice(key) {
  discoveredDevices.delete(key);
  const el = document.querySelector(`.qs-device-item[data-key="${key}"]`);
  if (el) el.remove();

  const scanTxt = document.getElementById('qs-scan-text');
  if (scanTxt && selectedFiles.length > 0 && discoveredDevices.size === 0) {
    scanTxt.textContent = 'Looking for nearby devices...';
  }
}

async function sendFilesToDevice(dev) {
  if (!selectedFiles.length) {
    showToast('info', 'Choose files to send first');
    return;
  }
  if (inTransfer) {
    showToast('warn', 'Transfer already in progress');
    return;
  }

  showTransferBox('Sending', `Connecting to ${dev.name}...`, true);

  // Compact island transfer notification
  if (typeof startCompactTransferUI === 'function') {
    appState.xferDir = 'send';
    startCompactTransferUI();
  }

  try {
    const ok = await invokeTauri('send_quick_share_files', {
      name: dev.name,
      ip: dev.ip,
      port: dev.port,
      devType: dev.dev_type || 1,
      instance: dev.instance || '',
      paths: selectedFiles
    });
    if (ok === false) {
      showToast('warn', 'Transfer rejected or busy');
      endTransfer(2000);
    }
  } catch (err) {
    showToast('error', `Send error: ${err}`);
    endTransfer(2000);
  }
}

function showTransferBox(title, sub, canPause) {
  inTransfer = true;
  transferPaused = false;
  clearTimeout(xferHideTimer);

  document.getElementById('drop-state-active')?.classList.add('is-xfer');
  const box = document.getElementById('qs-transfer-box');
  const tTitle = document.getElementById('qs-xfer-title');
  const tSub = document.getElementById('qs-xfer-sub');
  const tBar = document.getElementById('qs-xfer-bar');
  const tPct = document.getElementById('qs-xfer-pct');
  const tSpeed = document.getElementById('qs-xfer-speed');
  const tPin = document.getElementById('qs-xfer-pin');
  const pauseBtn = document.getElementById('btn-qs-pause');
  const cancelBtn = document.getElementById('btn-qs-cancel');

  if (box) box.classList.remove('hidden');
  if (tTitle) tTitle.textContent = title;
  if (tSub) tSub.textContent = sub;
  if (tBar) tBar.style.width = '0%';
  if (tPct) tPct.textContent = '0%';
  if (tSpeed) tSpeed.textContent = '';
  if (tPin) tPin.classList.add('hidden');
  if (pauseBtn) {
    pauseBtn.textContent = 'Pause';
    pauseBtn.classList.toggle('hidden', !canPause);
  }
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.classList.remove('hidden');
  }

  const pill = document.getElementById('drop-status-pill');
  if (pill) { pill.textContent = 'Transferring'; pill.className = 'status-tag ok'; }
}

function endTransfer(delay = 2800) {
  clearTimeout(xferHideTimer);
  xferHideTimer = setTimeout(() => {
    const box = document.getElementById('qs-transfer-box');
    if (box) box.classList.add('hidden');
    inTransfer = false;
    document.getElementById('drop-state-active')?.classList.remove('is-xfer');
    refreshDropUI();
  }, delay);

  if (typeof finishCompactTransferUI === 'function') {
    finishCompactTransferUI();
  }
}

function activateOfferPrompt(offer) {
  currentOffer = offer;
  clearTimeout(offerExpireTimer);

  offerExpireTimer = setTimeout(() => {
    if (currentOffer && currentOffer.pin === offer.pin) {
      declineTransferPrompt(true);
    }
  }, 60000);

  const devEl = document.getElementById('prompt-sender-name');
  const fileEl = document.getElementById('prompt-file-name');
  const sizeEl = document.getElementById('prompt-file-size');
  const iconEl = document.getElementById('prompt-file-icon');
  const pinEl = document.getElementById('prompt-pin');

  const firstFile = (offer.files && offer.files[0]) || {};
  const fName = firstFile.name || 'File';
  const displayTitle = (offer.count || 1) > 1
    ? `${offer.count} files (incl. ${fName})`
    : fName;

  if (devEl) devEl.textContent = offer.device || 'Android Device';
  if (fileEl) fileEl.textContent = displayTitle;
  if (sizeEl) sizeEl.textContent = fmtBytes(offer.total || firstFile.size);
  if (iconEl) iconEl.innerHTML = getBatchIcon(offer.files ? offer.files.map(f => f.name) : [fName]);
  if (pinEl) pinEl.textContent = offer.pin || '----';

  // Always refresh the Drop UI so #drop-state-prompt is unhidden and ready in DOM
  refreshDropUI();

  // If user is NOT currently inside Inex Drop (neither classic view nor Mac subview),
  // show the island notch prompt HUD
  const isViewingDrop = (appState.currentView === 'view-inexdrop') ||
    (appState.currentView === 'view-control-mac' && typeof currentMacSubTarget !== 'undefined' && currentMacSubTarget && currentMacSubTarget.id === 'view-inexdrop');

  if (!isViewingDrop) {
    showPromptHud({
      name: displayTitle,
      size: offer.total || firstFile.size,
      device: offer.device || 'Phone',
      count: offer.count || 1,
      names: offer.files ? offer.files.map(f => f.name) : [fName]
    });
  }
}

async function acceptTransferPrompt() {
  if (!currentOffer) return;
  clearTimeout(offerExpireTimer);
  closePromptHud();
  currentOffer = null;

  showTransferBox('Receiving', 'Accepted! Starting transfer...', true);

  if (typeof startCompactTransferUI === 'function') {
    appState.xferDir = 'recv';
    startCompactTransferUI();
  }

  await invokeTauri('respond_quick_share_offer', { accept: true });
  refreshDropUI();
}

async function declineTransferPrompt(silent = false) {
  if (!currentOffer) return;
  clearTimeout(offerExpireTimer);
  closePromptHud();
  currentOffer = null;

  await invokeTauri('respond_quick_share_offer', { accept: false });
  refreshDropUI();
  if (!silent) {
    showToast('unphone', 'Transfer declined', 1800);
  }
}

async function startInexDrop() {
  try {
    const res = await invokeTauri('start_quick_share');
    if (res) {
      dropActive = true;
      refreshDropUI();
      showToast('done', 'Quick Share is Ready', 1500);
    }
  } catch (err) {
    showToast('error', 'Could not start Quick Share: ' + err);
  }
}

async function stopInexDrop() {
  try {
    await invokeTauri('stop_quick_share');
    dropActive = false;
    inTransfer = false;
    clearDiscoveredDevices();
    refreshDropUI();
    showToast('info', 'Quick Share is Off', 1500);
  } catch (_) {}
}

async function toggleInexDrop() {
  if (dropActive) {
    await stopInexDrop();
  } else {
    await startInexDrop();
  }
}

// Global Quick Share Event Listener
onTauriEvent('quickshare-event', (event) => {
  let p = event.payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (_) {}
  }
  if (!p || typeof p !== 'object') return;

  switch (p.type) {
    case 'started': {
      dropActive = true;
      refreshDropUI();
      break;
    }
    case 'stopped': {
      dropActive = false;
      inTransfer = false;
      clearPrompt();
      clearDiscoveredDevices();
      refreshDropUI();
      break;
    }
    case 'scan_started': {
      isScanning = true;
      refreshDropUI();
      break;
    }
    case 'scan_stopped': {
      isScanning = false;
      refreshDropUI();
      break;
    }
    case 'device': {
      addDiscoveredDevice(p);
      break;
    }
    case 'device_gone': {
      removeDiscoveredDevice(p.key);
      break;
    }
    case 'offer': {
      activateOfferPrompt(p);
      break;
    }
    case 'offer_closed': {
      clearPrompt();
      refreshDropUI();
      break;
    }
    case 'send_started': {
      lastSendSuccess = false;
      showTransferBox('Sending', `Connecting to ${p.device || 'device'}...`, true);
      break;
    }
    case 'send_pin': {
      const pinEl = document.getElementById('qs-xfer-pin');
      const subEl = document.getElementById('qs-xfer-sub');
      if (pinEl) {
        pinEl.textContent = p.pin;
        pinEl.classList.remove('hidden');
      }
      if (subEl) subEl.textContent = 'Check matching PIN on phone...';
      break;
    }
    case 'send_waiting': {
      const subEl = document.getElementById('qs-xfer-sub');
      if (subEl) subEl.textContent = 'Waiting for phone to tap Accept...';
      break;
    }
    case 'send_accepted': {
      const pinEl = document.getElementById('qs-xfer-pin');
      const subEl = document.getElementById('qs-xfer-sub');
      if (pinEl) pinEl.classList.add('hidden');
      if (subEl) subEl.textContent = 'Phone accepted! Transmitting...';
      break;
    }
    case 'rx_accepted': {
      showTransferBox('Receiving', `Receiving from ${p.device || 'phone'}...`, true);
      break;
    }
    case 'xfer_paused': {
      transferPaused = true;
      const btnPause = document.getElementById('btn-qs-pause');
      if (btnPause) btnPause.textContent = 'Resume';
      const tSpeed = document.getElementById('qs-xfer-speed');
      if (tSpeed) tSpeed.textContent = 'Paused';
      const tPct = document.getElementById('qs-xfer-pct');
      const curPct = tPct ? parseInt(tPct.textContent) || 0 : 0;
      if (typeof updateCompactTransferPct === 'function') {
        updateCompactTransferPct(curPct, 'Paused');
      }
      break;
    }
    case 'xfer_resumed': {
      transferPaused = false;
      const btnPause = document.getElementById('btn-qs-pause');
      if (btnPause) btnPause.textContent = 'Pause';
      break;
    }
    case 'progress': {
      appState.xferDir = p.dir === 'rx' ? 'recv' : 'send';
      if (!inTransfer) {
        showTransferBox(p.dir === 'rx' ? 'Receiving' : 'Sending', p.name || 'Transferring...', true);
      }
      if (!appState.transferring && typeof startCompactTransferUI === 'function') {
        startCompactTransferUI();
      }
      const pinEl = document.getElementById('qs-xfer-pin');
      if (pinEl) pinEl.classList.add('hidden');

      const pctNum = Math.min(100, Math.max(0, Number(p.pct) || 0));
      const mbpsNum = Number(p.mbps) || 0;
      const speedStr = transferPaused ? 'Paused' : (mbpsNum > 0 ? `${mbpsNum.toFixed(1)} MB/s` : '');

      const tBar = document.getElementById('qs-xfer-bar');
      const tPct = document.getElementById('qs-xfer-pct');
      const tSpeed = document.getElementById('qs-xfer-speed');
      const tSub = document.getElementById('qs-xfer-sub');

      if (tBar) tBar.style.width = `${pctNum}%`;
      if (tPct) tPct.textContent = `${Math.round(pctNum)}%`;
      if (tSpeed) tSpeed.textContent = speedStr;
      if (tSub && p.name) {
        tSub.textContent = p.files > 1
          ? `${p.name} (${p.file_index || 1}/${p.files})`
          : p.name;
      }

      if (typeof updateCompactTransferPct === 'function') {
        updateCompactTransferPct(Math.round(pctNum), speedStr, p.name);
      }
      break;
    }
    case 'send_done': {
      lastSendSuccess = true;
      const tBar = document.getElementById('qs-xfer-bar');
      const tPct = document.getElementById('qs-xfer-pct');
      const tSub = document.getElementById('qs-xfer-sub');
      if (tBar) tBar.style.width = '100%';
      if (tPct) tPct.textContent = '100%';
      if (tSub) {
        const mb = Number(p.mb || 0).toFixed(1);
        const s = Number(p.secs || 0).toFixed(1);
        const sp = Number(p.mbps || 0).toFixed(1);
        tSub.textContent = `Done! ${mb} MB in ${s}s (${sp} MB/s)`;
      }

      if (typeof showDeviceHud === 'function') {
        const sentSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
        showDeviceHud({
          iconHTML: sentSvg,
          plain: true,
          accent: 'ok',
          name: 'Files sent',
          tag: 'Sent to Phone',
          ms: 3000
        });
      }
      showToast('done', 'Files sent successfully!', 2000);
      break;
    }
    case 'send_finished': {
      if (p.cancelled) {
        showToast('warn', 'Transfer cancelled');
      }
      endTransfer(p.cancelled ? 600 : 3000);
      if (lastSendSuccess || p.cancelled) {
        selectedFiles = [];
        try { invokeTauri('clear_staged_quick_share_files'); } catch (_) {}
        clearDiscoveredDevices();
        renderSelection();
      }
      break;
    }
    case 'file_done': {
      // a toast here covers the progress pill between two files of one batch: the final "All files saved" toast is enough
      if (!appState.transferring) showToast('done', `Saved: ${p.name}`);
      break;
    }
    case 'rx_session_end': {
      clearPrompt();
      if (p.ok) {
        playStatusSound('transfer', 'transfer');
        const tBar = document.getElementById('qs-xfer-bar');
        const tPct = document.getElementById('qs-xfer-pct');
        const tSub = document.getElementById('qs-xfer-sub');
        if (tBar) tBar.style.width = '100%';
        if (tPct) tPct.textContent = '100%';
        if (tSub) tSub.textContent = 'All files received!';

        if (typeof showDeviceHud === 'function') {
          const dlDoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
          showDeviceHud({
            iconHTML: dlDoneSvg,
            plain: true,
            accent: 'ok',
            name: 'Files received',
            tag: 'Saved to Downloads',
            ms: 3500
          });
        }
        showToast('done', 'All files saved to Downloads', 2500);
      } else if (p.cancelled) {
        showToast('warn', 'Transfer cancelled');
      } else if (p.error) {
        showToast('error', `Transfer error: ${p.error}`, 4000);
      }
      endTransfer(p.cancelled ? 600 : 2500);
      break;
    }
    case 'error': {
      showToast('error', p.message || 'Quick Share error');
      endTransfer(1500);
      break;
    }
  }
});

function initInexDrop() {
  const tileDrop = document.getElementById('tile-drop');
  if (tileDrop) {
    tileDrop.addEventListener('click', (e) => {
      if (currentOffer || inTransfer || e.target.closest('.chev') || e.target.closest('.label') || e.target.closest('.sub')) return openDropView();
      dropTileClick();
    });
    tileDrop.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openDropView();
    });
  }

  const qsToggle = document.getElementById('qs-master-toggle');
  if (qsToggle) {
    qsToggle.addEventListener('change', () => {
      if (qsToggle.checked) {
        startInexDrop();
      } else {
        stopInexDrop();
      }
    });
  }

  const btnStart = document.getElementById('btn-drop-start');
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      startInexDrop();
    });
  }

  const btnOpenDl = document.getElementById('btn-qs-open-downloads');
  if (btnOpenDl) {
    btnOpenDl.addEventListener('click', () => {
      invokeTauri('open_quick_share_downloads');
    });
  }

  let isPickingFiles = false;
  const btnPickFiles = document.getElementById('btn-qs-pick-files');
  if (btnPickFiles) {
    btnPickFiles.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isPickingFiles) return;
      isPickingFiles = true;
      appState.keepOpen = true;
      try {
        const picked = await invokeTauri('pick_quick_share_files');
        if (Array.isArray(picked) && picked.length > 0) {
          selectedFiles = [...new Set([...selectedFiles, ...picked])];
          await invokeTauri('stage_quick_share_files', { paths: selectedFiles });
          renderSelection();
        }
      } catch (err) {
        console.error('pick files err:', err);
      } finally {
        isPickingFiles = false;
        setTimeout(() => { appState.keepOpen = false; }, 350);
      }
    });
  }

  let isPickingFolder = false;
  const btnPickFolder = document.getElementById('btn-qs-pick-folder');
  if (btnPickFolder) {
    btnPickFolder.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isPickingFolder) return;
      isPickingFolder = true;
      appState.keepOpen = true;
      try {
        const folder = await invokeTauri('pick_quick_share_folder');
        if (folder) {
          selectedFiles = [...new Set([...selectedFiles, folder])];
          await invokeTauri('stage_quick_share_files', { paths: selectedFiles });
          renderSelection();
        }
      } catch (err) {
        console.error('pick folder err:', err);
      } finally {
        isPickingFolder = false;
        setTimeout(() => { appState.keepOpen = false; }, 350);
      }
    });
  }

  document.getElementById('btn-qs-sel-toggle')?.addEventListener('click', () => {
    selListOpen = !selListOpen;
    renderSelection();
  });

  const btnClearSel = document.getElementById('btn-qs-clear-sel');
  if (btnClearSel) {
    btnClearSel.addEventListener('click', async () => {
      selectedFiles = [];
      try { await invokeTauri('clear_staged_quick_share_files'); } catch (_) {}
      clearDiscoveredDevices();
      stopScanning();
      renderSelection();
    });
  }

  const btnPause = document.getElementById('btn-qs-pause');
  if (btnPause) {
    btnPause.addEventListener('click', () => {
      transferPaused = !transferPaused;
      btnPause.textContent = transferPaused ? 'Resume' : 'Pause';
      const tSpeed = document.getElementById('qs-xfer-speed');
      if (tSpeed) tSpeed.textContent = transferPaused ? 'Paused' : '';
      if (typeof updateCompactTransferPct === 'function') {
        const tPct = document.getElementById('qs-xfer-pct');
        const curPct = tPct ? parseInt(tPct.textContent) || 0 : 0;
        updateCompactTransferPct(curPct, transferPaused ? 'Paused' : '');
      }
      invokeTauri('control_quick_share', { cmd: transferPaused ? 'p' : 'r' });
    });
  }

  const btnCancel = document.getElementById('btn-qs-cancel');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      invokeTauri('control_quick_share', { cmd: 'c' });
      const tSub = document.getElementById('qs-xfer-sub');
      if (tSub) tSub.textContent = 'Cancelling...';
      btnCancel.disabled = true;
    });
  }

  // Island notch HUD Accept / Decline buttons
  document.getElementById('btn-hud-accept')?.addEventListener('click', (e) => {
    e.stopPropagation();
    acceptTransferPrompt();
  });
  document.getElementById('btn-hud-decline')?.addEventListener('click', (e) => {
    e.stopPropagation();
    declineTransferPrompt();
  });

  // Subview Accept / Decline buttons
  document.getElementById('btn-prompt-accept')?.addEventListener('click', () => {
    acceptTransferPrompt();
  });
  document.getElementById('btn-prompt-decline')?.addEventListener('click', () => {
    declineTransferPrompt();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInexDrop);
} else {
  initInexDrop();
}
// ==================== 09d. INEX DROP SIDE RAIL ====================
// P2P lives inside Inex Drop. A slim icon rail (right side, vertically centred) picks the mode:
// Quick Share or P2P. Exactly ONE mode is selected at a time and it is remembered across restarts.
// The selected mode decides what the Inex Drop tile (left click / chevron) and the File Tray button do.
// (functions + var on purpose: switchView can run before this part has executed)
var dropModeCache = null;

function dropRailViews() { return ['view-inexdrop', 'view-p2p']; }

function getDropMode() {
  if (dropModeCache == null) {
    let v = 'qs';
    try { if (localStorage.getItem('inex.dropMode') === 'p2p') v = 'p2p'; } catch (_) {}
    dropModeCache = v;
  }
  return dropModeCache;
}

function setDropMode(mode) {
  const m = mode === 'p2p' ? 'p2p' : 'qs';
  const changed = m !== getDropMode();
  dropModeCache = m;
  if (changed) { try { localStorage.setItem('inex.dropMode', m); } catch (_) {} }
  updateDropTile();
  updateTrayShareButton();
}

var QS_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10M8 8l4-4 4 4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>';
var P2P_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="9" height="7" rx="1.5"/><path d="M4 13h4"/><rect x="13.5" y="12" width="9" height="7" rx="1.5"/><path d="M16 22h4"/><path d="M12 6.5h4.5V10"/><path d="M12 17.5H7.5V14"/></svg>';

// The one Inex Drop tile always shows the selected mode (icon + status)
function updateDropTile() {
  const tile = document.getElementById('tile-drop');
  if (!tile) return;
  const p2p = getDropMode() === 'p2p';
  tile.classList.toggle('mode-p2p', p2p);
  const sub = document.getElementById('tile-drop-sub');
  const cap = document.getElementById('drop-cap');
  const title = document.getElementById('tile-drop-title');
  const count = (appState.peers || []).length;
  const direct = rtcPeers.has('direct-peer');
  const macTile = document.getElementById('mac-tile-drop');
  const macSub = document.getElementById('mac-drop-sub');
  const macTitle = macTile ? macTile.querySelector('.mx-txt b') : null;
  if (p2p) {
    const p2pText = count > 0 ? (direct ? 'Direct 1:1' : `${count}/5 Peers`) : 'Standby';
    tile.classList.toggle('active', count > 0);
    if (sub) sub.textContent = p2pText;
    if (cap) cap.textContent = count > 0 ? (direct ? '1 direct peer' : `${count} peer${count > 1 ? 's' : ''}`) : '';
    if (title) title.textContent = 'P2P Link';
    tile.title = 'Inex Drop · P2P (click to open)';
    if (macTile) macTile.classList.toggle('active', count > 0);
    if (macSub) macSub.textContent = p2pText;
    if (macTitle) macTitle.textContent = 'P2P Link';
  } else {
    const qsText = inTransfer ? 'Transferring' : (currentOffer ? 'Incoming...' : (dropActive ? 'Ready' : 'Off'));
    tile.classList.toggle('active', dropActive || !!currentOffer);
    tile.classList.toggle('offer', !!currentOffer);
    if (sub) sub.textContent = qsText;
    if (cap) cap.textContent = currentOffer ? 'Tap to accept' : '';
    if (title) title.textContent = 'Inex Drop';
    tile.title = currentOffer ? 'File incoming · Click to accept' : 'Inex Drop · Quick Share (click to turn on / off)';
    if (macTile) {
      macTile.classList.toggle('active', dropActive || !!currentOffer);
      macTile.classList.toggle('offer', !!currentOffer);
    }
    if (macSub) macSub.textContent = qsText;
    if (macTitle) macTitle.textContent = 'Inex Drop';
  }
}

// The File Tray has a single "Inex Drop" button; its icon follows the selected mode
function updateTrayShareButton() {
  const btn = document.getElementById('btn-tray-inexdrop');
  if (!btn) return;
  const svg = btn.querySelector('svg');
  const p2p = getDropMode() === 'p2p';
  if (svg) {
    const tmp = document.createElement('div');
    tmp.innerHTML = p2p ? P2P_ICON_SVG : QS_ICON_SVG;
    const n = tmp.firstElementChild;
    n.setAttribute('width', '15'); n.setAttribute('height', '15');
    svg.replaceWith(n);
  }
  btn.title = p2p ? 'Inex Drop · P2P' : 'Inex Drop · Quick Share';
}

function syncDropRail(viewId) {
  const idx = dropRailViews().indexOf(viewId);
  island.classList.toggle('has-rail', idx !== -1);
  if (idx === -1) return;
  setDropMode(idx === 0 ? 'qs' : 'p2p');   // whatever is opened last is the selected mode (one at a time, remembered)
  const rail = document.getElementById('drop-rail');
  if (rail) rail.style.setProperty('--i', String(idx));
  document.getElementById('rail-qs')?.classList.toggle('on', idx === 0);
  document.getElementById('rail-p2p')?.classList.toggle('on', idx === 1);
}

// Mac menu: open Quick Share or P2P in the right-hand panel (the rail on the side switches between them)
function openMacDrop(mode) {
  const m = mode || getDropMode();
  if (appState.currentView !== 'view-control-mac') openControlMenu();
  if (m === 'p2p') {
    openMacSub('view-p2p', 'P2P');
  } else {
    openMacSub('view-inexdrop', 'Inex Drop');
    if (typeof refreshDropUI === 'function') refreshDropUI();
  }
}

// which rail slot is open right now (classic view, or in-place sub panel of the Mac menu)
function currentDropRailIdx() {
  if (appState.currentView === 'view-control-mac' && typeof currentMacSubTarget !== 'undefined' && currentMacSubTarget) {
    return dropRailViews().indexOf(currentMacSubTarget.id);
  }
  return dropRailViews().indexOf(appState.currentView);
}

function goDropRail(idx) {
  if (idx < 0 || idx >= dropRailViews().length) return;
  if (currentDropRailIdx() === idx) return;
  if (appState.currentView === 'view-control-mac') {          // Mac menu: swap the panel in place
    if (idx === 0) { openMacSub('view-inexdrop', 'Inex Drop'); refreshDropUI(); }
    else openMacSub('view-p2p', 'P2P');
    return;
  }
  if (idx === 0) openQsView();
  else openP2PView();
}

function updateDropRailBadge(count) {
  const b = document.getElementById('rail-p2p-badge');
  if (!b) return;
  b.textContent = String(count);
  b.classList.toggle('hidden', !count);
}

document.getElementById('rail-qs')?.addEventListener('click', (e) => { e.stopPropagation(); goDropRail(0); });
document.getElementById('rail-p2p')?.addEventListener('click', (e) => { e.stopPropagation(); goDropRail(1); });

let dropRailWheelAt = 0;
document.getElementById('drop-rail')?.addEventListener('wheel', (e) => {
  e.preventDefault();
  const now = Date.now();
  if (now - dropRailWheelAt < 250) return;
  dropRailWheelAt = now;
  const cur = currentDropRailIdx();
  if (cur === -1) return;
  goDropRail(cur + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });

// restore the remembered mode on the tile / tray button right after start
updateDropTile();
updateTrayShareButton();
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
  if (typeof invokeTauri === 'function') {
    invokeTauri('control_quick_share', { cmd: 'c' });
  }
  const tSub = document.getElementById('qs-xfer-sub');
  if (tSub) tSub.textContent = 'Cancelling...';
  const btnCancel = document.getElementById('btn-qs-cancel');
  if (btnCancel) btnCancel.disabled = true;
});

async function handlePeerMessage(peerId, entry, msg) {
  switch (msg.type) {
    case 'ping':
      return;
    case 'hello':
      if (msg.name) { entry.name = msg.name; syncConnectedPeersList(); }
      return;
    case 'bye':
      cleanupPeer(peerId);
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
        playStatusSound('transfer', 'transfer');
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
  document.getElementById('rail-p2p')?.classList.toggle('offer', pending);
  document.getElementById('tile-drop')?.classList.toggle('offer', pending);
  document.getElementById('mac-tile-drop')?.classList.toggle('offer', pending);
}

function refreshStatusPill() {
  if (anyTransferActive()) return;
  const pill = document.getElementById('p2p-status-pill');
  if (!pill) return;
  pill.textContent = appState.peers.length > 0 ? `${appState.peers.length} Connected` : directPhaseLabel();
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
  const count = appState.peers.length;
  if (typeof updateDropRailBadge === 'function') updateDropRailBadge(count);
  renderP2PView();
  const listEl = document.getElementById('p2p-peers-list');
  const badge = document.getElementById('c-peer-badge');
  const countSpan = document.getElementById('c-peer-count');
  const tileP2P = document.getElementById('tile-p2p') || document.getElementById('tile-drop');

  const p2pSub = document.getElementById('tile-p2p-sub') || document.getElementById('tile-drop-sub');
  if (p2pSub && !dropActive) p2pSub.textContent = count > 0 ? (rtcPeers.has('direct-peer') ? 'Direct 1:1' : `${count}/5 Peers`) : 'Off';
  const p2pCap = document.getElementById('p2p-cap') || document.getElementById('drop-cap');
  if (p2pCap) p2pCap.textContent = count > 0 ? (rtcPeers.has('direct-peer') ? '1 direct peer' : `${count} peer${count > 1 ? 's' : ''}`) : '';
  if (tileP2P && !dropActive) tileP2P.classList.toggle('active', count > 0);
  if (typeof updateDropTile === 'function') updateDropTile();   // the single Inex Drop tile shows the selected mode

  if (count > 0) {
    badge.classList.remove('hidden');
    countSpan.textContent = count;
  } else {
    badge.classList.add('hidden');
  }
  updateCompactStateClasses();

  listEl.innerHTML = '';
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
  if (typeof syncPopupSize === 'function') syncPopupSize(busy);   // same window as the Bluetooth HUD
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
  if (typeof nexusAbort === 'function') nexusAbort();   // unlock morph has priority over the Nexus voice card

  clearTimeout(bioTimer); clearTimeout(bioAnimPhaseTimer); clearTimeout(bioStartTimer); clearTimeout(bioEndTimer);
  // a pending "shrink the popup window" timer (left by the locker prompt that just closed) must not cut the morph
  if (typeof popupSizeT !== 'undefined') clearTimeout(popupSizeT);
  if (typeof popupSizeOn !== 'undefined') popupSizeOn = false;
  // a device HUD may be open: close it instantly
  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT);
  island.classList.remove('bt-hud-active', 'hud-out', 'hud-back');
  island.classList.add('bio-hud');   // biometric flow keeps its original animation timings (see styles.css)
  document.getElementById('c-bt-hud').classList.add('hidden');

  txt.textContent = label ? String(label) : 'Unlocked';
  glyph.innerHTML = BIO_SVGS[kind];
  box.classList.remove('hidden');

  // 1) window big enough, 2) old content blurs away, 3) island springs into the rounded square
  if (typeof cancelCloseEase === 'function') cancelCloseEase();
  reportIslandSize({ width: ISLAND_WIN_W, height: 112 });
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
        hudRestoreSize();
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
    const kind = payload.type === 'fingerprint' ? 'fingerprint' : payload.type === 'charging' ? 'charging' : payload.type === 'low_battery' ? 'low_battery' : payload.type === 'alarm' ? 'alarm' : payload.type === 'transfer' ? 'transfer' : payload.type === 'bluetooth' ? 'bluetooth' : 'scan';
    const targetName = payload.target ? `${payload.target}` : 'Unlocked';

    renderCenter();
    if (kind === 'alarm') {
      if (typeof triggerTimerAlarm === 'function') triggerTimerAlarm();
    } else if (kind === 'scan' || kind === 'fingerprint') {
      playStatusSound('lock', 'lock');
      triggerBiometricMorph(kind, targetName);
    } else if (kind === 'charging') {
      showDeviceHud({ iconHTML: BOLT_SVG, battery: true, plain: true, accent: 'green', name: 'Charging', tag: `${payload.target || '85%'} • MagSafe Power`, pct: parseInt(payload.target, 10) || 85, ms: 3200 });
    } else if (kind === 'low_battery') {
      showDeviceHud({ iconHTML: LOW_BATT_SVG, battery: true, plain: true, accent: 'amber', name: 'Low Battery', tag: `${payload.target || '18%'} • Connect Power`, pct: parseInt(payload.target, 10) || 18, ms: 3800 });
    } else if (kind === 'bluetooth') {
      if (typeof showBtConnectHud === 'function') {
        showBtConnectHud(payload.target || 'AirPods Pro', payload.kind || 'headphones', parseInt(payload.pct, 10) || 90);
      }
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

function updateCompactTransferPct(pct, speed, name) {
  document.getElementById('c-transfer-pct').textContent = speed ? `${pct}% • ${speed}` : `${pct}%`;
  const box = document.getElementById('c-transfer-anim');
  if (box && pct > 0) box.classList.remove('indeterminate');
  setXferDirectionUI();
  setXferRing(pct);
  // one progress for the whole batch; only the file name beside it changes
  if (name) {
    const lb = document.getElementById('c-xfer-label');
    if (lb) { lb.textContent = name; lb.title = name; }
  }
}

function finishCompactTransferUI() {
  const completed = lastReportedPct >= 100;     // 100% reached = really finished (a cancel never gets there)
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
let lockPrev = false;
let lockUnlockT = null;
onTauriEvent('session-lock-changed', (event) => {
  if (SET.general && !SET.general.lockToast) { lockPrev = false; return; }
  const locked = event && event.payload && event.payload.locked;
  if (typeof locked !== 'boolean') return;
  if (locked === true) {
    lockPrev = true;
    if (typeof goCompact === 'function') goCompact();
    return;
  }
  if (locked === false) {
    if (lockPrev === true && SET.general && SET.general.lockToast) {
      // let the desktop finish appearing before the island starts to move
      clearTimeout(lockUnlockT);
      lockUnlockT = setTimeout(() => triggerBiometricMorph('scan', 'Unlocked'), 450);
    }
    lockPrev = false;
  }
});


// 9. Media Transport Controls
['m-play', 'mac-play'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', async () => {
    await invokeTauri('media_play_pause');
    setTimeout(pollSystemAndMedia, 250);
  });
});
['m-next', 'mac-next'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', async () => {
    await invokeTauri('media_next');
    setTimeout(pollSystemAndMedia, 250);
  });
});
['m-prev', 'mac-prev'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', async () => {
    await invokeTauri('media_prev');
    setTimeout(pollSystemAndMedia, 250);
  });
});

// ---- Nexus voice assistant: same card as the lock / unlock morph (Face ID style, 92 x 92), different glyph inside ----
// wake     -> island drops down exactly like triggerBiometricMorph, waveform glyph + "Listening..."
// thinking -> waveform blurs out, aurora orb blurs in
// done     -> green tick (same tick as unlock) + green glow, then springs back to the notch in ~1.5 s
// cancel   -> straight back to the notch
// Fixed window mode: the OS window never resizes, only reportIslandSize() (clickable area) is used.
const NX_TEXT = { wake: 'Listening...', thinking: 'Thinking...', done: 'Done' };
const NX_GLYPH = {
  wake: '<div class="nx-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>',
  thinking: '<div class="nx-aurora"><b></b><b></b><b></b></div>'
};
const NX_HOLD_DONE_MS = 800;     // tick visible, then 170 ms fade + 560 ms spring back = ~1.5 s total
const NX_LEASE_MS = 45000;       // safety: if Nexus dies without done/cancel, the card closes by itself
let nxActive = false;            // card is open and owned by Nexus
let nxExiting = false;           // card is collapsing
let nxMode = '';
let nxEnterT = null, nxSwapT = null, nxHoldT = null, nxEndT = null, nxBackT = null, nxLeaseT = null, nxGlowT = null;

function nexusClearTimers() {
  clearTimeout(nxEnterT); clearTimeout(nxSwapT); clearTimeout(nxHoldT);
  clearTimeout(nxEndT); clearTimeout(nxBackT); clearTimeout(nxLeaseT);
}

// the unlock morph takes the card over: just let go (it resets the glyph / timers itself)
function nexusAbort() {
  nexusClearTimers();
  clearTimeout(nxGlowT);
  nxActive = false; nxExiting = false; nxMode = '';
  island.classList.remove('hud-out', 'hud-back', 'hud-pre', 'island-locker-glow');
}

function nexusCleanup() {
  const box = document.getElementById('c-biometric-box');
  const glyph = document.getElementById('bio-glyph-wrap');
  if (box) box.classList.add('hidden');
  if (glyph) glyph.innerHTML = '';
  nxMode = ''; nxExiting = false;
  island.classList.remove('biometric-active', 'hud-pre', 'hud-out', 'hud-back', 'bio-hud', 'island-locker-glow');
  hudRestoreSize();
  renderCenter(); updateClocks(); refreshMedia();
}

function nexusEnter() {
  const box = document.getElementById('c-biometric-box');
  const glyph = document.getElementById('bio-glyph-wrap');
  if (!box || !glyph) return false;
  if (appState.currentView !== 'view-compact' || appState.alarmActive) {
    if (nxActive) nexusAbort();      // a menu / alarm took over
    return false;
  }
  if (nxActive) return true;         // already open: only the state changes

  if (nxExiting) {                   // re-wake while collapsing: spring straight back up
    nexusClearTimers();
    nxExiting = false; nxActive = true;
    island.classList.remove('hud-out', 'hud-back');
    island.classList.add('bio-hud', 'biometric-active');
    box.classList.remove('hidden');
    return true;
  }
  // a real unlock morph is running: it keeps the card
  if (island.classList.contains('biometric-active') || island.classList.contains('bio-hud')) return false;

  nexusClearTimers();
  nxActive = true; nxMode = '';
  glyph.innerHTML = '';
  // a pending "shrink the popup window" timer must not cut the animation
  if (typeof popupSizeT !== 'undefined') clearTimeout(popupSizeT);
  if (typeof popupSizeOn !== 'undefined') popupSizeOn = false;
  // a device HUD may be open: close it instantly
  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT);
  island.classList.remove('bt-hud-active', 'hud-out', 'hud-back');
  document.getElementById('c-bt-hud').classList.add('hidden');
  island.classList.add('bio-hud');
  box.classList.remove('hidden');

  // same start as triggerBiometricMorph: window big enough, old content blurs away, island springs into the card
  if (typeof cancelCloseEase === 'function') cancelCloseEase();
  reportIslandSize({ width: ISLAND_WIN_W, height: 112 });
  island.classList.add('hud-pre');
  nxEnterT = setTimeout(() => {
    island.classList.remove('hud-pre');
    island.classList.add('biometric-active');
  }, 130);
  return true;
}

function nexusSetMode(mode, text) {
  const glyph = document.getElementById('bio-glyph-wrap');
  const txt = document.getElementById('bio-label');
  if (!glyph || !txt) return;
  // 92 px card: drop trailing dots ("Listening..." -> "Listening") so the label is never cut off
  txt.textContent = ((text && String(text).trim()) || NX_TEXT[mode] || '').replace(/[.\u2026]+$/, '');
  clearTimeout(nxHoldT);
  if (mode !== nxMode) {
    nxMode = mode;
    clearTimeout(nxSwapT);
    const html = mode === 'done' ? BIO_SVGS.check : (NX_GLYPH[mode] || '');
    const cur = glyph.firstElementChild;
    if (cur) {
      cur.classList.add('bio-leave');                  // old glyph blurs out, new one pops in (same as scan -> tick)
      nxSwapT = setTimeout(() => { glyph.innerHTML = html; }, 150);
    } else {
      glyph.innerHTML = html;
    }
    if (mode === 'done') {
      island.classList.add('island-locker-glow');      // same soft green glow as a successful unlock
      clearTimeout(nxGlowT);
      nxGlowT = setTimeout(() => island.classList.remove('island-locker-glow'), 600);   // short flash only: it must be gone before the collapse
    }
  }
  if (mode === 'done') nxHoldT = setTimeout(nexusExit, NX_HOLD_DONE_MS);
  clearTimeout(nxLeaseT);
  nxLeaseT = setTimeout(nexusExit, NX_LEASE_MS);
}

function nexusExit() {
  if (!nxActive) return;
  nxActive = false; nxExiting = true;
  clearTimeout(nxHoldT); clearTimeout(nxLeaseT); clearTimeout(nxEnterT); clearTimeout(nxSwapT); clearTimeout(nxGlowT);
  island.classList.remove('hud-pre', 'island-locker-glow');   // no green outline on the shrinking notch
  island.classList.add('hud-out');                     // content fades, shrink back to the pill, restore the normal window
  nxEndT = setTimeout(() => {
    island.classList.remove('biometric-active', 'hud-out');
    island.classList.add('hud-back');
    nxBackT = setTimeout(nexusCleanup, 560);
  }, 170);
}

window.triggerNexusVoiceAnimation = function (status, text, payload) {
  const st = String(status || '').toLowerCase();
  if (st === 'wake' || st === 'thinking' || st === 'done') {
    if (!nexusEnter()) return;
    nexusSetMode(st, text);
  } else if (st === 'cancel') {
    nexusExit();
  }
};

// 10. Nexus Assistant Bridge (Named Pipe \\.\pipe\InexIslandNexus -> event 'nexus-voice')
// Passive receiver: Nexus sends events:
//   { event: "nexus_voice", status: "wake" | "thinking" | "done" | "cancel", text: "...", seq: 1, ts: 123456789 }
let lastNexusSeq = -1;
let lastNexusTs = 0;

onTauriEvent('nexus-voice', (event) => {
  let payload = event.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) {}
  }
  if (!payload || typeof payload !== 'object') payload = {};

  const evTs = Number(payload.ts) || 0;
  if (evTs) {
    if (evTs < lastNexusTs && lastNexusTs - evTs < 60000) return;
    lastNexusTs = evTs;
  }
  const seq = Number(payload.seq) || 0;
  lastNexusSeq = seq;

  const status = payload.status || '';
  const text = payload.text || '';

  // Forward to the voice card (triggerNexusVoiceAnimation, defined above)
  if (typeof window.triggerNexusVoiceAnimation === 'function') {
    window.triggerNexusVoiceAnimation(status, text, payload);
  } else {
    console.log('[NexusBridge]', status, text);
  }
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
  if (typeof cancelCloseEase === 'function') cancelCloseEase();
  reportIslandSize({ width: ISLAND_WIN_W, height: hudIsFloating() ? 64 : 56 });  // same width as compact/HUDs so never jumps sideways
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
      hudRestoreSize();
      renderCenter();
      updateClocks();
      refreshMedia();
    }, 600);
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
    reportIslandSize({ width: ISLAND_WIN_W, height: 268 + (hudIsFloating() ? 12 : 0) });
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

// fetch with a time limit: one hanging request must never keep the weather "busy" for ever
function wxFetch(url, ms = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

// City typed in Settings -> lat/lon through Open-Meteo's free geocoding (no key). Runs only when the city changes.
async function geocodeCity(name) {
  const q = name.toLowerCase();
  try {
    const sv = JSON.parse(localStorage.getItem('inex.geo') || 'null');
    if (sv && sv.q === q && sv.loc) return sv.loc;
  } catch (_) {}
  const res = await wxFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  if (!res.ok) return null;
  const d = await res.json();
  const r = d && d.results && d.results[0];
  if (!r || !isFinite(+r.latitude) || !isFinite(+r.longitude)) return null;
  const loc = { lat: +r.latitude, lon: +r.longitude, city: r.name || name };
  try { localStorage.setItem('inex.geo', JSON.stringify({ q, loc })); } catch (_) {}
  return loc;
}

// Fast IP-based geolocation (no Windows Location COM delays or process locks)
async function detectLocation() {
  const cityQ = ((SET.weather && SET.weather.city) || '').trim();
  if (cityQ) {
    if (weather.cityLoc && weather.cityQ === cityQ) return weather.cityLoc;
    try {
      const g = await geocodeCity(cityQ);
      if (g) { weather.cityQ = cityQ; weather.cityLoc = g; return g; }
    } catch (_) {}
    // city not found / offline: fall back to the automatic IP location below
  }
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
      const res = await wxFetch('https://ipapi.co/json/');
      if (res.ok) {
        const d = await res.json();
        const lat = d.latitude || d.lat, lon = d.longitude || d.lon;
        if (lat && lon) return { lat: +lat, lon: +lon, city: d.city || '' };
      }
      return null;
    },
    async () => {
      const res = await wxFetch('https://ipwho.is/');
      if (res.ok) {
        const d = await res.json();
        if (d && d.success !== false) return { lat: +d.latitude, lon: +d.longitude, city: d.city || '' };
      }
      return null;
    },
    async () => {
      const res = await wxFetch('http://ip-api.com/json/?fields=status,lat,lon,city');
      if (res.ok) {
        const d = await res.json();
        if (d && d.status === 'success') return { lat: +d.lat, lon: +d.lon, city: d.city || '' };
      }
      return null;
    },
    async () => {
      const res = await wxFetch('https://freeipapi.com/api/json');
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
    // every lookup failed: keep using the last known place instead of showing nothing
    try {
      const old = JSON.parse(localStorage.getItem('inex.loc') || 'null');
      if (old && old.loc) weather.loc = old.loc;
    } catch (_) {}
  }
  return loc || weather.loc;
}

// Weather runs ONLY while "Live Weather" is on AND Weather is picked as a hover widget (left or right).
// Not picked = no request, no timer, nothing.
function weatherWanted() {
  if (!(SET.weather && SET.weather.enabled)) return false;
  const compactNeedsWeather = ['weather', 'cycle'].includes(SET.notch?.compactContent);
  const macNeedsWeather = SET.appearance?.menuLayout === 'mac' && (!SET.macMenu || SET.macMenu.showWeather !== false);
  const w = SET.widgets || {};
  const hoverNeedsWeather = w.enabled !== false && (w.left === 'weather' || w.right === 'weather');
  return compactNeedsWeather || macNeedsWeather || hoverNeedsWeather;
}

async function refreshWeather() {
  if (weather.busy) return;
  weather.busy = true;
  try {
    if (!weatherWanted()) {
      weather.text = ''; weather.at = 0; weather.key = '';
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
      const wRes = await wxFetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day&timezone=auto${unitParam}`);
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
        const r = await wxFetch(`https://wttr.in/${ck}?format=j1`);
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
    updateClocks();
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

function syncMacWeatherUI() {
  const pill = document.getElementById('mac-weather');
  const tempEl = document.getElementById('mac-weather-temp');
  if (!pill || !tempEl) return;
  const hasWx = !!(SET.weather && SET.weather.enabled && weather.text);
  tempEl.textContent = hasWx ? weather.text : '--°';
  pill.title = weather.place ? `${weather.condition || 'Weather'} • ${weather.place}` : 'Weather';
  const oldSvg = pill.querySelector('svg');
  if (hasWx && oldSvg && typeof getActiveWeatherIcon === 'function') {
    const tmp = document.createElement('span');
    tmp.innerHTML = getActiveWeatherIcon();
    const newSvg = tmp.querySelector('svg');
    if (newSvg) {
      newSvg.setAttribute('width', '12');
      newSvg.setAttribute('height', '12');
      oldSvg.replaceWith(newSvg);
    }
  }
}

function renderWidgets() {
  const on = SET.widgets.enabled !== false;   // Hover Widgets switch in Settings
  const left = on ? widgetHtml(SET.widgets.left) : '', right = on ? widgetHtml(SET.widgets.right) : '';
  const cTemp = document.getElementById('c-temp');
  const cRam = document.getElementById('c-ram');
  if (cTemp) cTemp.innerHTML = left;
  if (cRam) cRam.innerHTML = right;
  document.getElementById('c-left-box').classList.toggle('has-widget', !!left);
  document.getElementById('c-right-box').classList.toggle('has-widget', !!right);
  // Prevent empty side-stretch when hover widgets are disabled or both set to None.
  island.classList.toggle('no-hover-expand', !(left || right));

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
  syncMacWeatherUI();
}

function batteryOverlays(stats) {
  if (!(stats.battery_pct >= 0)) return;            // desktop PC: no battery
  const g = SET.general;
  // charger plugged in / removed
  if (appState.prevCharging !== undefined && stats.charging !== appState.prevCharging && g.chargeToast) {
    playStatusSound('power', stats.charging ? 'power' : 'power-off');
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
    playStatusSound('power', 'low');
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

const MAC_BT_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>';
// Control Deck Bluetooth tile: show the connected device's icon (earbuds, headphones...) with a battery ring,
// same look as the device status card. Each copy of BUDS_SVG gets its own gradient id: a duplicate id that
// sits inside a hidden element makes the gradient fail and the buds turn invisible.
function syncMacBtTileIcon(dev) {
  const ico = document.querySelector('#mac-tile-bt .mx-ico');
  if (!ico) return;
  let key = 'bt', html = MAC_BT_GLYPH;
  if (dev && appState.btRadio) {
    const kind = dev.kind || 'bt';
    const isBuds = (kind === 'headphones' || kind === 'bt') && /airpod|buds|earbud|earphone|airdope|tws|pods|wf-/i.test(dev.name || '');
    if (isBuds && typeof BUDS_SVG !== 'undefined') { key = 'buds'; html = BUDS_SVG.replace(/budg/g, 'budg-tile'); }
    else if (kind !== 'bt' && typeof DEV_ICONS !== 'undefined' && DEV_ICONS[kind]) { key = kind; html = DEV_ICONS[kind]; }
  }
  if (ico.dataset.k !== key) {
    ico.dataset.k = key;
    ico.innerHTML = html;
    ico.classList.toggle('has-dev', key !== 'bt');
  }
  let pct = null;
  if (key !== 'bt' && typeof btBatteryFor === 'function') pct = btBatteryFor(dev.name);
  if (pct === null || pct === undefined || !(pct >= 0)) {
    ico.classList.remove('has-batt');
    ico.style.removeProperty('--p');
  } else {
    ico.classList.add('has-batt');
    ico.style.setProperty('--p', Math.max(0, Math.min(100, pct)));
    ico.style.setProperty('--bc', pct <= 15 ? '#ff453a' : pct <= 30 ? '#ff9f0a' : '#30d158');
  }
}

// Long text (song title, Bluetooth name) slides slowly instead of being cut with "...". Only runs while text overflows.
function mqFit(el) {
  if (!el || el._mqBusy) return;
  el._mqBusy = true;
  const inner = el.querySelector(':scope > .mq-in');
  const text = inner ? inner.textContent : el.textContent;
  el.classList.remove('mq');
  if (inner) el.textContent = text;
  if (el.clientWidth > 0) {
    const over = el.scrollWidth - el.clientWidth;
    if (over > 2) {
      const s = document.createElement('span');
      s.className = 'mq-in';
      s.textContent = text;
      el.textContent = '';
      el.appendChild(s);
      el.style.setProperty('--mq-d', `-${over + 6}px`);
      el.style.setProperty('--mq-t', `${Math.max(4, (over + 6) / 20).toFixed(1)}s`);
      el.classList.add('mq');
    }
  }
  requestAnimationFrame(() => { el._mqBusy = false; });
}
['mac-title', 'mac-artist', 'mac-bt-sub'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  const fit = () => mqFit(el);
  new MutationObserver(fit).observe(el, { childList: true, characterData: true, subtree: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(el);
  fit();
});

function setBtCaption(devices) {
  const first = (devices || []).find((d) => d.connected);
  let txt = appState.btRadio && first ? first.name : '';
  if (txt && SET.overlays.btBattery) {
    const pct = btBatteryFor(first.name);
    if (pct !== null) txt += ` • ${pct}%`;
  }
  document.getElementById('bt-cap').textContent = txt;
  syncMacBtTileIcon(first);
  const macBtSub = document.getElementById('mac-bt-sub');
  if (macBtSub) {
    const _s = appState.btRadio ? (first ? first.name : 'On') : 'Off';
    if (macBtSub.textContent !== _s) macBtSub.textContent = _s;
  }
}
async function refreshBtCaption() {
  if (!slotRunning.has('bt') && SET.appearance?.menuLayout !== 'mac') return;
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
// Keeps ONLY the last CLIPBOARD_MAX copied text snippets and OS screenshot paths.
// Zero internal image storage (no IndexedDB blobs, no base64 thumbnails in localStorage).
// Deleted screenshot files are dropped automatically via ReadDirectoryChangesW & existence checks.
const CLIPBOARD_STORAGE_KEY = 'inex.island.clipboard.v1';
const CLIPBOARD_MAX = 20;
const CLIPBOARD_TEXT_LIMIT = 50000;
let clipboardItems = [];
let clipPreviewUrls = [];
let clipRenderGen = 0;

// Purge legacy IndexedDB full-image cache from older versions if present.
try { indexedDB.deleteDatabase('inex-island-clipboard'); } catch (_) {}

function revokeClipPreviews() {
  for (const url of clipPreviewUrls) {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
  clipPreviewUrls = [];
}

function closeClipboardView() {
  clipRenderGen++;
  revokeClipPreviews();
  const container = document.getElementById('clipboard-list');
  if (container) container.innerHTML = '';
}

function clipPathKey(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function clipFileName(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

// ---------- history list ----------
function loadClipboardHistory() {
  try {
    const raw = localStorage.getItem(CLIPBOARD_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      clipboardItems = [];
      return;
    }
    clipboardItems = parsed
      .filter((it) => {
        if (!it) return false;
        const kind = it.kind || (typeof it.text === 'string' ? 'text' : '');
        if (kind === 'text') return typeof it.text === 'string' && it.text.trim().length > 0;
        if (kind === 'screenshot') return typeof it.path === 'string' && it.path.trim().length > 0;
        return false; // Drop legacy 'image' blobs and regular 'files' entries
      })
      .map((it) => {
        const kind = it.kind || 'text';
        if (kind === 'screenshot') {
          return {
            id: it.id || (Date.now() + Math.random().toString(36).slice(2, 6)),
            kind: 'screenshot',
            hash: clipPathKey(it.path),
            path: it.path,
            name: it.name || clipFileName(it.path),
            time: it.time || Date.now()
          };
        }
        return {
          id: it.id || (Date.now() + Math.random().toString(36).slice(2, 6)),
          kind: 'text',
          hash: it.hash || clipHashString(it.text),
          text: it.text,
          time: it.time || Date.now()
        };
      })
      .slice(0, CLIPBOARD_MAX);
  } catch (_) {
    clipboardItems = [];
  }
}

function saveClipboardHistory() {
  try {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(clipboardItems.slice(0, CLIPBOARD_MAX)));
  } catch (_) {
    try {
      clipboardItems = clipboardItems.slice(0, Math.ceil(CLIPBOARD_MAX / 2));
      localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(clipboardItems));
    } catch (_) {}
  }
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

function clipHashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + s.length;
}

function trimClipboardItems() {
  clipboardItems = clipboardItems.slice(0, CLIPBOARD_MAX);
}

function pushClipboardItem(item) {
  const idx = clipboardItems.findIndex((it) => it.kind === item.kind && it.hash === item.hash);
  if (idx === 0) return false;
  if (idx > 0) clipboardItems.splice(idx, 1);
  clipboardItems.unshift(item);
  trimClipboardItems();
  saveClipboardHistory();
  if (appState.currentView === 'view-clipboard') renderClipboardList();
  return true;
}

function addClipboardText(text) {
  if (!text || typeof text !== 'string') return false;
  let clean = text.trim();
  if (!clean) return false;
  if (clean.length > CLIPBOARD_TEXT_LIMIT) clean = clean.slice(0, CLIPBOARD_TEXT_LIMIT);
  return pushClipboardItem({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    kind: 'text',
    hash: clipHashString(clean),
    text: clean,
    time: Date.now()
  });
}

function addClipboardScreenshot(path) {
  if (!path || typeof path !== 'string') return false;
  const clean = path.trim();
  if (!clean) return false;
  return pushClipboardItem({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    kind: 'screenshot',
    hash: clipPathKey(clean),
    path: clean,
    name: clipFileName(clean),
    time: Date.now()
  });
}

function removeScreenshotByPath(path) {
  const key = clipPathKey(path);
  if (!key) return false;
  const before = clipboardItems.length;
  clipboardItems = clipboardItems.filter((it) => !(it.kind === 'screenshot' && clipPathKey(it.path) === key));
  if (clipboardItems.length === before) return false;
  saveClipboardHistory();
  if (appState.currentView === 'view-clipboard') renderClipboardList();
  return true;
}

async function pruneMissingScreenshots() {
  const shots = clipboardItems.filter((it) => it.kind === 'screenshot').map((it) => it.path);
  if (shots.length === 0) return false;
  const existing = await tryInvoke('filter_existing_paths', { paths: shots });
  if (!Array.isArray(existing)) return false;
  const keep = new Set(existing.map(clipPathKey));
  const before = clipboardItems.length;
  clipboardItems = clipboardItems.filter((it) => it.kind !== 'screenshot' || keep.has(clipPathKey(it.path)));
  if (clipboardItems.length === before) return false;
  saveClipboardHistory();
  return true;
}

const CLIP_ICON_SCREENSHOT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.5"/><path d="M21 15l-4.5-4.5L7 19"/></svg>';

// Transient 96px thumbnail created ONLY while Clipboard view is open; cleared on close.
async function hydrateScreenshotThumb(path, containerEl, gen) {
  try {
    const ab = await invokeTauri('read_screenshot_bytes', { path });
    if (gen !== clipRenderGen || appState.currentView !== 'view-clipboard') return;
    if (!ab || ab.byteLength === 0) {
      if (removeScreenshotByPath(path)) return;
      return;
    }
    const rawBlob = new Blob([ab]);
    const bmp = await createImageBitmap(rawBlob, { resizeWidth: 96, resizeHeight: 96, resizeQuality: 'medium' });
    let thumbUrl = '';
    try {
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      const smallBlob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.8));
      if (smallBlob && gen === clipRenderGen && appState.currentView === 'view-clipboard') {
        thumbUrl = URL.createObjectURL(smallBlob);
      }
    } finally {
      bmp.close();
    }
    if (!thumbUrl) return;
    clipPreviewUrls.push(thumbUrl);
    const im = document.createElement('img');
    im.src = thumbUrl;
    im.alt = '';
    im.draggable = false;
    containerEl.innerHTML = '';
    containerEl.appendChild(im);
  } catch (_) {
    // Missing or deleted screenshot file: remove from history automatically
    removeScreenshotByPath(path);
  }
}

// ---------- drawing ----------
function renderClipboardList() {
  if (appState.currentView !== 'view-clipboard') return;
  const container = document.getElementById('clipboard-list');
  if (!container) return;

  const gen = ++clipRenderGen;
  revokeClipPreviews();
  const visibleItems = clipboardItems;

  if (visibleItems.length === 0) {
    container.innerHTML = `
      <div class="clipboard-empty">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none" opacity="0.4"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        <span>Nothing copied yet</span>
        <small style="opacity:0.4; font-size:9.5px;">Copied text &amp; screenshots appear here</small>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  visibleItems.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'clipboard-item';
    card.title = 'Click to copy';

    const header = document.createElement('div');
    header.className = 'clipboard-item-header';

    const timeSpan = document.createElement('span');
    if (item.kind === 'screenshot') {
      timeSpan.textContent = `${formatRelativeTime(item.time)} • Screenshot`;
    } else {
      timeSpan.textContent = `${formatRelativeTime(item.time)} • ${item.text.length} chars`;
    }

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

    if (item.kind === 'screenshot') {
      card.classList.add('clip-media');
      const row = document.createElement('div');
      row.className = 'clip-media-row';

      const th = document.createElement('div');
      th.className = 'clip-thumb';
      th.innerHTML = CLIP_ICON_SCREENSHOT;
      hydrateScreenshotThumb(item.path, th, gen);

      const info = document.createElement('div');
      info.className = 'clip-media-info';
      info.appendChild(header);
      const det = document.createElement('div');
      det.className = 'clip-media-name';
      det.textContent = item.name || clipFileName(item.path);
      info.appendChild(det);

      row.appendChild(th);
      row.appendChild(info);
      card.appendChild(row);
    } else {
      card.appendChild(header);
      const body = document.createElement('div');
      body.className = 'clipboard-item-text';
      body.textContent = item.text;
      card.appendChild(body);
    }

    card.addEventListener('click', async () => {
      let ok = false;
      try {
        if (item.kind === 'screenshot') {
          ok = !!(await tryInvoke('set_clipboard_files', { paths: [item.path] }));
          if (!ok) {
            removeScreenshotByPath(item.path);
            showToast('snip', 'Screenshot deleted', 1200);
            return;
          }
        } else {
          await navigator.clipboard.writeText(item.text);
          ok = true;
        }
      } catch (_) { ok = false; }

      if (ok) {
        card.classList.add('copied');
        showToast('snip', 'Copied to clipboard', 1200);
        setTimeout(() => { card.classList.remove('copied'); }, 1100);
      } else {
        showToast('snip', 'Copy failed', 1200);
      }
    });

    container.appendChild(card);
  });
}

// ---------- reading the system clipboard (Text + Screenshot paths only) ----------
let clipLastSeq = 0;

async function readClipboardOnce() {
  const files = await tryInvoke('get_clipboard_files', {});
  if (Array.isArray(files) && files.length > 0) {
    // Only record screenshots copied from the OS Screenshots folder; ignore other copied/cut files.
    const shots = await tryInvoke('filter_screenshot_paths', { paths: files });
    if (Array.isArray(shots) && shots.length > 0) {
      return { kind: 'screenshot', path: shots[0] };
    }
    return { kind: 'ignored' };
  }
  const t = await tryInvoke('get_clipboard_text', {});
  if (t && typeof t === 'string' && t.trim()) return { kind: 'text', text: t };
  return null;
}

async function readClipboardWithRetry() {
  const waits = [0, 50, 120, 250, 450];
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    const got = await readClipboardOnce();
    if (got) return got;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) return { kind: 'text', text: t };
    }
  } catch (_) {}
  return null;
}

function recordClipboardPayload(got) {
  if (!got || got.kind === 'ignored') return false;
  if (got.kind === 'screenshot') return addClipboardScreenshot(got.path);
  if (got.kind === 'text') return addClipboardText(got.text);
  return false;
}

async function checkSystemClipboard() {
  try {
    const seq = await tryInvoke('clipboard_seq', {});
    if (seq && seq === clipLastSeq) return;
    const got = await readClipboardOnce();
    if (seq) clipLastSeq = seq;
    recordClipboardPayload(got);
  } catch (_) {}
}

function openClipboardView() {
  Promise.all([checkSystemClipboard(), pruneMissingScreenshots()]).then(() => {
    renderClipboardList();
  });
}

// Initialise & prune stale/deleted items immediately
loadClipboardHistory();
saveClipboardHistory();
pruneMissingScreenshots();

document.getElementById('btn-clipboard-clear')?.addEventListener('click', () => {
  if (clipboardItems.length === 0) return;
  clipboardItems = [];
  revokeClipPreviews();
  saveClipboardHistory();
  renderClipboardList();
  showToast('unlock', 'Clipboard cleared', 1200);
});

window.addEventListener('focus', checkSystemClipboard);
document.getElementById('island')?.addEventListener('mouseenter', checkSystemClipboard);

const CLIP_HUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path class="clip-tick" d="M8.5 14.5l2.5 2.5 4.5-5"/></svg>';
let clipHudAt = 0;

function showClipboardHud(tag) {
  if (SET.general && SET.general.copyToast === false) return;
  if (appState.toast) return;
  const now = Date.now();
  if (now - clipHudAt < 500) return;
  clipHudAt = now;
  showDeviceHud({
    iconHTML: CLIP_HUD_SVG, plain: true,
    name: 'Copied',
    tag,
    ms: 1700
  });
}

// Native zero-polling OS screenshot folder watcher events (ReadDirectoryChangesW)
onTauriEvent('screenshot-added', (ev) => {
  const path = ev && ev.payload && ev.payload.path;
  if (!path) return;
  if (addClipboardScreenshot(path)) {
    const name = clipFileName(path);
    showClipboardHud(name.length > 24 ? name.slice(0, 24) + '\u2026' : name);
  }
});

onTauriEvent('screenshot-removed', (ev) => {
  const path = ev && ev.payload && ev.payload.path;
  if (path) removeScreenshotByPath(path);
});

let clipCopySeq = 0;
onTauriEvent('clipboard-copied', async () => {
  const mySeq = ++clipCopySeq;
  const got = await readClipboardWithRetry();
  if (mySeq !== clipCopySeq) return;
  const seq = await tryInvoke('clipboard_seq', {});
  if (seq) clipLastSeq = seq;
  if (!got || got.kind === 'ignored') return;
  recordClipboardPayload(got);

  if (got.kind === 'text') {
    const one = got.text.replace(/\s+/g, ' ').trim();
    showClipboardHud(one.length > 24 ? one.slice(0, 24) + '\u2026' : one);
  } else if (got.kind === 'screenshot') {
    const name = clipFileName(got.path);
    showClipboardHud(name.length > 24 ? name.slice(0, 24) + '\u2026' : name);
  }
});
let _lastSettingsWinSig = '';

// ---- Smooth live settings (UI Scale slider, colour picker, corner roundness ...) ----
// Dragging a slider fires dozens of settings events per second. Before, every one of them re-ran the whole
// pipeline (weather, media, widgets ...). Now:
//  1. events are coalesced to one apply per animation frame,
//  2. look-only changes (scale, colours, roundness, font) skip the heavy work,
//  3. the OS window never changes size (fixed, set by Rust), so nothing can get out of step and shake.
const FAST_APPEARANCE_KEYS = ['scale', 'notchColor', 'notchOpacity', 'cornerRadius', 'borderColor', 'borderOpacity',
  'notchBorderColor', 'notchBorderOpacity', 'fontStyle', 'menuStyle'];
let _lastHeavySig = null;

function heavySettingsSig() {
  const ap = { ...SET.appearance };
  FAST_APPEARANCE_KEYS.forEach((k) => delete ap[k]);
  return JSON.stringify({ ...SET, appearance: ap });
}

function computeIslandSize() {
  const isFloating = SET.notch && SET.notch.style === 'floating';
  if (appState.currentView === 'view-compact' || !appState.currentView) {
    const small = { width: ISLAND_WIN_W, height: isFloating ? 48 : 36 };
    return typeof compactIslandSize === 'function' ? compactIslandSize(small) : small;
  }
  if (appState.islandSize) return { width: appState.islandSize.width, height: appState.islandSize.height };
  return null;
}

// Report the island's size to Rust (clickable area). Same size again = nothing to do.
function syncIslandHit(targetZoom) {
  const targetWin = computeIslandSize();
  if (!targetWin) return;
  const sig = `${targetWin.width}x${targetWin.height}@${targetZoom}`;
  if (sig === _lastSettingsWinSig) return;
  _lastSettingsWinSig = sig;
  reportIslandSize(targetWin);
}

function applySettings() {
  applyTheme(SET);
  island.dataset.menu = menuSurface(SET.appearance).style;
  const validTheme = ['default', 'matrix'].includes(SET.appearance.themeStyle) ? SET.appearance.themeStyle : 'default';
  island.dataset.theme = validTheme;
  island.setAttribute('data-mode', SET.notch.mode);
  island.setAttribute('data-style', SET.notch.style || 'attached');
  island.setAttribute('data-theme', validTheme);
  const macEars = SET.notch && SET.notch.macEars !== false && SET.notch.style !== 'floating';
  island.classList.toggle('has-mac-ears', !!macEars);
  if (SET.notch.mode !== 'smart') island.classList.remove('smart-hidden');

  const targetZoom = (SET.appearance.scale || 100) / 100;
  island.style.zoom = targetZoom;
  island.classList.toggle('no-anim', SET.appearance.animations === false);

  // Look-only change (scale / colour / roundness / font): report the island size and stop. No need to rebuild
  // slots, tiles, widgets or to hit weather / media again.
  const heavySig = heavySettingsSig();
  const lookOnly = _lastHeavySig !== null && heavySig === _lastHeavySig;
  _lastHeavySig = heavySig;
  if (lookOnly && appState.currentView !== 'view-control' && appState.currentView !== 'view-control-mac') {
    syncIslandHit(targetZoom);
    return;
  }

  applySlots();
  if (typeof applyMacMenuConfig === 'function') applyMacMenuConfig();

  const wantMacMenu = SET.appearance && SET.appearance.menuLayout === 'mac';
  if ((wantMacMenu && appState.currentView === 'view-control') || (!wantMacMenu && appState.currentView === 'view-control-mac')) {
    if (typeof openControlMenu === 'function') openControlMenu();
  } else {
    syncIslandHit(targetZoom);
  }
  renderQuickActionTiles();
  document.getElementById('view-media').classList.toggle('no-ambient', !SET.notch.ambientGlow);
  document.getElementById('mac-media')?.classList.toggle('no-ambient', !SET.notch.ambientGlow);
  document.getElementById('c-media-btn').classList.toggle('glow', SET.notch.compactGlow);
  if (SET.share.deviceName) myDeviceName = SET.share.deviceName;
  updateClocks();
  if (typeof syncCompactCycleTimer === 'function') syncCompactCycleTimer();
  renderWidgets();
  if (typeof syncLoadTimer === 'function') syncLoadTimer();
  applyPrivacy();
  syncWeatherTimer();
  refreshWeather();
  syncEq();
  refreshMedia();
}

// Settings arrive twice per change (storage event + Tauri event) and many times per second while a slider
// moves: keep only the latest and apply it once per frame.
let _applyRaf = 0;
function scheduleApplySettings() {
  if (_applyRaf) return;
  _applyRaf = requestAnimationFrame(() => { _applyRaf = 0; applySettings(); });
}
onSettings((incoming) => { SET = incoming; scheduleApplySettings(); });
applySettings();
// Weather timer exists ONLY while weather is wanted (Live Weather on + picked as a hover widget).
// One request every 12 min; after a failure wait longer each time (2, 4, 8 ... up to 15 min).
// (var, no initializer: applySettings() above runs before this line)
var weatherTimer, weatherFails;
function nextWeatherDelay() {
  if (weather.text) { weatherFails = 0; return 12 * 60 * 1000; }
  weatherFails = Math.min((weatherFails || 0) + 1, 6);
  return Math.min(15 * 60 * 1000, 2 * 60 * 1000 * Math.pow(2, weatherFails - 1));
}
function scheduleWeather(ms) {
  clearTimeout(weatherTimer);
  weatherTimer = setTimeout(async () => {
    weatherTimer = null;
    if (!weatherWanted()) return;
    if (!document.hidden) await refreshWeather();
    scheduleWeather(nextWeatherDelay());
  }, ms);
}
function syncWeatherTimer() {
  if (weatherWanted()) { if (!weatherTimer) scheduleWeather(12 * 60 * 1000); }
  else { clearTimeout(weatherTimer); weatherTimer = null; weatherFails = 0; }
}
syncWeatherTimer();
// back on screen after a long pause: refresh (refreshWeather keeps its own cache and does nothing when weather is not wanted)
document.addEventListener('visibilitychange', () => { if (!document.hidden && weatherWanted()) refreshWeather(); });

// ---- Intro animation: the island drops gently from the top edge ----
// The island stays invisible (intro-pre) until the first size has been reported, then drops in.
(function introAnimation() {
  let started = false;
  const play = () => {
    if (started) return;
    started = true;
    island.classList.remove('intro-pre');
    void island.offsetWidth;                      // restart the animation cleanly
    island.classList.add('intro-play');
    setTimeout(() => island.classList.remove('intro-play'), 900);
  };
  island.classList.add('intro-pre');
  setTimeout(play, 1500);                         // failsafe: never stay invisible
  (async () => {
    try {
      const h = (SET.notch && SET.notch.style === 'floating') ? 48 : 36;
      await reportIslandSize({ width: ISLAND_WIN_W, height: h });
    } catch (_) {}
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 160)); // let WebView2 finish the new width
    play();
  })();
})();

// Auto Update: checked ONCE, ~25 s after the app starts. If Auto Update is ON and a new version
// exists it downloads, installs and restarts by itself. No repeated polling.
// (When OFF, nothing happens here: the user updates from Settings > About.)
setTimeout(async () => {
  if (!SET.general?.autoUpdate) return;
  try {
    const res = await invokeTauri('check_update');
    if (!(res && res.available && res.latest_version)) return;
    // busy with a transfer / prompt: do not restart now, it will update on the next launch
    if (appState.transferring || appState.prompting || appState.lockerPrompting) return;
    showToast('spark', `Updating to v${res.latest_version}...`, 4000);
    const ok = await invokeTauri('apply_update');
    if (ok) {
      showToast('spark', 'Update installed. Restarting...', 2500);
      setTimeout(() => invokeTauri('restart_app'), 2500);
    }
  } catch (e) {
    console.warn('auto update failed:', e);
  }
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

// ---- Pixel snap: the island is centred inside its window, so on Windows scales like 125% / 150% (and in the built app, where the
// window size is rounded to whole device pixels) its left edge can land on a half pixel. The bezel ear hangs off that edge and
// got anti-aliased away on one side only (left ear slightly cut, right ear fine). Nudge the island so its left edge sits on a whole
// device pixel; the right ear then follows the same grid.
(function pixelSnap() {
  const snap = () => {
    const dpr = window.devicePixelRatio || 1;
    const zoom = parseFloat(island.style.zoom) || 1;
    island.style.left = '0px';
    const r = island.getBoundingClientRect();
    const d = Math.round(r.left * dpr) / dpr - r.left;
    if (Math.abs(d) > 0.001) island.style.left = (d / zoom) + 'px';
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(snap).observe(island);
  window.addEventListener('resize', snap);
  snap();
})();

// Block the WebView2 default right-click menu (Back / Refresh / Save as / Print / More tools).
// Our own handlers (tiles, rows...) still run; text fields keep the normal Cut / Copy / Paste menu.
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t && t.closest && t.closest('input:not([type="range"]):not([type="checkbox"]), textarea, [contenteditable="true"]')) return;
  e.preventDefault();
});
