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

