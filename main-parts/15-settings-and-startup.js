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
