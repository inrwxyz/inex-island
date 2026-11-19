// GENERATED from main-parts/*.js by scripts/build-main.mjs. Edit the parts, not this file.
import { load as loadSettings, save as saveSettings, subscribe as onSettings, applyTheme, menuSurface, ALARM_KEY, loadAlarms, subscribeAlarms } from './shared.js';

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
  btRadio: true,
  wifiPresent: true,   // false = no such adapter in this PC (no dongle plugged in)
  btPresent: true
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

// Clickable area = the island's REAL width for compact pills / HUDs / popups (they all pass the nominal 548 wide), so the empty
// transparent space left and right of a small pill lets clicks through to the apps below. Menus and sub-views (tall) keep their size.
let _hitReq = null, _lastHitW = -1, _lastHitH = -1;
const HIT_SIDE_PAD = 40;   // curved ears hang ~17px outside the island + a little grace for the spring overshoot
function realHitWidth(nominalW) {
  try {
    const w = parseFloat(getComputedStyle(island).width);   // local (unzoomed) px, same unit as the nominal size
    if (w > 40) return Math.min(nominalW, Math.ceil(w) + HIT_SIDE_PAD);
  } catch (_) {}
  return nominalW;
}
function reportIslandSize(size) {
  appState.islandSize = { width: size.width, height: size.height };
  _hitReq = { width: size.width, height: size.height };
  const k = SET.appearance.scale / 100;
  const w = size.height <= 112 ? realHitWidth(size.width) : size.width;
  const hw = Math.round(w * k), hh = Math.round(size.height * k);
  if (hw === _lastHitW && hh === _lastHitH) return Promise.resolve();   // spring frames often give the same rounded size
  _lastHitW = hw; _lastHitH = hh;
  return invokeTauri('set_island_hit', { width: hw, height: hh }).catch(() => {});
}
// While the island grows / shrinks (spring), keep the clickable width following it.
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    if (_hitReq && _hitReq.height <= 112) reportIslandSize(_hitReq);
  }).observe(island);
}

function playStatusSound(category, kind) {
  const s = SET.sounds;
  if (s && s.enabled === false) return;
  if (s && category && s[category] === false) return;
  invokeTauri('play_status_sound', { kind: kind || category }).catch(() => {});
}

// ---------------------------------------------------------------------------------------
// Classic control panel: the 4 main tiles are FIXED (no slot swapping any more):
//   1 Wi-Fi, 2 Bluetooth, 3 Inex Drop, 4 File Tray
//   id -> { el: tile element id, start(): called when the tile is first shown, stop() }
// Wi-Fi / Bluetooth keep their backends running while their tile is shown.
// Microphone mute and Quick Notes are Quick Action tiles now (see renderQuickActionTiles).
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

const FIXED_TILE_ORDER = ['wifi', 'bt', 'drop', 'tray'];
function applySlots() {
  FIXED_TILE_ORDER.forEach((id, i) => {
    const def = SLOT_DEFS[id];
    const tile = document.getElementById(def.el);
    if (!tile) return;
    tile.classList.remove('hidden');
    tile.style.order = i + 1;
    if (!slotRunning.has(id)) {
      slotRunning.add(id);
      def.start();
    }
  });
}

// Microphone: real system mute of the default capture device
let micMutedState = null;
function renderMic(m) {
  micMutedState = m;
  const none = m === null || m === undefined;
  // Mac menu mic tile
  const mt = document.getElementById('mac-tile-mic');
  if (mt) {
    mt.classList.toggle('muted', m === true);
    mt.classList.toggle('active', m === false);
    const ms = document.getElementById('mac-mic-sub');
    if (ms) ms.textContent = none ? 'No mic' : m ? 'Muted' : 'On';
  }
  // Quick-action mic buttons (Classic quick row + Mac quick row)
  if (typeof syncMicQuickUi === 'function') syncMicQuickUi(m);
}
async function refreshMic() {
  renderMic(await invokeTauri('get_mic_muted'));
}
async function toggleMic() {
  await invokeTauri('set_mic_muted', { muted: micMutedState !== true });
  refreshMic();
}
document.getElementById('mac-tile-mic')?.addEventListener('click', () => toggleMic());
refreshMic();

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
  if (typeof macWidgetsReset === 'function') macWidgetsReset();
  if (typeof macPrayerReset === 'function') macPrayerReset();
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

  if (typeof suspendInactiveFeatures === 'function') suspendInactiveFeatures();   // Mac <-> Classic: drop features whose tile this layout lacks

  if (viewId === 'view-compact' && appState.timerStartPending) {
    appState.timerStartPending = false;
    setTimeout(() => { if (appState.timerRunning && typeof showTimerStartHud === 'function') showTimerStartHud(); }, 450);
  }
}

function applyMacMenuConfig() {
  const cfg = (SET.macMenu && typeof SET.macMenu === 'object') ? SET.macMenu : {};
  const statsMode = cfg.statsMode || 'sys';
  const showStatsCard = statsMode !== 'none';
  const map = {
    clock: true,
    weather: !SET.weather || SET.weather.enabled !== false,
    stats: showStatsCard,
    media: (!SET.notch || SET.notch.musicMode !== false),
  };
  Object.keys(map).forEach((k) => {
    const el = document.querySelector(`#view-control-mac [data-mac="${k}"]`);
    if (el) el.classList.toggle('hidden', !map[k]);
  });
  const mediaEl = document.getElementById('mac-media');
  if (mediaEl) mediaEl.classList.toggle('expanded', !showStatsCard);
  const batEl = document.getElementById('mac-stat-bat');
  if (batEl && appState.stats) {
    batEl.classList.toggle('hidden', !(appState.stats.battery_pct >= 0));
  }
  const topBat = document.getElementById('mac-battery');
  if (topBat && appState.stats) {
    topBat.classList.toggle('hidden', !(appState.stats.battery_pct >= 0));
  }
  const mxLeft = document.querySelector('#view-control-mac .mx-left');
  if (mxLeft) {
    const hasVisibleChild = [...mxLeft.children].some((c) => !c.classList.contains('hidden'));
    mxLeft.classList.toggle('hidden', !hasVisibleChild);
  }
  const switcher = document.querySelector('.mx-view-switcher');
  if (switcher) {
    const enabled = cfg.widgetsEnabled !== false;
    switcher.classList.toggle('hidden', !enabled);
    if (!enabled && typeof macWidgetsReset === 'function') macWidgetsReset();
  }
}

function openControlMenu() {
  if (typeof suspendInactiveFeatures === 'function') suspendInactiveFeatures();
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
  try { refreshMic(); } catch (_) {}
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
  if (mode === 'clock' || mode === 'pet') return { html: false, val: timeStr };
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
  const macWantsMedia = appState.currentView === 'view-control-mac';
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
  const askWifi = slotRunning.has('wifi') || macOn, askBt = slotRunning.has('bt') || macOn;
  // is the adapter there at all? (event-driven in Rust: dongle plugged in / removed)
  const [wifiHere, btHere] = await Promise.all([
    askWifi ? invokeTauri('get_radio_present', { kind: 'wifi' }) : null,
    askBt ? invokeTauri('get_radio_present', { kind: 'bt' }) : null
  ]);
  if (typeof wifiHere === 'boolean') applyPresence('wifi', wifiHere);
  if (typeof btHere === 'boolean') applyPresence('bt', btHere);
  const [wifiOn, btOn] = await Promise.all([
    askWifi && appState.wifiPresent ? invokeTauri('get_radio_state', { kind: 'wifi' }) : null,
    askBt && appState.btPresent ? invokeTauri('get_radio_state', { kind: 'bt' }) : null
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
  const mediaEl = document.getElementById('mac-media');
  if (mode === 'none') {
    if (macStatsCard) macStatsCard.classList.add('hidden');
    if (mediaEl) mediaEl.classList.add('expanded');
    return;
  }
  if (mediaEl) mediaEl.classList.remove('expanded');
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
onTauriEvent('wifi-changed', () => {
  clearTimeout(wifiEvT);
  wifiEvT = setTimeout(() => { if (typeof endWifiScan === 'function') endWifiScan(); refreshWifiNow(); }, 300);
});
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
      openControlMenu();
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
    openControlMenu();
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
  if (e.target.closest('#btn-alarm-snooze, #btn-alarm-dismiss')) return;
  e.stopPropagation();
  openControlMenu();
});
document.getElementById('btn-alarm-snooze')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (appState.alarmOpts && typeof appState.alarmOpts.onSnooze === 'function') { appState.alarmOpts.onSnooze(); return; }   // Adhan card: this button is "Mute"
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
let wifiBusyWant = '';   // 'on' | 'off' while a connect / disconnect is running
let wifiScanning = false, wifiScanT = null;

// Refresh button: ask Windows for a fresh radio scan right now. The spinner runs until Windows reports the
// scan (wifi-changed) or 4 s passed; nothing polls.
function endWifiScan() {
  wifiScanning = false;
  clearTimeout(wifiScanT);
  document.getElementById('btn-refresh-wifi')?.classList.remove('spin');
}
function startWifiScan() {
  if (!appState.wifiRadio) return loadWifiList();
  wifiScanning = true;
  document.getElementById('btn-refresh-wifi')?.classList.add('spin');
  clearTimeout(wifiScanT);
  wifiScanT = setTimeout(() => { endWifiScan(); if (isWifiViewOpen()) loadWifiList(true); }, 4000);
  invokeTauri('wifi_rescan').catch(() => {});
  loadWifiList(true);
}

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
  if (!wifiScanning) btn.classList.remove('spin');
  if (!isWifiViewOpen() || appState.keepOpen) return;
  const networks = res && Array.isArray(res.networks) ? res.networks : [];
  const scanError = res && res.error ? res.error : '';
  const wn = appState.stats && appState.stats.wifi_name;
  const current = wn && wn !== 'Not connected' ? wn : '';
  // the state we waited for is already true: release the busy button now (do not wait for the native call to return)
  if (wifiBusySsid && ((wifiBusyWant === 'on' && current === wifiBusySsid) || (wifiBusyWant === 'off' && current !== wifiBusySsid))) {
    wifiBusySsid = null; selectedWifiSsid = null;
  }
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
        if (isBusy && wifiBusyWant === 'off') { disBtn.disabled = true; disBtn.textContent = 'Disconnecting…'; }
        disBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          disBtn.disabled = true;
          disBtn.textContent = 'Disconnecting…';
          errEl.textContent = '';
          wifiBusySsid = n.ssid; wifiBusyWant = 'off';
          let done = false;
          try { done = (await invokeTauri('disconnect_wifi')) === true; } catch (_) { done = false; }
          if (wifiBusySsid !== n.ssid) return;   // the list already showed "offline" and released the button
          wifiBusySsid = null;
          if (!done) {
            // Windows did not let go: say so instead of pretending, and let the user try again
            disBtn.disabled = false;
            disBtn.textContent = 'Disconnect';
            errEl.textContent = 'Could not disconnect';
            return;
          }
          selectedWifiSsid = null;
          await refreshWifiNow();   // the real state from Windows, not a guess
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
        drawer.append(btnRow, errEl);
      } else if (n.saved) {
        const btnRow = document.createElement('div');
        btnRow.className = 'drawer-row';
        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn';
        connBtn.textContent = 'Connect';
        if (isBusy && wifiBusyWant === 'on') { connBtn.disabled = true; connBtn.textContent = 'Connecting…'; }
        connBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          connBtn.disabled = true;
          wifiBusySsid = n.ssid; wifiBusyWant = 'on';
          connBtn.textContent = 'Connecting…';
          let ok = false;
          try { ok = await invokeTauri('connect_wifi_network', { ssid: n.ssid }); } catch (_) { ok = false; }
          if (wifiBusySsid !== n.ssid) return;   // the list already showed "connected" and released the button
          wifiBusySsid = null;
          if (ok === false) {
            n.saved = false;
            loadWifiList(true);
            return;
          }
          selectedWifiSsid = null;
          refreshWifiNow();   // real state right now (no 2.5 s guess)
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
          wifiBusySsid = n.ssid; wifiBusyWant = 'on';
          connBtn.textContent = 'Connecting…';
          try { await invokeTauri('wifi_join', { ssid: n.ssid, password: '', security: 'open', hidden: false }); } catch (_) {}
          if (wifiBusySsid !== n.ssid) return;
          wifiBusySsid = null;
          selectedWifiSsid = null;
          refreshWifiNow();
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
  if (appState.wifiPresent === false) return;
  switchView('view-wifi', 'state-sub', 316, 208);
  loadWifiList();
}
document.getElementById('tile-wifi').addEventListener('click', (e) => {
  if (appState.wifiPresent === false) return;
  if (e.target.closest('.chev')) return openWifiView();
  toggleRadio('wifi', !appState.wifiRadio);
});
document.getElementById('tile-wifi').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openWifiView();
});
document.getElementById('btn-refresh-wifi').addEventListener('click', () => startWifiScan());
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
let btAction = null;   // { name, on } while a connect / disconnect is really running
let btScanning = false, btScanT = null;

