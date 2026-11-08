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
  switchView('view-control', 'state-control', 316, 256);
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

