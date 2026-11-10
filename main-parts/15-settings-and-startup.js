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
      const small = { width: ISLAND_WIN_W, height: isFloating ? 48 : 36 };
      invokeTauri('resize_island', typeof compactWindowSize === 'function' ? compactWindowSize(small) : small);
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

// ---- Intro animation: island is immediately visible without delay ----
(function introAnimation() {
  island.classList.remove('intro-pre', 'intro-play');
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
