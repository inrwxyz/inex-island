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