// Refresh button: restart discovery and keep the spinner running for the discovery window (nothing polls)
function startBtScan() {
  if (!appState.btRadio) return loadBtList();
  btScanning = true;
  document.getElementById('btn-refresh-bt')?.classList.add('spin');
  clearTimeout(btScanT);
  btScanT = setTimeout(() => { btScanning = false; document.getElementById('btn-refresh-bt')?.classList.remove('spin'); }, 5000);
  invokeTauri('bt_discovery', { on: true });
  loadBtList(true);
}

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
  if (!btScanning) btn.classList.remove('spin');
  if (!isBtViewOpen() || appState.btBusy) return;
  // Windows already shows the device in the state we asked for: the action is done, even if the native call
  // is still finishing its checks. Let go of the busy state NOW so the button is not stuck on "Connecting…".
  if (btAction && Array.isArray(devices)) {
    const hit = devices.find((x) => x.name === btAction.name);
    if (hit && hit.connected === btAction.on) { btAction = null; selectedBtName = null; }
  }
  btList.innerHTML = '';
  const subs = [];
  if (!devices || devices.length === 0) {
    btList.innerHTML = `<div class="empty-hint">No paired devices found.</div>`;
  } else {
    setBtCaption(devices);
    devices.forEach((d) => {
      const working = !!btAction && btAction.name === d.name;
      const isExpanded = selectedBtName === d.name || working;
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
        connBtn.textContent = working ? (btAction.on ? 'Connecting…' : 'Disconnecting…') : (d.connected ? 'Disconnect' : 'Connect');

        const unpairBtn = document.createElement('button');
        unpairBtn.className = 'drawer-btn ghost danger';
        unpairBtn.textContent = 'Remove';
        if (working) connBtn.disabled = unpairBtn.disabled = true;

        const errEl = document.createElement('div');
        errEl.className = 'drawer-err';

        connBtn.addEventListener('click', async () => {
          const wantOn = !d.connected;
          connBtn.disabled = unpairBtn.disabled = true;
          connBtn.textContent = wantOn ? 'Connecting…' : 'Disconnecting…';
          errEl.textContent = '';
          const token = { name: d.name, on: wantOn };
          btAction = token;   // list refreshes during the action keep showing "Disconnecting…" until the state really changes
          let r = 'error';
          try { r = await invokeTauri('bt_set_connection', { name: d.name, on: wantOn }); } catch (_) { r = 'error'; }
          const stillMine = btAction === token;
          if (stillMine) btAction = null;
          else if (r !== 'ok') return;   // the list already showed the wanted state and released the button
          if (r !== 'ok') {
            const why = r === 'timeout' ? 'The device did not answer'
              : r === 'still_connected' ? 'It stayed connected (the device may be reconnecting by itself)'
              : r === 'notfound' ? 'Device not found'
              : 'Could not ' + (wantOn ? 'connect' : 'disconnect');
            if (isBtViewOpen()) await loadBtList(true);
            const e2 = document.querySelector('#bt-device-list .inline-action-drawer .drawer-err');
            if (e2) e2.textContent = why;
          } else {
            selectedBtName = null;
            if (isBtViewOpen()) loadBtList(true);   // Windows confirmed the new state, show it now
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
  if (appState.btPresent === false) return;
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
  if (appState.btPresent === false) return;
  if (e.target.closest('.chev')) return openBtView();
  toggleRadio('bt', !appState.btRadio);
});
document.getElementById('tile-bt').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openBtView();
});
document.getElementById('btn-refresh-bt').addEventListener('click', () => startBtScan());
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

// No adapter in this PC (no Bluetooth dongle / no Wi-Fi card): the tile is blocked, nothing opens, nothing is queried.
function applyPresence(kind, present) {
  const key = kind === 'wifi' ? 'wifiPresent' : 'btPresent';
  if (appState[key] === present) return;
  appState[key] = present;
  const label = kind === 'wifi' ? 'Wi-Fi' : 'Bluetooth';
  const tiles = kind === 'wifi' ? ['tile-wifi', 'mac-tile-wifi'] : ['tile-bt', 'mac-tile-bt'];
  tiles.forEach((id) => {
    const t = document.getElementById(id);
    if (!t) return;
    t.classList.toggle('unavailable', !present);
    t.setAttribute('aria-disabled', String(!present));
    t.title = present ? '' : `No ${label} adapter found`;
    if (!present) t.classList.remove('active');
  });
  const tog = document.getElementById(kind === 'wifi' ? 'wifi-master-toggle' : 'bt-master-toggle');
  if (tog) { tog.disabled = !present; if (!present) tog.checked = false; }
  if (!present) {
    if (kind === 'wifi') appState.wifiRadio = false; else appState.btRadio = false;
    (kind === 'wifi' ? ['wifi-sub', 'mac-wifi-sub'] : ['bt-sub', 'mac-bt-sub']).forEach((id) => {
      const e = document.getElementById(id); if (e) e.textContent = 'No adapter';
    });
    const cap = document.getElementById(kind === 'wifi' ? 'wifi-cap' : 'bt-cap'); if (cap) cap.textContent = '';
    if (kind === 'bt' && typeof syncMacBtTileIcon === 'function') syncMacBtTileIcon(null);
    // a list of a missing adapter must not stay open
    const open = kind === 'wifi' ? isWifiViewOpen() : isBtViewOpen();
    if (open) { try { if (currentMacSubTarget) closeMacSub(); else openControlMenu(); } catch (_) {} }
  } else {
    // adapter plugged in: read its real on/off state and show it
    if (typeof refreshRadios === 'function') refreshRadios().catch(() => {});
    if (kind === 'bt' && typeof refreshBtCaption === 'function') refreshBtCaption();
    if (kind === 'wifi' && typeof refreshWifiNow === 'function') refreshWifiNow();
  }
}

function applyRadio(kind, on) {
  if (kind === 'wifi' ? appState.wifiPresent === false : appState.btPresent === false) return;
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
  if (kind === 'wifi' ? appState.wifiPresent === false : appState.btPresent === false) return;   // no adapter: nothing to switch
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
  mic: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line class="q-mic-slash" x1="3" y1="3" x2="21" y2="21"/></svg>',
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
  mic: 'Microphone mute',
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

// Mic mute button in Classic quick row: slash + red tint while muted
function syncMicQuickUi(m) {
  const none = m === null || m === undefined;
  const title = none ? 'Microphone: no mic' : m ? 'Microphone: muted (click to unmute)' : 'Microphone: on (click to mute)';
  const el = document.getElementById('act-mic');
  if (!el) return;
  el.classList.toggle('muted', m === true);
  el.title = title;
}

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

const DEFAULT_ACTION_TILES = ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings'];
// Tiles the Mac layout always offers (quick row) - Keep Awake lives in its top bar (#mac-awake-btn), so it is always reachable there
const MAC_ACTIVE_TILES = ['notepad', 'clipboard', 'timer', 'calendar', 'snip'];

// The tile ids the user can actually reach in the current layout (what renderQuickActionTiles draws: first 7, or the defaults when none are configured)
function getActiveQuickTiles() {
  if (SET.appearance && SET.appearance.menuLayout === 'mac') return MAC_ACTIVE_TILES.concat('awake');
  const cfg = SET.menu && Array.isArray(SET.menu.actionTiles) && SET.menu.actionTiles.length ? SET.menu.actionTiles : DEFAULT_ACTION_TILES;
  return cfg.slice(0, 7);
}

// Smart Feature Suspension: a stateful tile feature (Keep Awake, Focus Timer) must not keep running
// invisibly when the active layout has no control for it (Mac -> Classic switch, or tile removed in Settings).
// Tiles that are still present keep running untouched.
let _suspendingAwake = false;
function suspendInactiveFeatures() {
  const active = getActiveQuickTiles();

  if (awakeState === true && !active.includes('awake') && !_suspendingAwake) {
    _suspendingAwake = true;
    awakeState = false;
    syncAwakeUi();
    Promise.resolve(invokeTauri('set_keep_awake', { on: false }))
      .catch(() => {})
      .finally(() => { _suspendingAwake = false; });
  }

  if (appState.timerRunning === true && !active.includes('timer') && typeof suspendFocusTimer === 'function') {
    suspendFocusTimer();
  }
}

function renderQuickActionTiles() {
  const row = document.getElementById('quick-icons-row');
  if (!row) return;
  const list = (SET.menu && Array.isArray(SET.menu.actionTiles) && SET.menu.actionTiles.length)
    ? SET.menu.actionTiles
    : DEFAULT_ACTION_TILES;

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
    } else if (id === 'mic') {
      btn.addEventListener('click', () => toggleMic());   // 1-click system mic mute / unmute (state sync via renderMic)
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
  syncMicQuickUi(typeof micMutedState === 'undefined' ? null : micMutedState);
  suspendInactiveFeatures();   // tile set changed: suspend anything whose tile just disappeared
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
  if ((viewId === 'view-bt' && appState.btPresent === false) || (viewId === 'view-wifi' && appState.wifiPresent === false)) return;
  if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
  closeMacSub();
  const src = document.getElementById(viewId);
  const mount = document.getElementById('mac-sub-mount');
  const actionsSlot = document.getElementById('mac-sub-actions');
  if (!src || !mount) return;
  currentMacSubTarget = { id: viewId, parent: src.parentNode, next: src.nextSibling };
  mount.appendChild(src);
  mount.classList.toggle('no-scroll', viewId === 'view-inexdrop' || viewId === 'view-p2p');   // these two never scroll here (no scrollbar flash)
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
    if (viewId === 'view-p2p') mountP2PBarItems(actionsSlot);   // timer / Cancel / status sit in the Back line (the QR slot stays in the body), like Wi-Fi / Bluetooth
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
  ['p2p-expiry-timer', 'btn-exit-room', 'p2p-status-pill'].forEach((id) => {
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
  document.getElementById('mac-sub-mount')?.classList.remove('no-scroll');
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
  if (appState.wifiPresent === false) return;
  if (e.target.closest('.mx-tile-chev')) openMacSub('view-wifi', 'Wi-Fi');
  else toggleRadio('wifi', !appState.wifiRadio);
});
document.getElementById('mac-tile-wifi')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMacSub('view-wifi', 'Wi-Fi');
});

document.getElementById('mac-tile-bt')?.addEventListener('click', (e) => {
  if (appState.btPresent === false) return;
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
    else if (act === 'snip') { goCompact(); invokeTauri('take_snip'); }
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
  if (typeof p2pNativeDrop === 'function' && p2pNativeDrop(p)) return;   // P2P menu open: a QR image goes to its slot
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
  // same rule as the classic tray: nothing picked yet = everything is picked
  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  const liveIds = new Set(files.map((x) => x.id));
  for (const id of Array.from(appState.traySelectedIds)) if (!liveIds.has(id)) appState.traySelectedIds.delete(id);
  if (appState.traySelectedIds.size === 0 && files.length > 0) files.forEach((x) => appState.traySelectedIds.add(x.id));
  files.forEach((f) => {
    const card = document.createElement('div');
    const picked = appState.traySelectedIds.has(f.id);
    card.className = 'mt-file' + (picked ? ' sel' : '');
    card.title = `${f.name} (Click to ${picked ? 'deselect' : 'select'})`;
    card.innerHTML = `
      <span class="mt-check">✓</span>
      <button class="mt-del" title="Remove file">×</button>
      <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
      <div class="mt-fname">${escHtml(f.name)}</div>`;
    card.querySelector('.mt-del').addEventListener('click', (e) => {
      e.stopPropagation();
      appState.trayFiles = appState.trayFiles.filter((t) => t.id !== f.id);
      if (appState.traySelectedIds) appState.traySelectedIds.delete(f.id);
      updateTrayUI();
    });
    // press + move = drag the file out; plain click = tick / untick it for sending (like the classic tray)
    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.mt-del')) return;
      const sx = e.clientX, sy = e.clientY;
      let dragged = false;
      const cleanup = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      const move = (ev) => {
        if (dragged) return;
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) { dragged = true; cleanup(); startDragOut(f); }
      };
      const up = () => {
        cleanup();
        if (dragged) return;
        if (appState.traySelectedIds.has(f.id)) appState.traySelectedIds.delete(f.id);
        else appState.traySelectedIds.add(f.id);
        const now = appState.traySelectedIds.has(f.id);
        card.classList.toggle('sel', now);
        card.title = `${f.name} (Click to ${now ? 'deselect' : 'select'})`;
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    list.appendChild(card);
  });
}

// Dropped / sent to Inex Drop in the Mac menu: whatever mode the side switch has selected is used.
//  Quick Share -> turns on by itself (files are staged for the phone)
//  P2P         -> NO code is generated for you; with a connected peer the files are offered to it, otherwise the
//                 P2P panel opens and you press Generate yourself
async function macSendToInexDrop() {
  const files = getSelectedTrayFiles();   // only the ticked files go (nothing ticked = all), same as the classic tray
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


// ==================== 09. P2P PEERS (WebRTC DATA CHANNEL, NO SERVER) ====================
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
  const dropBody = document.querySelector('#view-inexdrop .drop-body');
  const subMount = document.querySelector('.mx-sub-mount');
  const dropView = document.getElementById('view-inexdrop');
  if (dropBody) dropBody.classList.remove('has-prompt');
  if (subMount) subMount.classList.remove('has-prompt');
  if (dropView) dropView.classList.remove('has-prompt');
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
  syncScanHint();

  const boxIdle = document.getElementById('drop-state-idle');
  const boxActive = document.getElementById('drop-state-active');
  const boxPrompt = document.getElementById('drop-state-prompt');
  const dropBody = document.querySelector('#view-inexdrop .drop-body');
  const subMount = document.querySelector('.mx-sub-mount');
  const dropView = document.getElementById('view-inexdrop');

  const hasPrompt = !!currentOffer;
  if (dropBody) dropBody.classList.toggle('has-prompt', hasPrompt);
  if (subMount) subMount.classList.toggle('has-prompt', hasPrompt);
  if (dropView) dropView.classList.toggle('has-prompt', hasPrompt);

  if (currentOffer) {
    if (dropBody) dropBody.classList.remove('has-active');
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
    if (dropBody) dropBody.classList.remove('has-active');
    if (pill) { pill.textContent = 'Off'; pill.className = 'status-tag'; }
    if (boxIdle) boxIdle.classList.remove('hidden');
    if (boxActive) boxActive.classList.add('hidden');
    return;
  }

  if (dropBody) dropBody.classList.add('has-active');

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

// "Nearby devices" (in the Back line) only shows while Quick Share is on and no transfer is running
function syncScanHint() {
  const h = document.getElementById('qs-scan-hint');
  if (h) h.classList.toggle('off', !dropActive || !!inTransfer);
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
  syncScanHint();
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
  listEl.classList.toggle('is-empty', count === 0);   // only a short hint: no scrollbar
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
  if (snz) {
    snz.classList.toggle('hidden', !opts.snooze);
    snz.textContent = opts.snoozeLabel || 'Snooze';
    snz.title = opts.snoozeTitle || 'Snooze 9 minutes';
  }
  const stopBtn = document.getElementById('btn-alarm-dismiss');
  if (stopBtn) stopBtn.textContent = opts.dismissLabel || 'Stop';
  alarmBox.classList.toggle('pr-alert', opts.kind === 'prayer');          // Prayer & Solar Deck: calm Adhan card
  alarmBox.classList.remove('pr-quiet');
  island.classList.toggle('alarm-prayer', opts.kind === 'prayer');
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

  if (!opts.silent && SET.notch && SET.notch.timerSound !== false) {   // silent: caller plays its own sound (Adhan)
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
  try { if (appState.alarmOpts && appState.alarmOpts.onDismiss) appState.alarmOpts.onDismiss(); } catch (_) {}

  // content fades, island shrinks back to the pill (no bounce), the old status comes back
  island.classList.remove('hud-pre');
  island.classList.add('alarm-active', 'hud-out');
  alarmBackT = setTimeout(() => {
    island.classList.remove('alarm-active', 'alarm-full', 'hud-out', 'alarm-prayer');
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

// Smart Feature Suspension: pause the running Focus Timer (remaining time is kept) when its tile is
// no longer available in the active layout, so it doesn't keep counting - or show in the pill - unseen.
function suspendFocusTimer() {
  if (!appState.timerRunning) return;
  clearInterval(appState.timerInterval);
  appState.timerInterval = null;
  appState.timerRunning = false;
  appState.timerStartPending = false;
  const tgl = document.getElementById('btn-timer-toggle');
  if (tgl) tgl.textContent = '▶ Start';
  document.getElementById('act-timer')?.classList.remove('active');
  const cClock = document.getElementById('c-clock');
  if (cClock) cClock.classList.remove('c-clock-timer');
  formatTimerDisplay();   // also refreshes the timer chip
  updateClocks();         // pill goes back to showing the normal clock
  updateTimerChip();
}

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
    const res = await tryInvoke('set_clipboard_text', { text: noteArea.value });
    if (!res) await navigator.clipboard.writeText(noteArea.value);
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
  const view = appState.currentView;
  if (view !== 'view-compact' && view !== 'view-media') return;

  const freqs = (event.payload && event.payload.frequencies) || [];
  if (freqs.length >= 5) {
    lastFrequencies = freqs;
    const avg = freqs.reduce((a, b) => a + b, 0) / freqs.length;
    if (avg > 0.20) {
      eqQuietCount = 0;
      if (eqCompact.classList.contains('quiet')) eqCompact.classList.remove('quiet');
    } else {
      eqQuietCount++;
      if (eqQuietCount > 50 && !eqCompact.classList.contains('quiet')) eqCompact.classList.add('quiet');
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

  if (view !== 'view-compact' && view !== 'view-media') return;

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
const W_SVG = (inner) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="display:inline-block;vertical-align:-2px;margin-right:3px;flex-shrink:0;">${inner}</svg>`;

const W_ICONS = {
  sun: W_SVG('<circle cx="12" cy="12" r="5" fill="#FFB900"/><g stroke="#F59E0B" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22"/><line x1="2" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="6.7" y2="6.7"/><line x1="17.3" y1="17.3" x2="19.07" y2="19.07"/><line x1="4.93" y1="19.07" x2="6.7" y2="17.3"/><line x1="17.3" y1="6.7" x2="19.07" y2="4.93"/></g>'),
  moon: W_SVG('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#FBBF24"/><circle cx="17.5" cy="5.5" r="0.8" fill="#FDE68A"/><circle cx="20" cy="9.5" r="0.6" fill="#FDE68A"/>'),
  cloud_sun: W_SVG('<circle cx="8.5" cy="8.5" r="4.2" fill="#FFB900"/><g stroke="#F59E0B" stroke-width="1.6" stroke-linecap="round"><line x1="8.5" y1="2" x2="8.5" y2="3.8"/><line x1="2" y1="8.5" x2="3.8" y2="8.5"/><line x1="3.9" y1="3.9" x2="5.2" y2="5.2"/><line x1="13.1" y1="3.9" x2="11.8" y2="5.2"/></g><path d="M19.5 18H8a4.5 4.5 0 0 1-.4-8.98A5.5 5.5 0 0 1 18.8 11.5 3.5 3.5 0 0 1 19.5 18z" fill="#F1F5F9"/>'),
  cloud_moon: W_SVG('<path d="M13.5 3.8a4.5 4.5 0 0 1 4.8 4.8 4.5 4.5 0 0 1-.5 2A4 4 0 0 0 12 7a4 4 0 0 0-.2-1.7 4.5 4.5 0 0 1 1.7-1.5z" fill="#FBBF24"/><path d="M19.5 18H8a4.5 4.5 0 0 1-.4-8.98A5.5 5.5 0 0 1 18.8 11.5 3.5 3.5 0 0 1 19.5 18z" fill="#F1F5F9"/>'),
  cloud: W_SVG('<path d="M16 13a3.5 3.5 0 0 0-3.5-3.5 3.5 3.5 0 0 0-.6.05 4.8 4.8 0 0 0-7.4 2.45A3.5 3.5 0 0 0 6 17h10a3.5 3.5 0 0 0 0-7z" fill="#94A3B8" opacity="0.75"/><path d="M19.5 19H8a4.5 4.5 0 0 1-.4-8.98 5.5 5.5 0 0 1 10.7 2.48A3.5 3.5 0 0 1 19.5 19z" fill="#F8FAFC"/>'),
  rain: W_SVG('<path d="M19 14H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 14z" fill="#64748B"/><g stroke="#38BDF8" stroke-width="1.8" stroke-linecap="round"><line x1="8" y1="16" x2="6.5" y2="20.5"/><line x1="12" y1="16" x2="10.5" y2="20.5"/><line x1="16" y1="16" x2="14.5" y2="20.5"/></g>'),
  storm: W_SVG('<path d="M19 13.5H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 13.5z" fill="#475569"/><polygon points="12,12.5 8.5,17.5 11.5,17.5 10,22.5 15.5,16 12.5,16" fill="#FACC15" stroke="#EAB308" stroke-width="0.5"/>'),
  snow: W_SVG('<path d="M19 14H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 14z" fill="#94A3B8"/><circle cx="8" cy="18" r="1.2" fill="#BAE6FD"/><circle cx="12.5" cy="19.5" r="1.2" fill="#E0F2FE"/><circle cx="16.5" cy="18" r="1.2" fill="#BAE6FD"/>')
};

const WMO_CODES = {
  0: { day: W_ICONS.sun, night: W_ICONS.moon, text: 'Clear' },
  1: { day: W_ICONS.cloud_sun, night: W_ICONS.cloud_moon, text: 'Mostly Clear' },
  2: { day: W_ICONS.cloud_sun, night: W_ICONS.cloud_moon, text: 'Partly Cloudy' },
  3: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Mostly Cloudy' },
  45: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Fog' },
  48: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Haze' },
  51: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Light Drizzle' },
  53: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Drizzle' },
  55: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Drizzle' },
  56: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Freezing Drizzle' },
  57: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Freezing Drizzle' },
  61: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Light Rain' },
  63: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Rain' },
  65: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Heavy Rain' },
  66: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Rain' },
  67: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Rain' },
  71: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Light Snow' },
  73: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow' },
  75: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Heavy Snow' },
  77: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow Grains' },
  80: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Showers' },
  81: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Showers' },
  82: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Heavy Showers' },
  85: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow Showers' },
  86: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Heavy Snow' },
  95: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm' },
  96: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm with Hail' },
  99: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm with Hail' }
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
  const q = name.toLowerCase().trim();
  try {
    const sv = JSON.parse(localStorage.getItem('inex.geo') || 'null');
    if (sv && sv.q === q && sv.loc) return sv.loc;
  } catch (_) {}
  let r = null;
  const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
  const searchName = parts[0] || name;
  const rest = parts.slice(1).join(' ').toLowerCase();

  try {
    const res = await wxFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchName)}&count=10&language=en&format=json`);
    if (res.ok) {
      const d = await res.json();
      const list = (d && d.results) || [];
      if (list.length) {
        r = list[0];
        if (rest) {
          const hit = list.find((x) => [x.country, x.country_code, x.admin1, x.admin2].filter(Boolean).join(' ').toLowerCase().includes(rest));
          if (hit) r = hit;
        }
      }
    }
  } catch (_) {}

  // If no exact match for multi-word query (e.g. "Savar DEPZ", "Uttara Sector 10"), try main city words
  if ((!r || !isFinite(+r.latitude)) && name.includes(' ')) {
    const words = name.split(/[\s,/-]+/).filter(w => w.trim().length > 2);
    for (const w of words) {
      if (/^(depz|epz|zone|road|sector|block|area|thana|upazila)$/i.test(w)) continue;
      try {
        const subRes = await wxFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(w)}&count=5&language=en&format=json`);
        if (subRes.ok) {
          const subD = await subRes.json();
          if (subD && subD.results && subD.results[0]) {
            r = subD.results[0];
            break;
          }
        }
      } catch (_) {}
    }
  }

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

window.addEventListener('storage', (e) => {
  if (e.key === 'inex.weather.refresh') {
    weather.loc = null; weather.locAt = 0; weather.at = 0; weather.key = ''; weather.cityLoc = null; weather.cityQ = '';
    try {
      const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null');
      if (sv && sv.loc) { weather.loc = sv.loc; weather.locAt = sv.at || Date.now(); }
    } catch (_) {}
    refreshWeather();
  }
});

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
      newSvg.setAttribute('width', '14');
      newSvg.setAttribute('height', '14');
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
  let txt = appState.btRadio && appState.btPresent !== false && first ? first.name : '';
  if (txt && SET.overlays.btBattery) {
    const pct = btBatteryFor(first.name);
    if (pct !== null) txt += ` • ${pct}%`;
  }
  document.getElementById('bt-cap').textContent = txt;
  syncMacBtTileIcon(first);
  const macBtSub = document.getElementById('mac-bt-sub');
  if (macBtSub) {
    const _s = appState.btPresent === false ? 'No adapter' : appState.btRadio ? (first ? first.name : 'On') : 'Off';
    if (macBtSub.textContent !== _s) macBtSub.textContent = _s;
  }
}
async function refreshBtCaption() {
  if (!slotRunning.has('bt') && SET.appearance?.menuLayout !== 'mac') return;
  if (appState.btPresent === false || !appState.btRadio) { setBtCaption([]); return; }
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
let lastCopiedId = null;
let lastCopiedTimer = null;

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

// The clipboard view is open either as its own view (Classic) or mounted inside the Mac Control Deck sub-panel.
function isClipboardViewOpen() {
  return appState.currentView === 'view-clipboard' ||
         (typeof currentMacSubTarget !== 'undefined' && currentMacSubTarget?.id === 'view-clipboard');
}

// When the user clicks an item in the list we put it on the system clipboard ourselves. That triggers a
// "clipboard changed" event; this guard makes us ignore that echo so the item does NOT jump to the top.
let clipSelfSkip = { kind: null, hash: null, until: 0 };

function pushClipboardItem(item) {
  if (clipSelfSkip.hash && Date.now() < clipSelfSkip.until &&
      item.kind === clipSelfSkip.kind && item.hash === clipSelfSkip.hash) return false;
  const idx = clipboardItems.findIndex((it) => it.kind === item.kind && it.hash === item.hash);
  if (idx === 0) return false;
  if (idx > 0) clipboardItems.splice(idx, 1);
  clipboardItems.unshift(item);
  trimClipboardItems();
  saveClipboardHistory();
  if (isClipboardViewOpen()) renderClipboardList();
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
  if (isClipboardViewOpen()) renderClipboardList();
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
    if (gen !== clipRenderGen || !isClipboardViewOpen()) return;
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
      if (smallBlob && gen === clipRenderGen && isClipboardViewOpen()) {
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
  if (!isClipboardViewOpen()) return;
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
    if (item.id === lastCopiedId) card.classList.add('copied');
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
            showClipboardHud('Screenshot deleted');
            return;
          }
        } else {
          const res = await tryInvoke('set_clipboard_text', { text: item.text });
          if (res) {
            ok = true;
          } else {
            await navigator.clipboard.writeText(item.text);
            ok = true;
          }
        }
      } catch (_) { ok = false; }

      if (ok) {
        lastCopiedId = item.id;
        // keep the item where it is (no move to top) and ignore the clipboard-changed echo of our own copy
        clipSelfSkip = { kind: item.kind, hash: item.hash, until: Date.now() + 4000 };
        if (lastCopiedTimer) clearTimeout(lastCopiedTimer);
        lastCopiedTimer = setTimeout(() => {
          lastCopiedId = null;
          if (isClipboardViewOpen()) renderClipboardList();
        }, 1200);
        renderClipboardList();
        const hudText = item.kind === 'screenshot'
          ? (item.name || 'Screenshot')
          : (item.text.replace(/\s+/g, ' ').trim().slice(0, 22) + (item.text.trim().length > 22 ? '\u2026' : ''));
        showClipboardHud(hudText);
      } else {
        showClipboardHud('Copy failed');
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
  showToast('done', 'Clipboard cleared', 1200);
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
  if (typeof applyScreenTimeSetting === 'function') applyScreenTimeSetting();
  if (typeof prayerApplySettings === 'function') prayerApplySettings();
  island.dataset.menu = menuSurface(SET.appearance).style;
  const validTheme = ['default', 'matrix'].includes(SET.appearance.themeStyle) ? SET.appearance.themeStyle : 'default';
  island.dataset.theme = validTheme;
  island.setAttribute('data-mode', SET.notch.mode);
  island.setAttribute('data-style', SET.notch.style || 'attached');
  island.setAttribute('data-theme', validTheme);
  const macEars = SET.notch && SET.notch.style === 'curved';
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

// ==================== 11. CLOCK ALARMS ====================
// Managed in Settings > System > Alarms (and still editable from the optional "Alarm" quick tile).
// Alarms live in localStorage ("inex.alarms.v1", see shared.js): [{ id, h, m, on, daily }]  (h = 0-23).
// A once-alarm switches itself off after it rang. Snooze rings again after 9 minutes.
const ALARM_SNOOZE_MS = 9 * 60 * 1000;
let alarms = loadAlarms();
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

// The Settings window edits alarms in the same localStorage: pick its changes up and re-arm the background timer
subscribeAlarms((list) => {
  alarms = list;
  scheduleNextAlarm();
  if (appState.currentView === 'view-alarm') renderAlarmList();
});

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
  // Snap only AFTER the island stopped resizing (hover / open springs fire the observer every frame; snapping each frame made the
  // whole island flip 1 device px left/right = the small shake on hover).
  let snapT = 0;
  const snapLater = () => { clearTimeout(snapT); snapT = setTimeout(snap, 140); };
  if (typeof ResizeObserver === 'function') new ResizeObserver(snapLater).observe(island);
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

// ================================================================================================
// 18 - Notch Companion (pet) + Smart Health Reminders
// A plain slice of main.js like the other parts (no import / export). It uses these globals from the
// earlier parts: island, SET, appState, invokeTauri, onSettings, hudCanShow, popupIsBusy,
// hudIslandSize, reportIslandSize, hudRestoreSize, renderCenter, updateClocks, refreshMedia.
// It builds its own DOM (pet box + wellness HUD) and needs only src/pet.css and the Rust `pet_probe` command
// (with a Tauri window-API fallback for the cursor when `pet_probe` is missing or fails).
// Dev-tools handle: window.InexCompanion.peekNow() / .poke() / .hud('water' | 'eye' | 'stretch') / .addFocus(60)
// ================================================================================================
(function inexCompanionAndWellness() {
  'use strict';

  // ---------- settings (defaults also live in shared.js DEFAULTS) ----------
  const C0 = { enabled: false, skin: 'eyes', monogram: false, tracking: true, peekMinMin: 25, peekMaxMin: 60, activityPeekMin: 45 };
  const W0 = { enabled: false, water: true, waterEvery: 45, eye: true, eyeEvery: 20, stretch: true, stretchEvery: 60, idleReset: 30 };
  const cc = () => {
    const c = Object.assign({}, C0, SET.companion || {});
    // Settings > Resting Pill Display = "Companion Pet": the pet takes the place of the time, always in the centre.
    // Otherwise (Enable Companion on) the pet only peeks out now and then and the time comes back.
    c.pinned = false;
    if (SET.notch && SET.notch.compactContent === 'pet') { c.enabled = true; c.pinned = true; }
    return c;
  };
  const wc = () => Object.assign({}, W0, SET.wellness || {});
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ================================================================================================
  // SVG ASSETS
  // ================================================================================================
  // Eye skins: the original cyber pill eyes + new round / slit / visor eyes (viewBox units == CSS px at 1x; the CSS sets the rendered size)
  // look = max pupil travel in px [x, y] for each eye skin
  const LOOK = { eyes: [3, 3.4], orbs: [2.6, 2.6], slits: [2.2, 2.8], visor: [3.6, 1.2] };
  const SKINS = ['eyes', 'orbs', 'slits', 'visor', 'cat', 'dots'];
  function eyesSVG(kind) {
    const eye = (cx, cls) => {
      let body, pupil;
      if (kind === 'orbs') {
        body = `<circle class="eye-body" cx="${cx}" cy="10" r="7.4"/>`;
        pupil = `<circle class="pupil-core" cx="${cx}" cy="10.2" r="3.3"/><circle class="pupil-shine" cx="${cx + 1.2}" cy="8.8" r="1"/>`;
      } else if (kind === 'slits') {
        body = `<ellipse class="eye-body" cx="${cx}" cy="10" rx="6.6" ry="7.6"/>`;
        pupil = `<rect class="pupil-core" x="${cx - 1.2}" y="4.8" width="2.4" height="10.4" rx="1.2"/>`;
      } else if (kind === 'visor') {
        body = `<rect class="eye-body" x="${cx - 7.5}" y="6" width="15" height="8" rx="4"/>`;
        pupil = `<rect class="pupil-core" x="${cx - 2.6}" y="8" width="5.2" height="4" rx="2"/>`;
      } else {
        body = `<rect class="eye-body" x="${cx - 6}" y="2.5" width="12" height="15" rx="6"/>`;
        pupil = `<rect class="pupil-core" x="${cx - 2.4}" y="6.5" width="4.8" height="7" rx="2.4"/>`;
      }
      return `<g class="eye ${cls}"><ellipse class="eye-glow" cx="${cx}" cy="10" rx="9" ry="9.5"/>` +
        `<g class="eye-lid">${body}<g class="pupil">${pupil}</g></g></g>`;
    };
    return `<svg class="pet-svg" viewBox="0 0 40 20" aria-hidden="true">${eye(11, 'eye-l')}${eye(29, 'eye-r')}</svg>`;
  }

  // Skin B: 8-bit cat. Pixel art is drawn from ASCII rows so it is easy to edit.
  const CAT_HEAD = [
    '..##........##..',
    '..###......###..',
    '..############..',
    '.##############.',
    '.##############.',
    '.##############.',
    '.##############.',
    '.##############.',
    '..############..',
    '...##########...'
  ];
  function pixelRects(rows) {
    let out = '';
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (row[x] === '#') {
          const s = x;
          while (x < row.length && row[x] === '#') x++;
          out += `<rect x="${s}" y="${y}" width="${x - s}" height="1"/>`;
        } else x++;
      }
    });
    return out;
  }
  function catSVG() {
    const eyeBox = (x) => `<g class="cat-eye"><rect x="${x}" y="4" width="3" height="2" fill="#fff"/><rect class="cat-pupil" x="${x + 1}" y="4" width="1" height="1" fill="#1a1020"/></g>`;
    const happy = (x) => `<rect x="${x}" y="5" width="1" height="1"/><rect x="${x + 1}" y="4" width="1" height="1"/><rect x="${x + 2}" y="5" width="1" height="1"/>`;
    return `<svg class="pet-svg" viewBox="0 0 16 10" shape-rendering="crispEdges" aria-hidden="true">` +
      `<g class="cat-ear-l" fill="#f5b25a">${pixelRects(CAT_HEAD.slice(0, 2).map((r) => r.slice(0, 8).padEnd(16, '.')))}</g>` +
      `<g class="cat-ear-r" fill="#f5b25a">${pixelRects(CAT_HEAD.slice(0, 2).map((r) => '........' + r.slice(8)))}</g>` +
      `<g class="cat-head" fill="#f5b25a">${pixelRects(CAT_HEAD.slice(2))}</g>`.replace(/y="(\d+)"/g, (m, y) => `y="${+y + 2}"`) +
      `<g fill="#ff8fa3"><rect x="3" y="1" width="1" height="1"/><rect x="12" y="1" width="1" height="1"/><rect x="7" y="6" width="2" height="1"/></g>` +
      `<g class="cat-eyes">${eyeBox(3)}${eyeBox(10)}</g>` +
      `<g class="cat-happy" fill="#1a1020">${happy(3)}${happy(10)}</g>` +
      `<g fill="#1a1020"><rect x="6" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/></g>` +
      `</svg>`;
  }

  // Skin C: kinetic dots or minimalist monogram ("I" for Inex)
  function dotsSVG(mono) {
    return mono
      ? `<svg class="pet-svg" viewBox="0 0 30 12" aria-hidden="true"><g class="mono"><circle class="mono-ring" cx="15" cy="6" r="5"/><path class="mono-i" d="M15 3.4v5.2"/></g></svg>`
      : `<svg class="pet-svg" viewBox="0 0 30 12" aria-hidden="true"><g class="dots"><circle class="dot d1" cx="6" cy="6" r="2.3"/><circle class="dot d2" cx="15" cy="6" r="2.3"/><circle class="dot d3" cx="24" cy="6" r="2.3"/></g></svg>`;
  }

  // ================================================================================================
  // PET BOX (one element in the centre of the notch: overlay on the clock while peeking, in place of the clock when pinned)
  // ================================================================================================
  let box = null, inner = null, svgEl = null, pupils = [];
  let renderedKey = '';
  const MOODS = ['m-happy', 'm-wink', 'm-sleepy'];

  function build() {
    box = document.createElement('div');
    box.id = 'pet-box';
    box.className = 'pet-box hidden at-center';
    box.setAttribute('aria-hidden', 'true');
    inner = document.createElement('div');
    inner.className = 'pet-inner';
    box.appendChild(inner);
    box.addEventListener('click', onPoke);
    box.addEventListener('mouseenter', () => box.classList.add('is-hover'));
    box.addEventListener('mouseleave', () => box.classList.remove('is-hover'));
    mount('peek');
  }

  // where: 'peek' (overlay on the clock) | 'center' (in place of the clock)
  function mount(where) {
    const host = $('c-center-trigger');
    if (!host || !box) return;
    box.classList.toggle('at-inline', where === 'center');
    box.classList.toggle('at-center', where !== 'center');
    if (box.parentNode !== host) { host.appendChild(box); rectC = null; }
  }

  function renderSkin() {
    const c = cc();
    const skin = SKINS.indexOf(c.skin) >= 0 ? c.skin : 'eyes';
    const key = skin + (c.monogram ? 'm' : '');
    if (key === renderedKey) return;
    renderedKey = key;
    box.dataset.skin = skin;
    inner.innerHTML = skin === 'cat' ? catSVG() : skin === 'dots' ? dotsSVG(c.monogram) : eyesSVG(skin);
    svgEl = inner.firstElementChild;
    pupils = Array.prototype.slice.call(inner.querySelectorAll('.pupil, .cat-pupil'));
    lastCat = '';
    rectC = null;
    applyLook(T.x, T.y);
  }

  // ---------- one-shot animations + moods ----------
  const playT = {};
  function play(cls, ms) {
    if (!inner) return;
    clearTimeout(playT[cls]);
    inner.classList.remove(cls);
    void inner.offsetWidth;                       // restart the keyframes (event driven, not a tick loop)
    inner.classList.add(cls);
    playT[cls] = setTimeout(() => inner.classList.remove(cls), ms);
  }
  let moodT = 0;
  function setMood(name, ms) {
    if (!box) return;
    clearTimeout(moodT);
    MOODS.forEach((m) => box.classList.remove(m));
    if (name) box.classList.add('m-' + name);
    if (name && ms) moodT = setTimeout(() => box.classList.remove('m-' + name), ms);
  }

  // ---------- click reactions ----------
  const clicks = [];
  function onPoke(e) {
    if (e) e.stopPropagation();                  // do not trigger the notch / clock click underneath
    const now = performance.now();
    clicks.push(now);
    while (clicks.length && now - clicks[0] > 1200) clicks.shift();
    if (clicks.length >= 4) { clicks.length = 0; play('r-spin', 800); setMood('happy', 900); return; }   // rapid clicks -> spin
    const r = Math.floor(Math.random() * 3);
    if (r === 0) { play('r-purr', 900); setMood('happy', 900); }       // purr
    else if (r === 1) { setMood('wink', 700); }                        // wink
    else { play('r-giggle', 700); setMood('happy', 700); }             // giggle
  }

  // ================================================================================================
  // MOUSE TRACKING  (cursor -> angle + distance -> clamped, spring-smoothed pupil offset)
  // The island window is click-through outside the island, so the page gets no mouse events there.
  // Rust command `pet_probe` returns the cursor in window-relative logical px (+ idle ms).
  // ================================================================================================
  const T = { x: 0, y: 0, tx: 0, ty: 0, raf: 0, last: 0 };   // current / target look vector in the unit disc
  let lastCat = '';
  let rectC = null, rectAt = 0;
  let tracking = false, probeT = 0;
  const lastMouse = { x: 0, y: 0 };
  window.addEventListener('mousemove', (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; mouseSeen = true; }, { passive: true });
  window.addEventListener('resize', () => { rectC = null; });

  function applyLook(x, y) {
    if (!box || !svgEl) return;
    const skin = box.dataset.skin;
    if (LOOK[skin]) {
      const lk = LOOK[skin];
      const tf = 'translate3d(' + (x * lk[0]).toFixed(2) + 'px,' + (y * lk[1]).toFixed(2) + 'px,0)';
      for (let i = 0; i < pupils.length; i++) pupils[i].style.transform = tf;
      svgEl.style.transform = 'translate3d(' + (x * 1.6).toFixed(2) + 'px,' + (y * 0.9).toFixed(2) + 'px,0)';   // tiny head-turn
    } else if (skin === 'cat') {
      const px = Math.max(0, Math.min(2, Math.round(x + 1)));      // pixel art: whole cells only, no sub-pixel blur
      const py = y > 0.25 ? 1 : 0;
      const k = px + ',' + py;
      if (k === lastCat) return;
      lastCat = k;
      for (let i = 0; i < pupils.length; i++) pupils[i].style.transform = 'translate(' + px + 'px,' + py + 'px)';
    } else if (skin === 'dots') {
      svgEl.style.transform = 'translate3d(' + (x * 3).toFixed(2) + 'px,' + (y * 1.6).toFixed(2) + 'px,0)';
    }
  }

  function kick() {
    if (T.raf && performance.now() - T.last < 300) return;      // a stalled frame loop (paused by the webview) is restarted
    if (T.raf) cancelAnimationFrame(T.raf);
    T.last = performance.now();
    T.raf = requestAnimationFrame(step);
  }
  function step(t) {
    const dt = Math.min(0.05, (t - T.last) / 1000);
    T.last = t;
    const a = 1 - Math.exp(-dt / 0.07);                           // critically damped feel, ~70 ms time constant
    T.x += (T.tx - T.x) * a;
    T.y += (T.ty - T.y) * a;
    if (Math.abs(T.tx - T.x) < 0.003 && Math.abs(T.ty - T.y) < 0.003) {
      T.x = T.tx; T.y = T.ty; T.raf = 0;                          // settled: the loop stops, 0% CPU while the cursor is still
      applyLook(T.x, T.y);
      return;
    }
    applyLook(T.x, T.y);
    T.raf = requestAnimationFrame(step);
  }

  function aim(px, py) {
    const now = performance.now();
    if (!rectC || now - rectAt > 600) { rectC = box.getBoundingClientRect(); rectAt = now; }
    const ox = rectC.left + rectC.width / 2, oy = rectC.top + rectC.height / 2;
    const dx = px - ox, dy = py - oy;
    const dist = Math.hypot(dx, dy);
    const theta = Math.atan2(dy, dx);
    const k = Math.tanh(dist / 70);                               // 0..1, saturates smoothly: far cursor = full look, near = subtle
    const tx = Math.cos(theta) * k, ty = Math.sin(theta) * k;
    if (Math.abs(tx - T.tx) < 0.012 && Math.abs(ty - T.ty) < 0.012) return;   // dead-zone: ignore 1px cursor noise (no jitter)
    T.tx = tx; T.ty = ty;
    kick();
  }

  const BUSY_CLASSES = ['bt-hud-active', 'alarm-active', 'biometric-active', 'bio-hud', 'hud-pre', 'hud-out', 'hud-back',
    'wellness-hud-active', 'media-active', 'transferring', 'has-toast', 'incoming-open', 'smart-hidden'];
  // popups that cover the centre of the pill (the eyes cannot be seen, so there is nothing to aim)
  const COVER_CLASSES = ['bt-hud-active', 'alarm-active', 'biometric-active', 'wellness-hud-active', 'transferring', 'has-toast', 'incoming-open', 'smart-hidden'];
  function hudBusy() {
    if (!hudCanShow() || appState.alarmActive || popupIsBusy() || appState.isFs) return true;
    for (let i = 0; i < BUSY_CLASSES.length; i++) if (island.classList.contains(BUSY_CLASSES[i])) return true;
    return false;
  }
  // The eyes are on screen when the box is shown inside the resting pill and really has a size
  // (a playing track no longer switches tracking off while the pet is still visible)
  function petVisible() {
    if (!box || box.classList.contains('hidden') || !island.classList.contains('state-compact')) return false;
    for (let i = 0; i < COVER_CLASSES.length; i++) if (island.classList.contains(COVER_CLASSES[i])) return false;
    return box.offsetWidth > 0;
  }

  // Cursor source: the Rust `pet_probe` command first; if it is missing / keeps failing, the Tauri window API
  // (cursor position - window position, in logical px); last resort: the page's own mouse events.
  let probeSrc = 'rust', probeFails = 0, mouseSeen = false;
  async function readCursor() {
    if (probeSrc === 'rust') {
      try {
        const r = await invokeTauri('pet_probe');
        if (Array.isArray(r) && r.length >= 2 && isFinite(r[0]) && isFinite(r[1])) {
          probeFails = 0;
          lastIdle = r[2] | 0;
          return [r[0], r[1]];
        }
      } catch (_) {}
      if (++probeFails >= 3) probeSrc = 'api';
      return null;
    }
    try {
      const w = window.__TAURI__ && window.__TAURI__.window;
      const win = w && (w.getCurrentWindow ? w.getCurrentWindow() : w.getCurrent && w.getCurrent());
      if (!w || !win || !w.cursorPosition) return null;
      const res = await Promise.all([w.cursorPosition(), win.outerPosition(), win.scaleFactor()]);
      const sf = res[2] || 1;
      return [(res[0].x - res[1].x) / sf, (res[0].y - res[1].y) / sf];
    } catch (_) {
      return null;
    }
  }

  async function probeLoop() {
    if (!tracking) return;
    if (!cc().tracking) { stopTracking(true); return; }           // "Follow the Mouse" switched off while running
    if (!document.hidden && petVisible()) {
      const cur = await readCursor();
      if (!tracking) return;
      if (cur) aim(cur[0], cur[1]);
      else if (mouseSeen) aim(lastMouse.x, lastMouse.y);
    }
    if (tracking) { clearTimeout(probeT); probeT = setTimeout(probeLoop, 50); }   // 20 Hz probe, the rAF spring interpolates to the display rate
  }
  function startTracking() {
    if (tracking || !cc().tracking) return;
    tracking = true;
    clearTimeout(probeT);
    probeLoop();
  }
  function stopTracking(recenter) {
    tracking = false;
    clearTimeout(probeT);
    if (recenter) { T.tx = 0; T.ty = 0; kick(); }
  }

  // ================================================================================================
  // THE PEEKER (random, unannounced visit)  /  RESTING PILL = COMPANION PET (always there, in place of the time)
  // ================================================================================================
  let peekT = 0, peeking = false, peekRun = 0;

  function schedulePeek() {
    clearTimeout(peekT);
    const c = cc();
    if (!c.enabled || c.pinned) return;
    const lo = Math.max(1, +c.peekMinMin || 25), hi = Math.max(lo, +c.peekMaxMin || 60);
    peekT = setTimeout(() => startPeek('random'), (lo + Math.random() * (hi - lo)) * 60000);
  }

  async function startPeek(why) {
    const c = cc();
    if (why !== 'manual' && (!c.enabled || c.pinned)) return;
    if (peeking || c.pinned) return;                              // a pinned pet is already on screen
    if (hudBusy() && why !== 'manual') { clearTimeout(peekT); peekT = setTimeout(() => startPeek(why), 30000); return; }   // never fight a popup
    const run = ++peekRun;
    peeking = true;
    mount('peek');
    renderSkin();
    setMood(null);
    box.classList.remove('hidden');
    island.classList.add('has-pet', 'pet-peeking');
    const alive = () => run === peekRun && peeking && (why === 'manual' || !hudBusy());
    await sleep(560);                                             // spring-up
    if (!alive()) return endPeek();
    startTracking();
    await sleep(why === 'manual' ? 3500 : (6000 + Math.random() * 4000));                     // look around for 3.5-10 s
    if (!alive()) return endPeek();
    stopTracking(true);                                           // eyes back to centre, then a goodbye
    const bye = Math.random();                                    // small reaction, then the time comes back
    if (bye < 0.34) { play('r-wave', 900); setMood('happy', 900); await sleep(900); }
    else if (bye < 0.67) { setMood('wink', 700); await sleep(800); }
    else { setMood('sleepy', 800); await sleep(800); }
    if (run === peekRun) endPeek();
  }

  function endPeek() {
    peeking = false;
    peekRun++;
    stopTracking(true);
    island.classList.remove('pet-peeking');
    setTimeout(() => {
      if (!peeking && !island.classList.contains('pet-pinned') && box) { box.classList.add('hidden'); island.classList.remove('has-pet'); setMood(null); }
    }, 650);
    schedulePeek();
  }

  function applyCompanion() {
    if (!box) return;
    const c = cc();
    clearTimeout(peekT);
    if (!c.enabled) {
      peekRun++; peeking = false;
      stopTracking(false);
      island.classList.remove('has-pet', 'pet-peeking', 'pet-pinned', 'pet-center');
      box.classList.add('hidden');
      return;
    }
    renderSkin();
    if (c.pinned) {
      peekRun++; peeking = false;
      island.classList.remove('pet-peeking');
      island.classList.add('pet-pinned', 'has-pet', 'pet-center');   // the clock steps out, the pet takes its place
      mount('center');
      box.classList.remove('hidden');
      startTracking();
    } else {
      island.classList.remove('pet-pinned', 'pet-center');
      mount('peek');
      if (!peeking) { box.classList.add('hidden'); island.classList.remove('has-pet'); stopTracking(false); }
      schedulePeek();
    }
  }

  // ================================================================================================
  // ACTIVITY TICK (every 15 s): idle detection, long-activity peek, reminder scheduler
  // ================================================================================================
  const TICK_S = 15;
  const acc = { water: 0, eye: 0, stretch: 0 };   // active seconds since the last reminder of each kind
  let lastIdle = 0, streakSec = 0, activityPeeked = false, lastReminderAt = 0;

  async function tick() {
    if (!cc().enabled && !wc().enabled) return;   // nothing to remind / animate: no native call every 15 s
    let idleMs = 0;
    try {
      const r = await invokeTauri('pet_probe');
      if (Array.isArray(r)) idleMs = r[2] | 0;
    } catch (_) {}
    lastIdle = idleMs;
    const idle = idleMs / 1000;
    const w = wc(), c = cc();
    const active = idle < 60;                                      // at the PC (any keyboard / mouse input in the last minute)

    if (active) {
      acc.water += TICK_S; acc.eye += TICK_S; acc.stretch += TICK_S;
      streakSec += TICK_S;
    }
    // 20-20-20 and stretch need CONTINUOUS screen time: a real break resets them
    if (idle >= (+w.idleReset || 30)) acc.eye = 0;
    if (idle >= 300) { acc.stretch = 0; streakSec = 0; activityPeeked = false; }

    if (box && c.enabled) {
      box.classList.toggle('idle-sleepy', idle >= 90);             // pinned pet dozes off while you are away
      if (!c.pinned && !activityPeeked && streakSec >= (+c.activityPeekMin || 45) * 60) {
        activityPeeked = true;
        startPeek('activity');                                     // 45 min of intense work -> surprise visit
      }
    }

    if (!w.enabled || !active || performance.now() - lastReminderAt < 180000) return;
    const due = ['eye', 'water', 'stretch'].find((k) => w[k] && acc[k] >= Math.max(1, +w[k + 'Every'] || 30) * 60);
    if (due && showHud(due)) { acc[due] = 0; lastReminderAt = performance.now(); }   // busy popup -> not shown -> retried next tick
  }

  // ================================================================================================
  // WELLNESS HUD  (same morph flow as the Bluetooth / timer-end card: hud-pre -> spring open -> hud-out -> hud-back)
  // ================================================================================================
  const WL = {
    water: {
      title: 'Time for a sip!', sub: 'Stay hydrated \uD83D\uDCA7',
      svg: '<svg class="wl-svg" viewBox="0 0 24 24" aria-hidden="true"><ellipse class="rip r1" cx="12" cy="20" rx="5" ry="1.6"/><ellipse class="rip r2" cx="12" cy="20" rx="5" ry="1.6"/><path class="drop" d="M12 2.8c-3 3.9-5.2 6.4-5.2 9.2a5.2 5.2 0 0 0 10.4 0c0-2.8-2.2-5.3-5.2-9.2z"/></svg>'
    },
    eye: {
      title: 'Rest your eyes', sub: 'Look 20 ft away for 20 s \uD83D\uDC40',
      svg: '<svg class="wl-svg" viewBox="0 0 24 24" aria-hidden="true"><path class="eye-out" d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><g class="eye-iris"><circle cx="12" cy="12" r="3.4"/><circle class="gl" cx="13.2" cy="10.8" r="1"/></g></svg>'
    },
    stretch: {
      title: 'Time to stretch \uD83E\uDDD8\u200D\u2642\uFE0F', sub: 'Stand up, roll your shoulders',
      svg: '<svg class="wl-svg" viewBox="0 0 24 24" aria-hidden="true"><g class="st-fig"><circle class="st-head" cx="12" cy="5" r="2.2"/><path class="st-body" d="M12 8.5v6.5M12 15l-3 5.5M12 15l3 5.5"/><g class="st-arms"><path d="M12 10.5 6.5 5.5M12 10.5l5.5-5"/></g></g></svg>'
    }
  };
  const WL_CLASSES = ['hud-water-active', 'hud-eye-active', 'hud-stretch-active'];
  let wlHud = null, wlT = { open: 0, auto: 0, out: 0, end: 0 }, wlOpen = false;

  function buildHud() {
    const bar = document.querySelector('#view-compact .compact-bar');
    if (!bar) return;
    wlHud = document.createElement('div');
    wlHud.id = 'c-wellness-hud';
    wlHud.className = 'c-wellness-hud hidden';
    wlHud.innerHTML = '<span class="wl-ico" id="wl-ico"></span><span class="wl-text"><span class="wl-title" id="wl-title"></span><span class="wl-sub" id="wl-sub"></span></span>';
    wlHud.addEventListener('click', () => hideHud(false));         // tap to dismiss early
    bar.appendChild(wlHud);
  }

  function showHud(kind, force = false) {
    if (!wlHud || !WL[kind] || wlOpen) return false;
    if (!force && hudBusy()) return false;
    const d = WL[kind];
    $('wl-ico').innerHTML = d.svg;
    $('wl-title').textContent = d.title;
    $('wl-sub').textContent = d.sub;
    wlHud.classList.remove('hidden');
    void wlHud.offsetWidth;                                        // restart the staggered content animation
    wlOpen = true;
    stopTracking(false);
    if (peeking) { peekRun++; peeking = false; island.classList.remove('pet-peeking'); }
    clearTimeout(wlT.open); clearTimeout(wlT.auto); clearTimeout(wlT.out); clearTimeout(wlT.end);
    if (typeof cancelCloseEase === 'function') cancelCloseEase();
    reportIslandSize(hudIslandSize());                             // window big enough for the spring overshoot
    island.classList.add('hud-pre');                               // 1) old content blurs away
    wlT.open = setTimeout(() => {
      island.classList.remove('hud-pre');
      island.classList.add('wellness-hud-active', 'hud-' + kind + '-active');   // 2) island springs open
    }, 110);
    wlT.auto = setTimeout(() => hideHud(false), 5000 + 110);       // 3) auto-dismiss after 5 s (zero sound on purpose)
    return true;
  }

  function hideHud(instant) {
    if (!wlHud || !wlOpen) return;
    clearTimeout(wlT.open); clearTimeout(wlT.auto); clearTimeout(wlT.out); clearTimeout(wlT.end);
    const finish = () => {
      wlOpen = false;
      wlHud.classList.add('hidden');
      island.classList.remove('wellness-hud-active');
      if (!instant) island.classList.remove('hud-out', 'hud-back', 'hud-pre');   // instant = another popup owns those classes now
      WL_CLASSES.forEach((k) => island.classList.remove(k));
      hudRestoreSize();
      renderCenter(); updateClocks(); refreshMedia();
      applyCompanion();                                            // pinned pet resumes tracking
    };
    if (instant) { finish(); return; }
    island.classList.add('hud-out');                               // content fades
    wlT.out = setTimeout(() => {
      island.classList.remove('wellness-hud-active', 'hud-out');   // spring retraction (smooth ease-out, no bounce)
      WL_CLASSES.forEach((k) => island.classList.remove(k));
      island.classList.add('hud-back');
      wlT.end = setTimeout(finish, 600);
    }, 170);
  }

  // ================================================================================================
  // GRAND ALL-ANIMATIONS SHOWCASE TOUR (5 seconds each!)
  // ================================================================================================
  let demoRunning = false;
  async function runDemo() {
    if (demoRunning) return;
    demoRunning = true;
    try {
      // 1. Notch Companion Pet Peek (5 sec)
      startPeek('manual');
      await sleep(5000);
      onPoke(); // Pet poke reaction
      await sleep(2000);
      endPeek();
      await sleep(1000);

      // 2. Drink Water Reminder HUD (5 sec)
      showHud('water', true);
      await sleep(5500);

      // 3. Eye Rest 20-20-20 HUD (5 sec)
      showHud('eye', true);
      await sleep(5500);

      // 4. Stretch & Posture Alert HUD (5 sec)
      showHud('stretch', true);
      await sleep(5500);

      // 5. Windows Hello Face ID / Biometric Lock & Unlock Morph (5 sec)
      if (typeof triggerBiometricMorph === 'function') {
        triggerBiometricMorph('scan', 'Face ID • Unlocked');
        await sleep(5200);
      }

      // 6. Bluetooth Device Connect HUD (5 sec)
      if (typeof showDeviceHud === 'function') {
        const HEADPHONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
        showDeviceHud({
          iconHTML: HEADPHONE_SVG,
          name: 'AirPods Pro',
          tag: 'Connected • 98%',
          pct: 98,
          battery: false,
          ms: 5000
        });
        await sleep(5500);
      }

      // 7. MagSafe Power Charging HUD (5 sec)
      if (typeof showDeviceHud === 'function') {
        const BOLT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:20px;height:20px;"><path d="M11 21h-1l1-7H7.5c-.5 0-.8-.4-.6-.8L13 3h1l-1 7h3.5c.5 0 .8.4.6.8L11 21z"/></svg>';
        showDeviceHud({
          iconHTML: BOLT_SVG,
          battery: true,
          plain: true,
          accent: 'green',
          name: 'Charging',
          tag: '85% • Fast Power',
          pct: 85,
          ms: 5000
        });
        await sleep(5500);
      }

      // 8. Inex Drop / Quick Share File Received Toast (5 sec)
      if (typeof showToast === 'function') {
        showToast('done', 'Quick Share • File Received', 5000);
        await sleep(5500);
      }
    } catch (_) {}
    finally {
      demoRunning = false;
      try {
        if (typeof hudRestoreSize === 'function') hudRestoreSize();
        if (typeof renderCenter === 'function') renderCenter();
        if (typeof updateClocks === 'function') updateClocks();
        if (typeof refreshMedia === 'function') refreshMedia();
      } catch (_) {}
    }
  }

  // ================================================================================================
  // BOOT
  // ================================================================================================
  function init() {
    if (!island || !$('c-center-trigger') || !$('c-right-box')) return;
    build();
    buildHud();

    // Middle-click on center trigger to start demo tour anytime
    const trig = $('c-center-trigger');
    if (trig) {
      trig.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); e.stopPropagation(); runDemo(); }
      });
    }

    // another popup (Bluetooth, timer, transfer, toast...) took the island: close our HUD at once, no fighting
    new MutationObserver(() => {
      if (!wlOpen) return;
      const cl = island.classList;
      if (cl.contains('bt-hud-active') || cl.contains('alarm-active') || cl.contains('biometric-active') || cl.contains('transferring') || cl.contains('has-toast') || cl.contains('incoming-open') || !cl.contains('state-compact')) {
        hideHud(true);
      }
    }).observe(island, { attributes: true, attributeFilter: ['class'] });
    onSettings(() => { renderedKey = ''; applyCompanion(); if (!wc().enabled && wlOpen) hideHud(true); });
    applyCompanion();
    setInterval(tick, TICK_S * 1000);

    // Listen for demo triggers from Settings or System Tray
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
      window.__TAURI__.event.listen('companion-demo', (e) => {
        const k = (e && e.payload) ? e.payload : 'tour';
        if (k === 'tour') runDemo();
        else if (k === 'peek') startPeek('manual');
        else if (k === 'poke') onPoke();
        else if (k === 'water' || k === 'eye' || k === 'stretch') showHud(k, true);
      });
    }

    window.InexCompanion = {
      demo: () => runDemo(),
      peekNow: () => startPeek('manual'),
      poke: () => onPoke(),
      hud: (k) => showHud(k || 'water', true),
      state: () => ({ acc: Object.assign({}, acc), idleMs: lastIdle, peeking, tracking })
    };
  }
  init();
})();
// Mac Control Deck: Widgets tab (Screen Time ring, Speed Test, Currency, Markets with sparklines).
// Everything here is ACTIVE ONLY while the Widgets tab is open: the 30 s timer starts when the tab opens and
// stops when you go back to Controls or the menu closes. Screen Time TRACKING itself lives in Rust (screentime.rs)
// and always runs (unless switched off in Settings > Screen Time).
// (functions + var on purpose: switchView / applySettings can call into this part before it has executed)
var wgOpen = false;
var wgTimer = 0;
var wgStLast = null;
var wgRates = null;
var wgRatesAt = 0;
var wgRatesBusy = false;
var wgMkAt = 0;
var wgMkBusy = false;
var wgSpeedBusy = false;
var wgSpeedCtl = null;
var wgSpeedXhr = null;
var wgStGoal = 6 * 3600;      // ring target in seconds: your recent daily average (falls back to 6 h)
var wgStGoalAt = 0;
var wgSwapDeg = 0;

function wgEl(id) { return document.getElementById(id); }
function wgText(id, txt) { const e = wgEl(id); if (e) e.textContent = txt; }
function wgStOn() { return true; }
function wgAgo(ms) {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
}

function applyScreenTimeSetting() {
  // Session-only tracking in Rust
}

// exact time: 45s / 12m 30s / 2h 05m
function wgFmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm ' + String(r).padStart(2, '0') + 's';
  return s + 's';
}

// ---- tabs ----
function wgSetTab(name) {
  const deck = wgEl('view-control-mac');
  if (!deck) return;
  const w = name === 'widgets';
  if (w) {
    if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
    if (typeof closeMacSub === 'function') closeMacSub();
  }
  deck.classList.toggle('widgets-open', w);
  document.querySelector('.mx-view-switcher')?.setAttribute('data-active', w ? 'widgets' : 'controls');
  wgEl('mx-tab-controls')?.classList.toggle('active', !w);
  wgEl('mx-tab-widgets')?.classList.toggle('active', w);
  wgOpen = w;
  if (w) wgStart(); else wgStop();
}
// called from switchView(): the menu always opens on "Controls" and widgets stop when it closes
function macWidgetsReset() { if (wgOpen) wgSetTab('controls'); }

function wgStart() {
  wgStop();
  wgTick(true);
  wgTimer = setInterval(() => wgTick(false), 30000);
}
function wgStop() {
  if (wgTimer) { clearInterval(wgTimer); wgTimer = 0; }
  wgSpeedCancel();   // leaving the tab stops a running speed test (saves data)
}
function wgTick(first) {
  if (!wgOpen || appState.currentView !== 'view-control-mac') { wgStop(); return; }
  wgRefreshScreenTime();
  if (first || Date.now() - wgMkAt > 55000) wgRefreshMarkets();
  if (first || !wgRates || Date.now() - wgRatesAt > 3600000) wgLoadRates();   // rates cached for 1 h
  wgRateBadge();
}

// ---- Screen Time card: one ring per top app (share of today) + top 3 list, tooltip on the rings ----
const WG_APP_COLORS = [
  [/code|studio|devenv|cursor|jetbrains|idea|pycharm|rider/i, '#0a84ff'],
  [/chrome|edge|firefox|brave|opera|browser|safari/i, '#ffd60a'],
  [/figma|photoshop|illustrator|xd|canva|blender/i, '#bf5af2'],
  [/spotify|music|vlc|media|youtube/i, '#30d158'],
  [/discord|slack|teams|zoom/i, '#5e5ce6'],
  [/whatsapp|telegram|signal|messenger/i, '#32d74b'],
  [/word|excel|powerpoint|notion|obsidian|onenote/i, '#ff9f0a'],
  [/claude|antigravity/i, '#ff6a3d'],
];
const WG_DOT_FALLBACK = ['#ff375f', '#64d2ff', '#ff9f0a', '#5e5ce6', '#30d158', '#bf5af2'];
const WG_RING_R = [25, 19.5, 14];
var wgStRings = [];
var wgIcons = {};
function wgAppColor(a) {
  const key = (a.name || '') + ' ' + (a.exe || '');
  for (const [re, c] of WG_APP_COLORS) if (re.test(key)) return c;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return WG_DOT_FALLBACK[h % WG_DOT_FALLBACK.length];
}
// short time for the card: 45s / 24m / 1h 05m
function wgFmtShort(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm';
  return s + 's';
}
function wgDrawRings(total) {
  const svg = wgEl('wg-st-svg');
  if (!svg) return;
  let html = '';
  WG_RING_R.forEach((r, i) => {
    const c = 2 * Math.PI * r;
    html += '<circle class="wg-ring-bg" cx="28" cy="28" r="' + r + '"/>';
    const ring = wgStRings[i];
    if (ring && total > 0) {
      const frac = Math.max(0.03, Math.min(1, ring.secs / total));
      html += '<circle class="wg-ring-fg" cx="28" cy="28" r="' + r + '" stroke="' + ring.color + '" transform="rotate(-90 28 28)"' +
        ' stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c * (1 - frac)).toFixed(2) + '"/>';
    }
  });
  svg.innerHTML = html;
}
function wgDrawStList(apps) {
  const list = wgEl('wg-st-list');
  if (!list) return;
  list.textContent = '';
  if (!apps.length) {
    const row = document.createElement('div'); row.className = 'wg-st-app';
    const n = document.createElement('span'); n.textContent = 'No data yet';
    row.append(n); list.append(row);
    return;
  }
  apps.forEach((a) => {
    const row = document.createElement('div'); row.className = 'wg-st-app';
    let mark;
    if (wgIcons[a.exe]) { mark = new Image(); mark.alt = ''; mark.draggable = false; mark.src = wgIcons[a.exe]; }
    else { mark = document.createElement('i'); mark.style.setProperty('--dc', wgAppColor(a)); }
    const n = document.createElement('span'); n.textContent = a.name;
    const t = document.createElement('em'); t.textContent = wgFmtShort(a.secs);
    row.append(mark, n, t); list.append(row);
  });
}
function wgLoadIcons(apps) {
  const need = apps.map((a) => a.exe).filter((e) => !(e in wgIcons));
  if (!need.length) return;
  need.forEach((e) => { wgIcons[e] = ''; });
  invokeTauri('get_app_icons', { exes: need }).then((map) => {
    if (!map) return;
    Object.keys(map).forEach((k) => { wgIcons[k] = map[k]; });
    wgDrawStList(apps);
  }).catch(() => {});
}
async function wgRefreshScreenTime() {
  if (!wgStOn()) return;
  let d = null;
  try { d = await invokeTauri('get_screen_time_today'); } catch (_) {}
  if (!d) return;
  wgText('wg-st-total', wgFmtShort(d.total));
  const apps = (d.apps || []).slice(0, 3);
  wgStRings = apps.map((a) => ({ name: a.name, secs: a.secs, color: wgAppColor(a) }));
  wgDrawRings(d.total || 0);
  wgDrawStList(apps);
  wgLoadIcons(apps);
}
// hover on a ring -> small label with the app name and its time
function wgRingTip(e) {
  const svg = wgEl('wg-st-svg'), card = wgEl('wg-screentime'), tip = wgEl('wg-st-tip');
  if (!svg || !card || !tip) return;
  const r = svg.getBoundingClientRect();
  const k = r.width / 56;
  const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / k;
  let hit = -1;
  WG_RING_R.forEach((rr, i) => { if (Math.abs(d - rr) <= 3.2 && wgStRings[i]) hit = i; });
  if (hit < 0) { tip.style.display = 'none'; return; }
  tip.textContent = wgStRings[hit].name + ' \u2022 ' + wgFmtShort(wgStRings[hit].secs);
  const c = card.getBoundingClientRect();
  tip.style.display = 'block';
  tip.style.left = Math.max(4, Math.min(c.width - tip.offsetWidth - 4, e.clientX - c.left + 10)) + 'px';
  tip.style.top = Math.max(2, e.clientY - c.top - 22) + 'px';
}

// ---- http helper (Rust, curl.exe, allow-listed hosts) ----
async function wgGet(url) {
  const txt = await invokeTauri('http_get', { url });
  return JSON.parse(txt);
}

// ---- Currency ----
const WG_CUR_RGB = {
  USD: '48,209,88', INR: '255,159,10', EUR: '10,132,255', GBP: '191,90,242', BDT: '0,194,168',
  JPY: '255,69,58', AUD: '255,214,10', CAD: '255,55,95', AED: '100,210,255',
};
const WG_COUNTRY_MAP = {
  'bangladesh': 'BDT', 'bd': 'BDT', 'taka': 'BDT', 'tk': 'BDT', 'bdt': 'BDT',
  'pakistan': 'PKR', 'pk': 'PKR', 'pakistani': 'PKR', 'pkr': 'PKR',
  'india': 'INR', 'in': 'INR', 'rupee': 'INR', 'rs': 'INR', 'bharat': 'INR', 'inr': 'INR',
  'uae': 'AED', 'dubai': 'AED', 'emirates': 'AED', 'dirham': 'AED', 'aed': 'AED',
  'saudi': 'SAR', 'saudi arabia': 'SAR', 'ksa': 'SAR', 'riyal': 'SAR', 'sar': 'SAR',
  'kuwait': 'KWD', 'kwd': 'KWD', 'qatar': 'QAR', 'qar': 'QAR',
  'oman': 'OMR', 'omr': 'OMR', 'bahrain': 'BHD', 'bhd': 'BHD',
  'japan': 'JPY', 'yen': 'JPY', 'jpy': 'JPY',
  'china': 'CNY', 'chinese': 'CNY', 'yuan': 'CNY', 'rmb': 'CNY', 'cny': 'CNY',
  'singapore': 'SGD', 'sgd': 'SGD', 'malaysia': 'MYR', 'ringgit': 'MYR', 'myr': 'MYR',
  'indonesia': 'IDR', 'rupiah': 'IDR', 'idr': 'IDR', 'thailand': 'THB', 'baht': 'THB', 'thb': 'THB',
  'philippines': 'PHP', 'peso': 'PHP', 'php': 'PHP', 'vietnam': 'VND', 'dong': 'VND', 'vnd': 'VND',
  'nepal': 'NPR', 'npr': 'NPR', 'sri lanka': 'LKR', 'lkr': 'LKR',
  'south korea': 'KRW', 'korea': 'KRW', 'won': 'KRW', 'krw': 'KRW',
  'hong kong': 'HKD', 'hkd': 'HKD', 'taiwan': 'TWD', 'twd': 'TWD',
  'euro': 'EUR', 'europe': 'EUR', 'germany': 'EUR', 'france': 'EUR', 'italy': 'EUR', 'spain': 'EUR',
  'netherlands': 'EUR', 'ireland': 'EUR', 'belgium': 'EUR', 'austria': 'EUR', 'portugal': 'EUR',
  'greece': 'EUR', 'finland': 'EUR', 'eur': 'EUR',
  'uk': 'GBP', 'united kingdom': 'GBP', 'britain': 'GBP', 'england': 'GBP', 'pound': 'GBP', 'sterling': 'GBP', 'gbp': 'GBP',
  'russia': 'RUB', 'ruble': 'RUB', 'rub': 'RUB',
  'turkey': 'TRY', 'turkish': 'TRY', 'lira': 'TRY', 'try': 'TRY',
  'switzerland': 'CHF', 'swiss': 'CHF', 'franc': 'CHF', 'chf': 'CHF',
  'sweden': 'SEK', 'krona': 'SEK', 'sek': 'SEK', 'norway': 'NOK', 'krone': 'NOK', 'nok': 'NOK',
  'denmark': 'DKK', 'dkk': 'DKK', 'poland': 'PLN', 'zloty': 'PLN', 'pln': 'PLN',
  'usa': 'USD', 'us': 'USD', 'united states': 'USD', 'america': 'USD', 'dollar': 'USD', 'usd': 'USD',
  'canada': 'CAD', 'canadian': 'CAD', 'cad': 'CAD',
  'australia': 'AUD', 'australian': 'AUD', 'aud': 'AUD',
  'new zealand': 'NZD', 'nz': 'NZD', 'nzd': 'NZD',
  'brazil': 'BRL', 'real': 'BRL', 'brl': 'BRL',
  'mexico': 'MXN', 'mxn': 'MXN', 'argentina': 'ARS', 'ars': 'ARS',
  'egypt': 'EGP', 'egp': 'EGP', 'south africa': 'ZAR', 'rand': 'ZAR', 'zar': 'ZAR',
  'nigeria': 'NGN', 'naira': 'NGN', 'ngn': 'NGN',
};
// ISO country -> currency, so any country name (or its 2-letter code) resolves to a currency code.
const WG_REGION_CUR = ('AF AFN,AL ALL,DZ DZD,AO AOA,AR ARS,AM AMD,AU AUD,AT EUR,AZ AZN,BS BSD,BH BHD,BD BDT,BB BBD,BY BYN,BE EUR,BZ BZD,BJ XOF,BT BTN,BO BOB,BA BAM,BW BWP,BR BRL,BN BND,BG BGN,BF XOF,BI BIF,KH KHR,CM XAF,CA CAD,CV CVE,CF XAF,TD XAF,CL CLP,CN CNY,CO COP,KM KMF,CG XAF,CD CDF,CR CRC,CI XOF,HR EUR,CU CUP,CY EUR,CZ CZK,DK DKK,DJ DJF,DO DOP,EC USD,EG EGP,SV USD,GQ XAF,ER ERN,EE EUR,SZ SZL,ET ETB,FJ FJD,FI EUR,FR EUR,GA XAF,GM GMD,GE GEL,DE EUR,GH GHS,GR EUR,GT GTQ,GN GNF,GW XOF,GY GYD,HT HTG,HN HNL,HK HKD,HU HUF,IS ISK,IN INR,ID IDR,IR IRR,IQ IQD,IE EUR,IL ILS,IT EUR,JM JMD,JP JPY,JO JOD,KZ KZT,KE KES,KW KWD,KG KGS,LA LAK,LV EUR,LB LBP,LS LSL,LR LRD,LY LYD,LT EUR,LU EUR,MO MOP,MG MGA,MW MWK,MY MYR,MV MVR,ML XOF,MT EUR,MR MRU,MU MUR,MX MXN,MD MDL,MN MNT,ME EUR,MA MAD,MZ MZN,MM MMK,NA NAD,NP NPR,NL EUR,NZ NZD,NI NIO,NE XOF,NG NGN,MK MKD,NO NOK,OM OMR,PK PKR,PA PAB,PG PGK,PY PYG,PE PEN,PH PHP,PL PLN,PT EUR,QA QAR,RO RON,RU RUB,RW RWF,SA SAR,SN XOF,RS RSD,SC SCR,SL SLE,SG SGD,SK EUR,SI EUR,SO SOS,ZA ZAR,KR KRW,SS SSP,ES EUR,LK LKR,SD SDG,SR SRD,SE SEK,CH CHF,SY SYP,TW TWD,TJ TJS,TZ TZS,TH THB,TG XOF,TT TTD,TN TND,TR TRY,TM TMT,UG UGX,UA UAH,AE AED,GB GBP,US USD,UY UYU,UZ UZS,VE VES,VN VND,YE YER,ZM ZMW,ZW ZWL,PS ILS,XK EUR,KP KPW,BM BMD,KY KYD,PR USD,GU USD').split(',')
  .reduce((m, p) => { const [r, c] = p.split(' '); m[r] = c; return m; }, {});
let wgNameIdx = null;
function wgBuildNameIdx() {
  const idx = {};
  try {
    const cn = new Intl.DisplayNames(['en'], { type: 'currency' });
    for (const code of Object.keys(wgRates || {})) {
      const n = cn.of(code);
      if (n && n !== code) idx[n.toLowerCase()] = code;
    }
  } catch (_) {}
  try {
    const rn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (const [r, c] of Object.entries(WG_REGION_CUR)) {
      const n = rn.of(r);
      if (n) idx[n.toLowerCase()] = c;
    }
  } catch (_) {}
  return idx;
}
function wgResolveCurrency(inputStr) {
  if (!inputStr) return null;
  const raw = String(inputStr).trim().toLowerCase();
  if (!raw) return null;
  if (WG_COUNTRY_MAP[raw]) return WG_COUNTRY_MAP[raw];
  const upper = raw.toUpperCase();
  if (wgRates && wgRates[upper]) return upper;
  if (!wgNameIdx || (wgRates && !wgNameIdx.__rates)) { wgNameIdx = wgBuildNameIdx(); if (wgRates) wgNameIdx.__rates = true; }
  if (wgNameIdx[raw]) return wgNameIdx[raw];
  if (raw.length === 2 && WG_REGION_CUR[upper]) return WG_REGION_CUR[upper];
  if (raw.length >= 3) {
    // partial text ("bangla", "japan", "dollar"): first name that starts with it, else contains it
    for (const [k, v] of Object.entries(WG_COUNTRY_MAP)) if (k.startsWith(raw)) return v;
    for (const [k, v] of Object.entries(wgNameIdx)) if (k !== '__rates' && k.startsWith(raw)) return v;
    for (const [k, v] of Object.entries(wgNameIdx)) if (k !== '__rates' && k.includes(raw)) return v;
  }
  if (upper.length === 3) return upper;
  return null;
}
function wgNum(v) { return parseFloat(String(v).replace(/,/g, '')); }
function wgFmtNum(n) {
  if (!isFinite(n)) return '--';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : (n >= 1 ? 2 : 4) });
}
function wgCurCode(id) {
  const e = wgEl(id);
  if (!e) return '';
  const res = wgResolveCurrency(e.value);
  return res || (e.value || '').toUpperCase().trim();
}
function wgSaveCur() {
  try {
    localStorage.setItem('inex.wg.cur', JSON.stringify({
      a: wgCurCode('wg-cur-a-code') || 'USD', b: wgCurCode('wg-cur-b-code') || 'INR', amt: wgEl('wg-cur-a')?.value || '1'
    }));
  } catch (_) {}
}
function wgCurTint() {
  const codeA = wgCurCode('wg-cur-a-code'), codeB = wgCurCode('wg-cur-b-code');
  const card = wgEl('wg-currency');
  if (!card) return;
  const getRgb = (c) => {
    if (WG_CUR_RGB[c]) return WG_CUR_RGB[c];
    let h = 0;
    for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
    const palette = ['48,209,88', '255,159,10', '10,132,255', '191,90,242', '0,194,168', '255,69,58', '255,214,10', '100,210,255'];
    return palette[h % palette.length];
  };
  const ra = getRgb(codeA), rb = getRgb(codeB);
  card.style.setProperty('--ca', ra); card.style.setProperty('--cb', rb);
  wgEl('wg-cur-row-a')?.style.setProperty('--cc', ra);
  wgEl('wg-cur-row-b')?.style.setProperty('--cc', rb);
}
function wgRateBadge() {
  const e = wgEl('wg-cur-rate');
  const codeA = wgCurCode('wg-cur-a-code'), codeB = wgCurCode('wg-cur-b-code');
  if (!e || !codeA || !codeB) return;
  if (!wgRates || !wgRates[codeA] || !wgRates[codeB]) { e.textContent = 'Loading rate\u2026'; e.title = ''; return; }
  e.textContent = '1 ' + codeA + ' = ' + wgFmtNum(wgRates[codeB] / wgRates[codeA]) + ' ' + codeB;
  e.title = 'Updated ' + wgAgo(wgRatesAt);
}
function wgConvert(from) {
  const a = wgEl('wg-cur-a'), b = wgEl('wg-cur-b');
  const codeA = wgCurCode('wg-cur-a-code'), codeB = wgCurCode('wg-cur-b-code');
  wgCurTint();
  if (!a || !b || !codeA || !codeB || !wgRates) return;
  const ra = wgRates[codeA], rb = wgRates[codeB];
  if (!ra || !rb) return;
  if (from === 'a') { const n = wgNum(a.value); b.value = isFinite(n) ? wgFmtNum(n * rb / ra) : '--'; }
  else { const n = wgNum(b.value); a.value = isFinite(n) ? wgFmtNum(n * ra / rb) : '--'; }
  wgRateBadge();
  wgSaveCur();
}
async function wgLoadRates() {
  if (wgRatesBusy) return;
  wgRatesBusy = true;
  try {
    const j = await wgGet('https://open.er-api.com/v6/latest/USD');
    if (j && j.rates) { wgRates = j.rates; wgRatesAt = Date.now(); wgConvert('a'); }
  } catch (_) {}
  wgRatesBusy = false;
}

// ---- Markets: pick any 2 tickers (Yahoo Finance), 1-day sparkline, configured in Settings ----
const WG_MK_PRESETS = [
  ['BTC', 'BTC-USD'], ['ETH', 'ETH-USD'], ['SOL', 'SOL-USD'],
  ['NIFTY', '^NSEI'], ['SENSEX', '^BSESN'],
  ['S&P 500', '^GSPC'], ['NASDAQ', '^IXIC'], ['DOW', '^DJI'],
  ['TSLA', 'TSLA'], ['AAPL', 'AAPL'], ['NVDA', 'NVDA'], ['MSFT', 'MSFT'], ['GOOGL', 'GOOGL'], ['AMZN', 'AMZN'],
  ['GOLD', 'GC=F'],
];

function wgMkGetSym(i) {
  if (typeof SET !== 'undefined' && SET?.macMenu) {
    if (i === 0 && SET.macMenu.market1) return SET.macMenu.market1;
    if (i === 1 && SET.macMenu.market2) return SET.macMenu.market2;
  }
  return i === 0 ? 'BTC-USD' : '^NSEI';
}

function wgMkLabel(sym) {
  const p = WG_MK_PRESETS.find((x) => x[1] === sym);
  return p ? p[0] : sym.replace(/^\^/, '');
}
function wgMkRow(i) { return document.querySelector('#wg-markets .wg-mk-row[data-i="' + i + '"]'); }

function wgMkSpark(row, closes, up) {
  const svg = row.querySelector('.wg-spark');
  if (!svg) return;
  const pts = (closes || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (pts.length < 2) { svg.textContent = ''; return; }
  const W = 44, H = 16, pad = 1.5;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const xy = pts.map((v, k) => [
    (k / (pts.length - 1)) * W,
    pad + (1 - (v - lo) / span) * (H - pad * 2),
  ]);
  const line = xy.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const col = up ? '#30d158' : '#ff453a';
  svg.innerHTML = '<path class="l" d="' + line + '" stroke="' + col + '"/>';
}

function wgMkPrice(meta, px) {
  const sym = String(meta.symbol || '');
  const idx = sym.startsWith('^');
  const sign = idx ? '' : ({ USD: '$', INR: '\u20B9', EUR: '\u20AC', GBP: '\u00A3', JPY: '\u00A5' }[meta.currency] || '');
  return sign + px.toLocaleString('en-US', { maximumFractionDigits: px >= 1000 ? 0 : 2, minimumFractionDigits: px >= 1000 ? 0 : 2 });
}

async function wgMkFetch(sym) {
  const j = await wgGet('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=15m');
  const r = j.chart.result[0];
  const meta = r.meta;
  const closes = (r.indicators.quote[0].close || []).filter((v) => typeof v === 'number');
  const px = meta.regularMarketPrice;
  if (typeof px !== 'number') throw new Error('no price');
  const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : (closes.length ? closes[0] : null);
  return { meta, closes, px, pct: prev ? (px / prev - 1) * 100 : null };
}

async function wgMkUpdateRow(i) {
  const row = wgMkRow(i);
  if (!row) return;
  const sym = wgMkGetSym(i);
  const symEl = row.querySelector('.wg-sym');
  if (symEl) symEl.textContent = wgMkLabel(sym);
  const pxEl = row.querySelector('.wg-px'), chg = row.querySelector('.wg-chg');
  try {
    const d = await wgMkFetch(sym);
    if (symEl) symEl.textContent = wgMkLabel(sym);
    pxEl.textContent = wgMkPrice(d.meta, d.px);
    if (typeof d.pct === 'number' && isFinite(d.pct)) {
      chg.textContent = (d.pct >= 0 ? '+' : '\u2212') + Math.abs(d.pct).toFixed(2) + '%';
      chg.className = 'wg-chg ' + (d.pct >= 0 ? 'up' : 'down');
    } else { chg.textContent = '--'; chg.className = 'wg-chg'; }
    wgMkSpark(row, d.closes, !(d.pct < 0));
  } catch (_) {
    if (symEl) symEl.textContent = wgMkLabel(sym);
  }
}

async function wgRefreshMarkets() {
  if (wgMkBusy) return;
  wgMkBusy = true;
  wgMkAt = Date.now();
  await Promise.all([wgMkUpdateRow(0), wgMkUpdateRow(1)]);
  wgMkBusy = false;
}

// ---- Speed Test: Ping -> Download -> Upload with a live arc (Cloudflare speed endpoints, ~30 MB max) ----
const WG_GO_C = 2 * Math.PI * 22;
const WG_DL_CHUNK = 25000000, WG_UL_CHUNK = 1000000, WG_STREAMS = 4, WG_PHASE_MAX_MS = 8000, WG_WARM_MS = 1000;

function wgSpeedPhase(txt) { wgText('wg-speed-phase', txt); }
function wgSpeedArc(p) {
  const a = wgEl('wg-go-arc');
  if (a) a.style.strokeDashoffset = String(WG_GO_C * (1 - Math.max(0, Math.min(1, p))));
}
function wgSpeedCancel() {
  try { wgSpeedCtl?.abort(); } catch (_) {}
  try { wgSpeedXhr?.abort(); } catch (_) {}
}
function wgSpeedSaveLast(r) { try { localStorage.setItem('inex.wg.speed', JSON.stringify(r)); } catch (_) {} }
function wgSpeedRestore() {
  try {
    const r = JSON.parse(localStorage.getItem('inex.wg.speed') || 'null');
    if (!r || !r.t) return;
    wgText('wg-ping', r.ping != null ? String(r.ping) : '--');
    wgText('wg-down', r.down != null ? r.down.toFixed(1) : '--');
    wgText('wg-up', r.up != null ? r.up.toFixed(1) : '--');
    wgSpeedPhase('Last test \u00B7 ' + wgAgo(r.t));
  } catch (_) {}
}

// Mbps meter: ignores the first WG_WARM_MS (TCP slow start), then averages the rest
function wgMeter() {
  const t0 = performance.now();
  let wt = 0, wb = 0, warmed = false;
  return {
    mbps(bytes) {
      const el = performance.now() - t0;
      if (!warmed && el >= WG_WARM_MS) { warmed = true; wt = el; wb = bytes; }
      if (warmed && el - wt > 150) return ((bytes - wb) * 8) / 1e6 / ((el - wt) / 1000);
      return el > 80 ? (bytes * 8) / 1e6 / (el / 1000) : 0;
    },
    elapsed() { return performance.now() - t0; },
  };
}

// Download: 4 parallel streams (like Ookla / Fast.com), bytes counted as they arrive
async function wgSpeedDownload(base, signal, onLive) {
  const m = wgMeter();
  let got = 0, last = 0, stop = false;
  const worker = async () => {
    while (!stop && m.elapsed() < WG_PHASE_MAX_MS) {
      const r = await fetch(base + '__down?bytes=' + WG_DL_CHUNK + '&r=' + Math.random(), { cache: 'no-store', signal });
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        got += value.length;
        const v = m.mbps(got); last = v || last;
        onLive(last, Math.min(1, m.elapsed() / WG_PHASE_MAX_MS));
        if (m.elapsed() > WG_PHASE_MAX_MS) { stop = true; try { await rd.cancel(); } catch (_) {} break; }
      }
    }
  };
  await Promise.all(Array.from({ length: WG_STREAMS }, worker));
  return m.mbps(got) || last;
}

// Upload: 4 parallel streams of 1 MB POSTs. A chunk only counts AFTER the server has answered, so the number is the
// real speed (the old single XHR counted bytes that were still sitting in the browser's send buffer = wrong/too high).
async function wgSpeedUpload(base, signal, onLive) {
  const m = wgMeter();
  const body = new Uint8Array(WG_UL_CHUNK);
  for (let i = 0; i < body.length; i += 65536) crypto.getRandomValues(body.subarray(i, Math.min(i + 65536, body.length)));
  let sent = 0, last = 0;
  const worker = async () => {
    while (m.elapsed() < WG_PHASE_MAX_MS) {
      const r = await fetch(base + '__up?r=' + Math.random(), { method: 'POST', body, cache: 'no-store', signal });
      await r.arrayBuffer();
      sent += body.length;
      const v = m.mbps(sent); last = v || last;
      onLive(last, Math.min(1, m.elapsed() / WG_PHASE_MAX_MS));
    }
  };
  await Promise.all(Array.from({ length: WG_STREAMS }, worker));
  return m.mbps(sent) || last;
}

async function wgSpeedTest() {
  if (wgSpeedBusy) { wgSpeedCancel(); return; }   // pressing the button again cancels
  wgSpeedBusy = true;
  const card = wgEl('wg-speed'), label = wgEl('wg-go-label'), btn = wgEl('wg-speed-btn');
  card?.classList.remove('done'); card?.classList.add('testing');
  if (btn) btn.title = 'Stop';
  wgText('wg-ping', '--'); wgText('wg-down', '--'); wgText('wg-up', '--');
  wgSpeedArc(0);
  wgSpeedCtl = new AbortController();
  const signal = wgSpeedCtl.signal;
  const base = 'https://speed.cloudflare.com/';
  const res = { ping: null, down: null, up: null, t: 0 };
  try {
    // 1) Ping (first request only warms the connection)
    wgSpeedPhase('Ping\u2026'); label.textContent = '\u2026';
    let best = Infinity;
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      await fetch(base + '__down?bytes=0&r=' + Math.random(), { cache: 'no-store', signal });
      if (i > 0) { best = Math.min(best, performance.now() - t0); wgText('wg-ping', String(Math.round(best))); }
      wgSpeedArc(0.10 * ((i + 1) / 6));
    }
    res.ping = Math.round(best);
    // 2) Download
    wgSpeedPhase('Testing Download\u2026');
    res.down = await wgSpeedDownload(base, signal, (v, p) => {
      label.textContent = v ? String(Math.round(v)) : '\u2026';
      wgText('wg-down', v ? v.toFixed(1) : '--');
      wgSpeedArc(0.10 + 0.50 * p);
    });
    wgText('wg-down', res.down.toFixed(1));
    // 3) Upload
    wgSpeedPhase('Testing Upload\u2026'); label.textContent = '\u2026';
    res.up = await wgSpeedUpload(base, signal, (v, p) => {
      label.textContent = v ? String(Math.round(v)) : '\u2026';
      wgText('wg-up', v ? v.toFixed(1) : '--');
      wgSpeedArc(0.60 + 0.40 * p);
    });
    wgText('wg-up', res.up.toFixed(1));
    wgSpeedArc(1);
    res.t = Date.now();
    wgSpeedSaveLast(res);
    card?.classList.add('done');
    wgSpeedPhase('Done');
  } catch (_) {
    if (signal.aborted) { wgSpeedPhase('Cancelled'); wgSpeedRestoreValues(); }
    else { wgSpeedPhase('Test failed \u2013 check connection'); if (wgEl('wg-ping')?.textContent === '--') wgText('wg-ping', 'err'); }
  }
  card?.classList.remove('testing');
  label.textContent = 'GO';
  if (btn) btn.title = 'Start speed test';
  if (!card?.classList.contains('done')) wgSpeedArc(0);
  wgSpeedXhr = null; wgSpeedCtl = null; wgSpeedBusy = false;
}
function wgSpeedRestoreValues() {
  try {
    const r = JSON.parse(localStorage.getItem('inex.wg.speed') || 'null');
    wgText('wg-ping', r && r.ping != null ? String(r.ping) : '--');
    wgText('wg-down', r && r.down != null ? r.down.toFixed(1) : '--');
    wgText('wg-up', r && r.up != null ? r.up.toFixed(1) : '--');
  } catch (_) {}
}

// ---- wiring ----
wgEl('mx-tab-controls')?.addEventListener('click', () => wgSetTab('controls'));
wgEl('mx-tab-widgets')?.addEventListener('click', () => wgSetTab('widgets'));
wgEl('wg-speed-btn')?.addEventListener('click', wgSpeedTest);
wgEl('wg-st-svg')?.addEventListener('mousemove', wgRingTip);
wgEl('wg-st-svg')?.addEventListener('mouseleave', () => { const t = wgEl('wg-st-tip'); if (t) t.style.display = 'none'; });
wgEl('wg-markets')?.addEventListener('click', () => {
  try { localStorage.setItem('inex.settings.goto', 'menu'); } catch (_) {}
  invokeTauri('open_settings');
});
function wgCommitCurrency(inp, from) {
  const resolved = wgResolveCurrency(inp.value);
  if (resolved) {
    inp.value = resolved;
    inp.title = resolved;
  } else {
    inp.value = (inp.value || '').toUpperCase().trim();
  }
  wgCurTint();
  // Changing a currency code must recalculate from the amount box (A), never from an empty/"--" box:
  // converting from B when it was empty filled both boxes with "--" and left them blank.
  const a = wgEl('wg-cur-a');
  if (a && !isFinite(wgNum(a.value))) a.value = '1';
  wgConvert('a');
}
wgEl('wg-cur-a')?.addEventListener('input', () => wgConvert('a'));
wgEl('wg-cur-b')?.addEventListener('input', () => wgConvert('b'));
['a', 'b'].forEach((side) => {
  const inp = wgEl('wg-cur-' + side + '-code');
  if (!inp) return;
  inp.addEventListener('focus', () => { inp.select(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      wgCommitCurrency(inp, side);
      inp.blur();
    }
  });
  inp.addEventListener('blur', () => {
    wgCommitCurrency(inp, side);
  });
});
wgEl('wg-cur-swap')?.addEventListener('click', () => {
  const a = wgEl('wg-cur-a'), b = wgEl('wg-cur-b'), ac = wgEl('wg-cur-a-code'), bc = wgEl('wg-cur-b-code');
  if (!a || !b || !ac || !bc) return;
  [a.value, b.value] = [b.value, a.value];
  [ac.value, bc.value] = [bc.value, ac.value];
  wgSwapDeg += 180;
  const sw = wgEl('wg-cur-swap');
  if (sw) sw.style.transform = 'rotate(' + wgSwapDeg + 'deg)';
  wgCurTint(); wgRateBadge(); wgSaveCur();
});
try {
  const saved = JSON.parse(localStorage.getItem('inex.wg.cur') || 'null');
  if (saved) {
    if (saved.a && wgEl('wg-cur-a-code')) wgEl('wg-cur-a-code').value = saved.a;
    if (saved.b && wgEl('wg-cur-b-code')) wgEl('wg-cur-b-code').value = saved.b;
    if (saved.amt && wgEl('wg-cur-a')) wgEl('wg-cur-a').value = saved.amt;
  } else {
    if (wgEl('wg-cur-a-code')) wgEl('wg-cur-a-code').value = 'USD';
    if (wgEl('wg-cur-b-code')) wgEl('wg-cur-b-code').value = 'INR';
    if (wgEl('wg-cur-a')) wgEl('wg-cur-a').value = '1';
  }
} catch (_) {}
wgCurTint();
wgSpeedRestore();
applyScreenTimeSetting();

// ==================== 20. PRAYER & SOLAR DECK (optional, OFF by default) ====================
// Settings > Notch > Prayer Times.  While "Prayer & Solar Deck" is off this part does nothing at all:
// no button, no timer, no network, no audio.  Everything is calculated offline from latitude / longitude
// (NOAA-style solar position), so the only network use is ONE location lookup that is then cached for good.
//
//  * Deck      : mosque button in the Control Deck top strip -> #mx-prayer-body (solar arc + prayer list).
//                Its 20 s refresh timer exists ONLY while the deck is open.
//  * Alerts    : ONE setTimeout aimed at the next alert (same pattern as clock alarms: 0 timers when off).
//  * Adhan card: re-uses the timer-end island card (triggerTimerAlarm) with { kind: 'prayer' }.
//  * Audio     : local files in src/audio/ (see PR_SOUNDS), falls back to the chime when a file is missing.
// (functions + var on purpose: applySettings() runs before this part has executed)

var prayer = {
  open: false,
  ui: 0,            // deck refresh interval id
  evTimer: 0,       // next-alert timeout id
  loc: null,        // { lat, lon, city, tz }
  locBusy: false,
  locFailAt: 0,
  locErr: '',
  sig: '',
  dayKey: '',
  days: null,       // { today, tomorrow } calculated times (epoch ms)
  audio: null,
  cardTok: 0,
  fired: ''
};
var prayerMO = null;

var PR_ANGLE = { fajr: 18, isha: 18 };            // Karachi / Islamic Foundation (South Asia): 18 deg / 18 deg
var PR_ADJ_MIN = { dhuhr: 1, maghrib: 0 };        // +1 min after solar noon (standard safety margin)
var PR_NAMES = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
var PR_ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
var PR_FIVE = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
// Put the recordings in src/audio/ (anything the Tauri frontend serves, CSP "self" allows it).
var PR_SOUNDS = { madinah: 'audio/adhan-madinah.mp3', short: 'audio/adhan-short.mp3', beep: 'audio/chime.wav' };
var PR_FIRED_KEY = 'inex.prayer.fired';
var PR_LOC_KEY = 'inex.prayer.loc';

function prEl(id) { return document.getElementById(id); }
function prCfg() { return (typeof SET !== 'undefined' && SET && SET.prayer) || {}; }
function prOn() { return !!prCfg().enabled; }

// ---------------------------------------------------------------- astronomy (offline, no libraries)
// Sun declination + equation of time at a Julian date (accurate to well under a minute for prayer use).
function prSun(jd) {
  const R = Math.PI / 180;
  const n = jd - 2451545.0;
  const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360;              // mean longitude (deg)
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * R;        // mean anomaly
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * R;    // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * R;                               // obliquity
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / R;   // deg
  let eq = L - ra;
  eq = (((eq + 180) % 360) + 360) % 360 - 180;
  return { dec: dec, eqMin: eq * 4 };                                     // 1 deg of RA = 4 min of time
}
// hours from solar noon until the sun sits at altitude `alt` (deg); NaN when it never does (polar day / night)
function prHourAngle(alt, lat, dec) {
  const R = Math.PI / 180;
  const c = (Math.sin(alt * R) - Math.sin(lat * R) * Math.sin(dec)) / (Math.cos(lat * R) * Math.cos(dec));
  if (c < -1 || c > 1 || !isFinite(c)) return NaN;
  return Math.acos(c) / R / 15;
}
// UTC offset (hours) of an IANA zone at an instant; no zone = this PC's zone
function prTzOffset(tz, ms) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const p = {};
    f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return (asUtc - Math.floor(ms / 1000) * 1000) / 3600000;
  } catch (_) { return -new Date(ms).getTimezoneOffset() / 60; }
}
// calendar date (y, m0, d) it is right now in that zone
function prYMD(tz, ms) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric' });
    const p = {};
    f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    return { y: +p.year, m: +p.month - 1, d: +p.day };
  } catch (_) { const d = new Date(ms); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() }; }
}
// All six times of one civil date at a place, as epoch ms (null when the sun cannot give them, e.g. polar summer)
function prCalc(loc, y, m, d, hanafi) {
  const base = Date.UTC(y, m, d);                                        // 00:00 UTC of that date
  const tzH = prTzOffset(loc.tz, base + 12 * 3600000);
  const jdAt = (localH) => (base + (localH - tzH) * 3600000) / 86400000 + 2440587.5;
  const transit = (sp) => 12 + tzH - loc.lon / 15 - sp.eqMin / 60;       // local clock hours
  const R = Math.PI / 180;
  let T = transit(prSun(jdAt(12)));
  T = transit(prSun(jdAt(T)));                                           // refine with the sun at noon itself
  // event: sign -1 morning / +1 evening; alt = sun altitude in deg, or 'asr'
  const ev = (alt, sign) => {
    let g = T;
    for (let k = 0; k < 3; k++) {
      const sp = prSun(jdAt(g));
      const a = alt === 'asr'
        ? Math.atan(1 / ((hanafi ? 2 : 1) + Math.tan(Math.abs(loc.lat - sp.dec / R) * R))) / R
        : alt;
      const H = prHourAngle(a, loc.lat, sp.dec);
      if (isNaN(H)) return NaN;
      g = transit(sp) + sign * H;
    }
    return g;
  };
  let h = {
    fajr: ev(-PR_ANGLE.fajr, -1),
    sunrise: ev(-0.833, -1),
    dhuhr: T + PR_ADJ_MIN.dhuhr / 60,
    asr: ev('asr', 1),
    maghrib: ev(-0.833, 1) + PR_ADJ_MIN.maghrib / 60,
    isha: ev(-PR_ANGLE.isha, 1)
  };
  if (isNaN(h.sunrise) || isNaN(h.maghrib)) return null;
  const night = h.sunrise + 24 - h.maghrib;                              // high latitudes: night / 7 rule
  if (isNaN(h.fajr)) h.fajr = h.sunrise - night / 7;
  if (isNaN(h.isha)) h.isha = h.maghrib + night / 7;
  const out = { base: base, tzH: tzH };
  PR_ORDER.forEach((k) => { out[k] = base + (Math.round(h[k] * 60) / 60 - tzH) * 3600000; });   // whole minutes
  return out;
}

// ---------------------------------------------------------------- custom masjid timings
// "5:12", "05:12 AM", "17:12", "5.12": a missing AM/PM is guessed the way mosque boards are written.
function prParseClock(str, key) {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*(am|pm)?\s*$/i.exec(String(str || ''));
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (mi > 59 || h > 23) return null;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  else if (ap === 'am' && h === 12) h = 0;
  else if (!ap && h <= 12) {
    if (key === 'fajr') { if (h === 12) h = 0; }
    else if (key === 'dhuhr') { if (h < 11) h += 12; }
    else if (h < 12) h += 12;                                            // Asr / Maghrib / Isha are afternoon / evening
  }
  return h * 60 + mi;
}
function prApplyMasjid(t, dayOff) {
  const c = prCfg();
  if (!c.masjidOverride || !c.masjid || !t) return t;
  const o = Object.assign({}, t);
  PR_FIVE.forEach((k) => {
    const mins = prParseClock(c.masjid[k], k);
    if (mins != null) o[k] = t.base + (mins / 60 - t.tzH) * 3600000;
  });
  return o;
}

// ---------------------------------------------------------------- location (resolved ONCE, then cached for good)
function prFetch(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
}
async function prGeocode(query) {
  const parts = String(query).split(',').map((s) => s.trim()).filter(Boolean);
  const name = parts[0] || query;
  const rest = parts.slice(1).join(' ').toLowerCase();
  const res = await prFetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name) + '&count=10&language=en&format=json');
  if (!res.ok) return null;
  const d = await res.json();
  const list = (d && d.results) || [];
  if (!list.length) return null;
  let r = list[0];
  if (rest) {   // "Sagardighi, India": pick the hit whose country / state matches the second part
    const hit = list.find((x) => [x.country, x.country_code, x.admin1, x.admin2].filter(Boolean).join(' ').toLowerCase().includes(rest));
    if (hit) r = hit;
  }
  if (!isFinite(+r.latitude) || !isFinite(+r.longitude)) return null;
  return { lat: +r.latitude, lon: +r.longitude, city: r.name || name, tz: r.timezone || '' };
}
async function prIpLocation(forceFresh = false) {
  if (!forceFresh) {
    try {   // the weather feature may already know where this PC is: reuse it if recent (<1h)
      const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null');
      if (sv && sv.loc && isFinite(sv.loc.lat) && isFinite(sv.loc.lon) && (Date.now() - (sv.at || 0) < 60 * 60 * 1000)) {
        return { lat: +sv.loc.lat, lon: +sv.loc.lon, city: sv.loc.city || '', tz: '' };
      }
    } catch (_) {}
  }
  const tries = [
    async () => { const r = await prFetch('https://ipwho.is/'); if (!r.ok) return null; const d = await r.json(); return d && d.success !== false && d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '', tz: '' } : null; },
    async () => { const r = await prFetch('https://ipapi.co/json/'); if (!r.ok) return null; const d = await r.json(); return d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '', tz: '' } : null; },
    async () => { const r = await prFetch('https://freeipapi.com/api/json'); if (!r.ok) return null; const d = await r.json(); return d && d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.cityName || '', tz: '' } : null; }
  ];
  for (const t of tries) { try { const l = await t(); if (l && isFinite(l.lat) && isFinite(l.lon)) return l; } catch (_) {} }
  return null;
}
// Returns true when prayer.loc is usable. Auto mode keeps the PC's own time zone (an IP lookup is near the PC).
async function prEnsureLoc(forceFresh = false) {
  const c = prCfg();
  const cityStr = String(c.city || '').trim();
  const manual = !!cityStr;
  const q = cityStr.toLowerCase();
  let cached = null;
  if (!forceFresh) {
    try { cached = JSON.parse(localStorage.getItem(PR_LOC_KEY) || 'null'); } catch (_) {}
    if (cached && cached.loc && (manual ? (cached.mode === 'manual' && cached.q === q) : cached.mode === 'auto')) {
      prayer.loc = cached.loc; prayer.locErr = '';
      return true;
    }
  }
  if (prayer.locBusy) return !!prayer.loc;
  if (!forceFresh && prayer.locFailAt && Date.now() - prayer.locFailAt < 5 * 60000) return !!prayer.loc;   // do not hammer the network
  prayer.locBusy = true;
  let loc = null;
  try { loc = manual ? await prGeocode(cityStr) : await prIpLocation(forceFresh); } catch (_) {}
  prayer.locBusy = false;
  if (loc) {
    prayer.loc = loc; prayer.locErr = ''; prayer.locFailAt = 0;
    try { localStorage.setItem(PR_LOC_KEY, JSON.stringify({ mode: manual ? 'manual' : 'auto', q: q, loc: loc })); } catch (_) {}
    try { localStorage.setItem('inex.loc', JSON.stringify({ loc: loc, at: Date.now() })); } catch (_) {}
    return true;
  }
  prayer.locFailAt = Date.now();
  prayer.locErr = manual ? 'City not found' : 'Location unavailable';
  if (manual && !prayer.loc) {   // typed city failed: try the automatic location so the deck is still useful
    try { const a = await prIpLocation(forceFresh); if (a) prayer.loc = a; } catch (_) {}
  }
  return !!prayer.loc;
}

// ---------------------------------------------------------------- schedule + state
function prEnsureDays() {
  if (!prayer.loc) return null;
  const now = Date.now();
  const ymd = prYMD(prayer.loc.tz, now);
  const key = ymd.y + '-' + ymd.m + '-' + ymd.d + '|' + prayer.sig;
  if (prayer.days && prayer.dayKey === key) return prayer.days;
  const hanafi = prCfg().asrMethod === 'hanafi';
  const t0 = prApplyMasjid(prCalc(prayer.loc, ymd.y, ymd.m, ymd.d, hanafi));
  const t1 = prApplyMasjid(prCalc(prayer.loc, ymd.y, ymd.m, ymd.d + 1, hanafi));
  prayer.dayKey = key;
  prayer.days = (t0 && t1) ? { today: t0, tomorrow: t1 } : null;
  return prayer.days;
}
// what the deck shows right now
function prState(now) {
  const days = prEnsureDays();
  if (!days) return null;
  let view = days.today;
  let next = PR_FIVE.find((k) => days.today[k] > now);
  if (!next) { view = days.tomorrow; next = 'fajr'; }                    // after Isha: tomorrow's list
  const rise = view.sunrise, set = view.maghrib;
  const f = (now - rise) / (set - rise);                                 // 0..1 while the sun is up
  return { view: view, next: next, nextAt: view[next], f: f, day: f >= 0 && f <= 1 };
}
function prFmt(ms) {
  const off = prTzOffset(prayer.loc && prayer.loc.tz, ms);
  const d = new Date(ms + off * 3600000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const mm = String(m).padStart(2, '0');
  if (typeof SET !== 'undefined' && SET.general && SET.general.hour24) return String(h).padStart(2, '0') + ':' + mm;
  return String(((h + 11) % 12) + 1).padStart(2, '0') + ':' + mm + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function prIn(ms) {
  const mins = Math.ceil((ms - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins >= 60) return 'in ' + Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  return 'in ' + mins + 'm';
}

// ---------------------------------------------------------------- deck UI
var PR_ARC = { x0: 22, x1: 195, y0: 54, h: 46 };
function prArcPt(t) { return { x: PR_ARC.x0 + (PR_ARC.x1 - PR_ARC.x0) * t, y: PR_ARC.y0 - 4 * PR_ARC.h * t * (1 - t) }; }
function prSet(id, attrs) { const e = prEl(id); if (e) for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

function prRender() {
  if (!prEl('mx-prayer-body')) return;
  const loc = prEl('pr-loc');
  if (loc) loc.textContent = prayer.loc ? (prayer.loc.city || 'Your location') : (prayer.locErr || 'Locating…');
  const st = prRenderState();
  if (!st) {
    prEl('pr-next-name').textContent = prayer.locErr || '--';
    prEl('pr-next-in').textContent = '';
    prEl('pr-next-sub').textContent = prayer.loc ? 'No times at this latitude' : 'Finding your location';
    prEl('pr-list').innerHTML = '';
    return;
  }
}
function prRenderState() {
  const now = Date.now();
  const st = prState(now);
  if (!st) return null;
  const v = st.view;
  // ---- left card: title + countdown
  prEl('pr-next-name').textContent = PR_NAMES[st.next];
  prEl('pr-next-in').textContent = prIn(st.nextAt);
  prEl('pr-next-sub').textContent = prFmt(st.nextAt) + (v !== prayer.days.today ? ' \u2022 tomorrow' : '');
  // ---- right card: list
  let html = '';
  PR_ORDER.forEach((k) => {
    const cls = k === st.next ? 'next' : (v[k] <= now && v === prayer.days.today ? 'past' : '');
    html += '<div class="pr-row ' + cls + (k === 'sunrise' ? ' minor' : '') + '"><span class="pr-n">' + PR_NAMES[k] +
      '</span>' + (k === st.next ? '<span class="pr-badge">NEXT</span>' : '') + '<span class="pr-t">' + prFmt(v[k]) + '</span></div>';
  });
  prEl('pr-list').innerHTML = html;
  // ---- sun arc
  const span = v.maghrib - v.sunrise;
  const frac = (ms) => (ms - v.sunrise) / span;
  const t = Math.max(0, Math.min(1, st.f));
  const p = prArcPt(t);
  prSet('pr-prog', { 'stroke-dasharray': (st.day ? t * 100 : (st.f > 1 ? 100 : 0)) + ' 100' });
  prSet('pr-halo', { cx: p.x, cy: p.y, display: st.day ? '' : 'none' });
  const dot = prSet('pr-dot', { cx: p.x, cy: p.y });
  if (dot) dot.setAttribute('class', st.day ? 'pr-sun-dot' : 'pr-sun-dot night');
  const mk = [['fajr', -0.075], ['sunrise', 0], ['dhuhr', frac(v.dhuhr)], ['asr', frac(v.asr)], ['maghrib', 1], ['isha', 1.075]];
  let g = '';
  mk.forEach((m) => {
    const q = prArcPt(m[1]);
    const y = (m[1] < 0 || m[1] > 1) ? PR_ARC.y0 : q.y;
    const c = m[0] === st.next ? 'pr-mk next' : (v[m[0]] <= now && v === prayer.days.today ? 'pr-mk past' : 'pr-mk');
    g += '<circle class="' + c + '" cx="' + q.x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (m[0] === st.next ? 3 : 2.2) + '"/>';
  });
  const gm = prEl('pr-marks'); if (gm) gm.innerHTML = g;
  const tl = prEl('pr-t-rise'); if (tl) tl.textContent = prFmt(v.sunrise);
  const tr = prEl('pr-t-set'); if (tr) tr.textContent = prFmt(v.maghrib);
  return st;
}

function prOpenDeck() {
  const deck = prEl('view-control-mac');
  if (!deck || !prOn()) return;
  if (typeof wgOpen !== 'undefined' && wgOpen && typeof wgSetTab === 'function') wgSetTab('controls');
  if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
  if (typeof closeMacSub === 'function') closeMacSub();
  deck.classList.add('prayer-open');
  prEl('mac-prayer-btn')?.classList.add('on');
  prayer.open = true;
  prRender();
  prEnsureLoc().then(() => { if (prayer.open) prRender(); prArm(); });
  clearInterval(prayer.ui);
  prayer.ui = setInterval(() => {                                         // exists ONLY while the deck is open
    if (!prayer.open || appState.currentView !== 'view-control-mac') { prCloseDeck(); return; }
    prRender();
  }, 20000);
}
function prCloseDeck() {
  clearInterval(prayer.ui); prayer.ui = 0;
  prayer.open = false;
  prEl('view-control-mac')?.classList.remove('prayer-open');
  prEl('mac-prayer-btn')?.classList.remove('on');
}
// called from switchView(): the menu always opens on "Controls"
function macPrayerReset() { if (typeof prayer !== 'undefined' && prayer && prayer.open) prCloseDeck(); }

// ---------------------------------------------------------------- Adhan alert (island card + native audio)
function prStopAudio() {
  prayer.audio = null;
  if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
    window.__TAURI__.core.invoke('stop_adhan_native').catch(() => {});
  }
}

function prPlay(soundName, tok, isFallback) {
  prayer.audio = soundName;
  if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
    window.__TAURI__.core.invoke('play_adhan_native', { soundName: soundName || 'madinah' })
      .then((ok) => {
        if (!ok && !isFallback) {
          prPlay('beep', tok, true);
        }
      })
      .catch(() => {
        if (!isFallback) prPlay('beep', tok, true);
      });
  }
}

function prQuiet(q) { prEl('c-alarm-box')?.classList.toggle('pr-quiet', !!q); }
function prMute() {
  prStopAudio();
  prQuiet(true);
  prEl('btn-alarm-snooze')?.classList.add('hidden');
  const tok = prayer.cardTok;
  setTimeout(() => { if (tok === prayer.cardTok && appState.alarmActive && typeof dismissTimerAlarm === 'function') dismissTimerAlarm(); }, 600);
}
// ev: { name, prayerAt, lead (bool), repeat (bool), min (number) }
function prAnnounce(ev, preview) {
  const c = prCfg();
  const snd = c.adhanSound || 'madinah';
  const sound = snd !== 'mute';
  let soundName = 'beep';
  if (!ev.lead && !ev.repeat) {
    if (snd === 'madinah') {
      soundName = (c.fullAdhan === false) ? 'short' : 'madinah';
    } else {
      soundName = snd;
    }
  }
  let title = '\uD83D\uDD4C ' + PR_NAMES[ev.name];
  if (ev.lead) title += ' in ' + (ev.min || '') + ' min';
  else if (ev.repeat) title += ' Reminder (+' + (ev.min || '') + 'm)';
  else title += (c.fullAdhan === false && snd === 'madinah' ? ' Takbeer' : ' Adhan');
  const sub = prFmt(ev.prayerAt);
  const tok = ++prayer.cardTok;

  let cardMs = 12000;
  if (sound) {
    if (ev.lead || ev.repeat) {
      cardMs = 14000;
    } else if (soundName === 'short') {
      cardMs = 46000;
    } else if (soundName === 'beep') {
      cardMs = 14000;
    } else {
      cardMs = preview ? 35000 : 230000;
    }
  }

  if (!appState.alarmActive && typeof triggerTimerAlarm === 'function') {
    triggerTimerAlarm({
      kind: 'prayer', silent: true, title: title, sub: sub,
      snooze: sound, snoozeLabel: 'Mute', snoozeTitle: 'Silence the sound', dismissLabel: 'Dismiss',
      ms: cardMs,
      onSnooze: prMute,
      onDismiss: () => {
        if (tok === prayer.cardTok) {
          prStopAudio();
          prQuiet(false);
        }
      }
    });
    prQuiet(!sound);
  }

  if (sound) {
    prPlay(soundName, tok, false);
    setTimeout(() => {
      if (tok === prayer.cardTok && appState.alarmActive && typeof dismissTimerAlarm === 'function') {
        prStopAudio();
        dismissTimerAlarm();
      }
    }, cardMs);
  }
}
function prFire(ev) {
  prayer.fired = ev.key;
  try { localStorage.setItem(PR_FIRED_KEY, ev.key); } catch (_) {}
  prAnnounce(ev, false);
}

// ONE timeout aimed at the next alert (like clock alarms: off = no timer, 0% CPU). Re-armed after every fire,
// every settings change, location change and after sleep / resume.
function prArm() {
  clearTimeout(prayer.evTimer); prayer.evTimer = 0;
  if (!prOn() || !prayer.loc) return;
  const days = prEnsureDays();
  if (!days) return;
  const lead = (parseInt(prCfg().alertLead, 10) || 0) * 60000;
  const repeat = (parseInt(prCfg().alertRepeat, 10) || 0) * 60000;
  let last = prayer.fired;
  if (!last) { try { last = localStorage.getItem(PR_FIRED_KEY) || ''; } catch (_) {} }
  const now = Date.now();
  const evs = [];
  [days.today, days.tomorrow].forEach((day) => {
    PR_FIVE.forEach((k) => {
      if (lead > 0) evs.push({ name: k, prayerAt: day[k], at: day[k] - lead, lead: true, repeat: false, min: Math.round(lead / 60000), key: day[k] + ':lead' });
      evs.push({ name: k, prayerAt: day[k], at: day[k], lead: false, repeat: false, key: day[k] + ':adhan' });
      if (repeat > 0) evs.push({ name: k, prayerAt: day[k], at: day[k] + repeat, lead: false, repeat: true, min: Math.round(repeat / 60000), key: day[k] + ':repeat' });
    });
  });
  evs.sort((a, b) => a.at - b.at);
  // missed by < 90 s (PC just woke up) still counts; the last fired key is never repeated
  const nextEv = evs.find((e) => e.at >= now - 90000 && e.key !== last && !(e.lead && e.prayerAt <= now));
  if (!nextEv) return;
  const delay = Math.min(2147483000, Math.max(0, nextEv.at - now));
  prayer.evTimer = setTimeout(() => {
    prayer.evTimer = 0;
    if (nextEv.at - Date.now() > 1500 && delay >= 2147483000) { prArm(); return; }   // very long sleep: re-aim
    if (prOn()) prFire(nextEv);
    prArm();
    if (prayer.open) prRender();
  }, delay);
}

// ---------------------------------------------------------------- settings hook (cheap: only acts when something changed)
function prayerApplySettings() {
  if (typeof prayer === 'undefined' || !prayer) return;
  const on = prOn();
  const mac = !!(SET.appearance && SET.appearance.menuLayout === 'mac');
  prEl('mac-prayer-btn')?.classList.toggle('hidden', !(on && mac));
  if (!(on && mac)) prCloseDeck();
  const sig = JSON.stringify(SET.prayer || {});
  if (sig === prayer.sig) return;
  prayer.sig = sig;
  prayer.days = null;
  if (!on) {                                                              // off = zero footprint
    clearTimeout(prayer.evTimer); prayer.evTimer = 0;
    prStopAudio();
    return;
  }
  prayer.locFailAt = 0;
  prEnsureLoc().then(() => { prArm(); if (prayer.open) prRender(); });
}

// ---------------------------------------------------------------- wiring
prEl('mac-prayer-btn')?.addEventListener('click', () => { if (prayer.open) prCloseDeck(); else prOpenDeck(); });
// widgets tab / file tray opened (also by drag-drop): the prayer deck gives way
if (typeof MutationObserver !== 'undefined' && prEl('view-control-mac')) {
  prayerMO = new MutationObserver(() => {
    const cl = prEl('view-control-mac').classList;
    if (prayer.open && (cl.contains('widgets-open') || cl.contains('tray-open'))) prCloseDeck();
  });
  prayerMO.observe(prEl('view-control-mac'), { attributes: true, attributeFilter: ['class'] });
}
onTauriEvent('system-resumed', () => { if (prOn()) { prayer.days = null; prArm(); if (prayer.open) prRender(); } });
// "Preview Adhan Alert" button in Settings (the settings window pokes this key, same pattern as the alarm list)
window.addEventListener('storage', (e) => {
  if (e.key === 'inex.prayer.preview' && prOn()) {
    const st = prState(Date.now());
    prAnnounce({ name: st ? st.next : 'dhuhr', prayerAt: st ? st.nextAt : Date.now(), lead: false }, true);
  }
  if (e.key === 'inex.prayer.refreshLoc' && prOn()) {
    try { localStorage.removeItem(PR_LOC_KEY); } catch (_) {}
    prayer.loc = null; prayer.days = null;
    prEnsureLoc(true).then(() => { prArm(); if (prayer.open) prRender(); });
  }
});
prayerApplySettings();
// ---- Weather deck (Mac Control Deck): click the weather in the top strip -> big weather panel ----
// Same idea as the Prayer deck (20-prayer-deck.js): the panel is built lazily on the first click, fetches its
// details ONLY while open, and its only timer exists ONLY while open. Closed = zero cost, nothing polling.
// Data: Open-Meteo forecast (current + today's sunrise/sunset) and Open-Meteo air-quality (US AQI). No API key.
const wxd = { open: false, built: false, data: null, at: 0, busy: false, tick: 0 };
const WXD_CACHE_KEY = 'inex.wxdeck';

function wxdEl(id) { return document.getElementById(id); }

const WXD_AQI = [
  [50, 'Good', '#3fbf5f'], [100, 'Moderate', '#e8c52f'], [150, 'Unhealthy for some', '#f0892f'],
  [200, 'Unhealthy', '#e0453f'], [300, 'Very unhealthy', '#9a4fc1'], [500, 'Hazardous', '#8f2a45']
];
const WXD_UV = [
  [2, 'Low', '#3fbf5f'], [5, 'Moderate', '#e8c52f'], [7, 'High', '#f0892f'],
  [10, 'Very high', '#e0453f'], [99, 'Extreme', '#9a4fc1']
];
function wxdBand(table, v) {
  for (let i = 0; i < table.length; i++) if (v <= table[i][0]) return { i, label: table[i][1], color: table[i][2] };
  const i = table.length - 1; return { i, label: table[i][1], color: table[i][2] };
}

const WXD_SUNRISE = '<svg viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M3 19h18"/><path d="M7 19a5 5 0 0 1 10 0"/><path d="M12 4v6"/><path d="M9.5 6.5L12 4l2.5 2.5"/></svg>';
const WXD_SUNSET = '<svg viewBox="0 0 24 24" fill="none" stroke="#f26b3a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M3 19h18"/><path d="M7 19a5 5 0 0 1 10 0"/><path d="M12 4v6"/><path d="M9.5 7.5L12 10l2.5-2.5"/></svg>';
const WXD_I = (c, inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
const WXD_ICONS = {
  hum: WXD_I('#4aa3df', '<path d="M12 3c3.5 4.2 6 7.2 6 10.5a6 6 0 0 1-12 0C6 10.2 8.5 7.2 12 3z"/>'),
  wind: WXD_I('#9a9aa6', '<path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/>'),
  uv: WXD_I('#9a9aa6', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>'),
  pres: WXD_I('#9a9aa6', '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-4"/>'),
  vis: WXD_I('#9a9aa6', '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>')
};

function wxdBuild() {
  if (wxd.built) return true;
  const deck = wxdEl('view-control-mac');
  if (!deck) return false;
  const body = document.createElement('div');
  body.id = 'mx-weather-body';
  let segs = ''; WXD_AQI.forEach((b) => { segs += '<i style="background:' + b[2] + '"></i>'; });
  body.innerHTML =
    '<div class="mx-widget-card">' +
      '<div class="wg-head"><b>Weather</b><span id="wxd-place">--</span></div>' +
      '<div class="wxd-main"><span id="wxd-ico"></span><b id="wxd-temp">--</b></div>' +
      '<div class="wxd-cond" id="wxd-cond">--</div>' +
      '<div class="wxd-sub" id="wxd-sub">--</div>' +
      '<div class="wxd-aqi"><small>AQI</small><b id="wxd-aqi">--</b></div>' +
      '<div class="wxd-aqit" id="wxd-aqit"></div>' +
      '<div class="wxd-scale">' + segs + '<u id="wxd-aqi-mark" style="left:0%;display:none"></u></div>' +
    '</div>' +
    '<div class="mx-widget-card">' +
      '<div class="wg-head"><b>Sun</b><span id="wxd-daylen"></span></div>' +
      '<svg id="wxd-arc" viewBox="0 0 200 100" aria-hidden="true">' +
        '<line class="wxd-horizon" x1="8" y1="84" x2="192" y2="84"/>' +
        '<path class="wxd-base" d="M22 84A78 78 0 0 1 178 84" pathLength="100"/>' +
        '<path id="wxd-prog" class="wxd-prog" d="M22 84A78 78 0 0 1 178 84" pathLength="100" stroke-dasharray="0 100"/>' +
        '<circle id="wxd-halo" class="wxd-halo" r="9" cx="22" cy="84" style="display:none"/>' +
        '<circle id="wxd-dot" class="wxd-dot night" r="5" cx="22" cy="84"/>' +
      '</svg>' +
      '<div class="wxd-times">' +
        '<div><small>' + WXD_SUNRISE + 'Sunrise</small><b id="wxd-rise">--</b></div>' +
        '<div><small>Sunset' + WXD_SUNSET + '</small><b id="wxd-set">--</b></div>' +
      '</div>' +
    '</div>' +
    '<div class="mx-widget-card">' +
      '<div class="wg-head"><b>Details</b><span>Today</span></div>' +
      '<div class="wxd-rows">' +
        '<div class="wxd-row">' + WXD_ICONS.hum + '<span>Humidity</span><b id="wxd-hum">--</b></div>' +
        '<div class="wxd-row">' + WXD_ICONS.wind + '<span>Wind</span><b id="wxd-wind">--</b></div>' +
        '<div class="wxd-row" id="wxd-uvrow">' + WXD_ICONS.uv + '<span>UV index</span><b id="wxd-uv">--</b></div>' +
        '<div class="wxd-row">' + WXD_ICONS.pres + '<span>Pressure</span><b id="wxd-pres">--</b></div>' +
        '<div class="wxd-row">' + WXD_ICONS.vis + '<span>Visibility</span><b id="wxd-vis">--</b></div>' +
      '</div>' +
    '</div>';
  deck.appendChild(body);
  wxd.built = true;
  return true;
}

function wxdFmt12(str) {                       // "2026-11-20T16:50" -> "4:50 pm" (the place's own clock)
  if (!str || str.length < 16) return '--';
  let h = parseInt(str.slice(11, 13), 10); const m = str.slice(14, 16);
  if (isNaN(h)) return '--';
  const ap = h >= 12 ? 'pm' : 'am'; h = h % 12; if (h === 0) h = 12;
  return h + ':' + m + ' ' + ap;
}
function wxdLoadCache() {
  if (wxd.data) return;
  try {
    const c = JSON.parse(localStorage.getItem(WXD_CACHE_KEY) || 'null');
    if (c && c.data && typeof c.data === 'object') { wxd.data = c.data; wxd.at = c.at || 0; }
  } catch (_) {}
}

async function wxdFetch(force) {
  if (wxd.busy) return;
  const unit = (typeof SET !== 'undefined' && SET.weather && SET.weather.unit === 'F') ? 'F' : 'C';
  if (!force && wxd.data && wxd.data.unit === unit && Date.now() - wxd.at < 10 * 60 * 1000) return;
  wxd.busy = true;
  try {
    const loc = await detectLocation();
    if (!loc) return;
    const f = unit === 'F';
    const uf = f ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '&wind_speed_unit=kmh';
    const u1 = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,surface_pressure,wind_speed_10m,wind_direction_10m,visibility,uv_index' +
      '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1' + uf;
    const u2 = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + loc.lat + '&longitude=' + loc.lon + '&current=us_aqi&timezone=auto';
    const [r1, r2] = await Promise.allSettled([wxFetch(u1), wxFetch(u2)]);
    let j1 = null, j2 = null;
    try { if (r1.status === 'fulfilled' && r1.value.ok) j1 = await r1.value.json(); } catch (_) {}
    try { if (r2.status === 'fulfilled' && r2.value.ok) j2 = await r2.value.json(); } catch (_) {}
    if (!j1 || !j1.current) return;                 // keep whatever we had
    const c = j1.current, d = j1.daily || {}, off = j1.utc_offset_seconds || 0;
    const riseS = d.sunrise && d.sunrise[0], setS = d.sunset && d.sunset[0];
    const num = (v) => (typeof v === 'number' ? v : null);
    wxd.data = {
      unit, place: loc.city || (typeof weather !== 'undefined' ? weather.place : '') || '',
      temp: num(c.temperature_2m), feels: num(c.apparent_temperature), hum: num(c.relative_humidity_2m),
      code: c.weather_code || 0, isDay: c.is_day === 1, pres: num(c.surface_pressure),
      wind: num(c.wind_speed_10m), wdir: num(c.wind_direction_10m), vis: num(c.visibility), uv: num(c.uv_index),
      hi: d.temperature_2m_max ? num(d.temperature_2m_max[0]) : null, lo: d.temperature_2m_min ? num(d.temperature_2m_min[0]) : null,
      rise: riseS ? Date.parse(riseS + 'Z') - off * 1000 : null, set: setS ? Date.parse(setS + 'Z') - off * 1000 : null,
      riseTxt: wxdFmt12(riseS), setTxt: wxdFmt12(setS),
      aqi: (j2 && j2.current && typeof j2.current.us_aqi === 'number') ? Math.round(j2.current.us_aqi) : null
    };
    wxd.at = Date.now();
    try { localStorage.setItem(WXD_CACHE_KEY, JSON.stringify({ data: wxd.data, at: wxd.at })); } catch (_) {}
  } catch (_) {
  } finally {
    wxd.busy = false;
  }
}

function wxdSet(id, txt) { const e = wxdEl(id); if (e) e.textContent = txt; }

function wxdRenderSun() {
  const v = wxd.data; if (!v || !v.rise || !v.set || v.set <= v.rise) return;
  const t = (Date.now() - v.rise) / (v.set - v.rise);
  const tc = Math.max(0, Math.min(1, t));
  const x = 100 - 78 * Math.cos(Math.PI * tc), y = 84 - 78 * Math.sin(Math.PI * tc);
  const day = t >= 0 && t <= 1;
  const prog = wxdEl('wxd-prog'); if (prog) prog.setAttribute('stroke-dasharray', (t > 1 ? 100 : tc * 100) + ' 100');
  const halo = wxdEl('wxd-halo'); if (halo) { halo.setAttribute('cx', x); halo.setAttribute('cy', y); halo.style.display = day ? '' : 'none'; }
  const dot = wxdEl('wxd-dot'); if (dot) { dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('class', day ? 'wxd-dot' : 'wxd-dot night'); }
}

function wxdRender() {
  if (!wxd.built) return;
  wxdLoadCache();
  const v = wxd.data;
  if (!v) return;
  const deg = (n) => (n === null || n === undefined ? '--' : Math.round(n) + '\u00b0');
  const wmo = (typeof WMO_CODES !== 'undefined' && WMO_CODES[v.code]) || null;
  const ico = wxdEl('wxd-ico'); if (ico && wmo) ico.innerHTML = v.isDay ? wmo.day : wmo.night;
  wxdSet('wxd-place', v.place || '--');
  wxdSet('wxd-temp', deg(v.temp) + (v.temp === null ? '' : v.unit));
  wxdSet('wxd-cond', wmo ? wmo.text : '--');
  wxdSet('wxd-sub', 'Feels ' + deg(v.feels) + '  \u00b7  H ' + deg(v.hi) + '  L ' + deg(v.lo));
  // AQI
  const aqiEl = wxdEl('wxd-aqi'), aqiT = wxdEl('wxd-aqit'), mark = wxdEl('wxd-aqi-mark');
  if (v.aqi === null) {
    if (aqiEl) { aqiEl.textContent = '--'; aqiEl.style.color = ''; }
    if (aqiT) aqiT.textContent = '';
    if (mark) mark.style.display = 'none';
  } else {
    const b = wxdBand(WXD_AQI, v.aqi);
    if (aqiEl) { aqiEl.textContent = v.aqi; aqiEl.style.color = b.color; }
    if (aqiT) { aqiT.textContent = b.label; aqiT.style.color = b.color; }
    const lo = b.i === 0 ? 0 : WXD_AQI[b.i - 1][0] + 1, hi = WXD_AQI[b.i][0];
    const pos = ((b.i + Math.min(1, (v.aqi - lo) / Math.max(1, hi - lo + 1))) / WXD_AQI.length) * 100;
    if (mark) { mark.style.left = pos + '%'; mark.style.display = ''; }
  }
  // sun
  wxdSet('wxd-rise', v.riseTxt); wxdSet('wxd-set', v.setTxt);
  if (v.rise && v.set && v.set > v.rise) {
    const mins = Math.round((v.set - v.rise) / 60000);
    wxdSet('wxd-daylen', Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm');
  }
  wxdRenderSun();
  // details
  const f = v.unit === 'F';
  const hum = wxdEl('wxd-hum'); if (hum) hum.innerHTML = v.hum === null ? '--' : Math.round(v.hum) + '<em>%</em>';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const wd = v.wdir === null ? '' : dirs[Math.round(v.wdir / 45) % 8] + ' ';
  const wind = wxdEl('wxd-wind'); if (wind) wind.innerHTML = v.wind === null ? '--' : wd + Math.round(v.wind) + '<em>' + (f ? 'mph' : 'km/h') + '</em>';
  const uvEl = wxdEl('wxd-uv');
  if (uvEl) {
    if (v.uv === null) { uvEl.textContent = '--'; uvEl.style.color = ''; }
    else { const b = wxdBand(WXD_UV, v.uv); uvEl.innerHTML = Math.round(v.uv) + '<em>' + b.label + '</em>'; uvEl.style.color = b.color; uvEl.querySelector('em').style.color = 'var(--menu-fg-dim)'; }
  }
  const pres = wxdEl('wxd-pres'); if (pres) pres.innerHTML = v.pres === null ? '--' : Math.round(v.pres) + '<em>hPa</em>';
  const vis = wxdEl('wxd-vis');
  if (vis) {
    if (v.vis === null) vis.textContent = '--';
    else { const km = v.vis / 1000; vis.innerHTML = (km >= 10 ? Math.round(km) : km.toFixed(1)) + '<em>km</em>'; }
  }
}

function wxdOpenDeck() {
  const deck = wxdEl('view-control-mac');
  if (!deck || !wxdBuild()) return;
  if (typeof prayer !== 'undefined' && prayer && prayer.open && typeof prCloseDeck === 'function') prCloseDeck();
  if (typeof wgOpen !== 'undefined' && wgOpen && typeof wgSetTab === 'function') wgSetTab('controls');
  if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
  if (typeof closeMacSub === 'function') closeMacSub();
  deck.classList.add('weather-open');
  wxdEl('mac-weather')?.classList.add('on');
  wxd.open = true;
  wxdRender();                                                        // instant: last saved data
  wxdFetch(false).then(() => { if (wxd.open) wxdRender(); });         // then refresh (skipped if < 10 min old)
  clearInterval(wxd.tick);
  wxd.tick = setInterval(() => {                                      // exists ONLY while the deck is open
    if (!wxd.open || appState.currentView !== 'view-control-mac') { wxdCloseDeck(); return; }
    wxdRenderSun();
  }, 30000);
}
function wxdCloseDeck() {
  clearInterval(wxd.tick); wxd.tick = 0;
  wxd.open = false;
  wxdEl('view-control-mac')?.classList.remove('weather-open');
  wxdEl('mac-weather')?.classList.remove('on');
}

wxdEl('mac-weather')?.addEventListener('click', () => { if (wxd.open) wxdCloseDeck(); else wxdOpenDeck(); });

// Only one deck at a time: opening the Prayer deck closes this one; leaving the menu (switchView) closes it too.
if (typeof prOpenDeck === 'function') {
  const wxdPrevOpen = prOpenDeck;
  prOpenDeck = function () { wxdCloseDeck(); return wxdPrevOpen.apply(this, arguments); };
}
if (typeof macPrayerReset === 'function') {
  const wxdPrevReset = macPrayerReset;
  macPrayerReset = function () { wxdCloseDeck(); return wxdPrevReset.apply(this, arguments); };
}
