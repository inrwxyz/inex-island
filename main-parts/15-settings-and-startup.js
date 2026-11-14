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
