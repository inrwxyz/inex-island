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
    openControlMenu();
  });
}
document.getElementById('c-center-trigger')?.addEventListener('click', (e) => {
  if (e.target.closest('#c-incoming-alert')) return;
  if (island.classList.contains('alarm-active')) {
    if (typeof dismissTimerAlarm === 'function') dismissTimerAlarm();
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
