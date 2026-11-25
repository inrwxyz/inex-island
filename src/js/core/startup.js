// App Startup, Live Settings Sync, Weather Timer & Pixel Snap Core Module
import { appState } from './state.js';
import { invokeTauri } from './tauri.js';
import { KEY, loadSettings, saveSettings, onSettings, applyTheme, menuSurface } from './settings.js';
import { island } from './dom.js';
import { reportIslandSize, ISLAND_WIN_W, isMenuView } from './views.js';
import { compactIslandSize, hudRestoreSize } from '../features/bluetooth/index.js';
import { applyScreenTimeSetting } from '../features/widgets/index.js';
import { prayerApplySettings } from '../features/prayer/index.js';
import {
  applySlots,
  applyDeckMenuConfig,
  openControlMenu,
  syncCompactCycleTimer
} from '../features/menu/index.js';
import { isDeckLayout, renderQuickActionTiles } from '../features/controls/index.js';
import { updateClocks } from '../features/clock/index.js';
import {
  renderWidgets,
  weather,
  weatherWanted,
  refreshWeather
} from '../features/weather/index.js';
import { syncLoadTimer } from './system.js';
import { applyPrivacy } from '../features/privacy-dot/index.js';
import { syncEq } from '../features/equalizer/index.js';
import { refreshMedia } from '../features/media/index.js';
import { showToast } from '../features/toasts-locker/index.js';
import { renderCenter } from '../features/file-transfer/index.js';

let _lastSettingsWinSig = '';
let _lastHeavySig = null;
let _applyRaf = 0;

let weatherTimer = null;
let weatherFails = 0;

let bioTimer = null;
let bioAnimPhaseTimer = null;
let bioStartTimer = null;
let bioEndTimer = null;

export const FAST_APPEARANCE_KEYS = [
  'scale', 'notchColor', 'notchOpacity', 'cornerRadius', 'borderColor', 'borderOpacity',
  'notchBorderColor', 'notchBorderOpacity', 'fontStyle', 'menuStyle'
];

export function heavySettingsSig() {
  const SET = loadSettings();
  const ap = { ...SET.appearance };
  FAST_APPEARANCE_KEYS.forEach((k) => delete ap[k]);
  return JSON.stringify({ ...SET, appearance: ap });
}

export function computeIslandSize() {
  const SET = loadSettings();
  const isFloating = SET.notch && SET.notch.style === 'floating';
  if (appState.currentView === 'view-compact' || !appState.currentView) {
    const small = { width: ISLAND_WIN_W, height: isFloating ? 48 : 36 };
    return compactIslandSize(small);
  }
  if (appState.islandSize) return { width: appState.islandSize.width, height: appState.islandSize.height };
  return null;
}

export function syncIslandHit(targetZoom) {
  const targetWin = computeIslandSize();
  if (!targetWin) return;
  const sig = `${targetWin.width}x${targetWin.height}@${targetZoom}`;
  if (sig === _lastSettingsWinSig) return;
  _lastSettingsWinSig = sig;
  reportIslandSize(targetWin);
}

export function applySettings() {
  if (!island) return;
  const SET = loadSettings();
  applyTheme(SET);
  applyScreenTimeSetting();
  prayerApplySettings();
  island.dataset.menu = menuSurface(SET.appearance).style;
  const validTheme = 'default'; // legacy 'matrix' theme was removed; saved values fall back to default
  island.dataset.theme = validTheme;
  island.setAttribute('data-mode', SET.notch.mode);
  island.setAttribute('data-style', SET.notch.style || 'attached');
  island.setAttribute('data-eq-style', SET.notch?.eqStyle === 'center' ? 'center' : 'bottom');
  island.setAttribute('data-theme', validTheme);
  const curvedEars = SET.notch && SET.notch.style === 'curved';
  island.classList.toggle('has-curved-ears', !!curvedEars);
  if (SET.notch.mode !== 'smart') island.classList.remove('smart-hidden');

  const scale = (SET.appearance && SET.appearance.scale) ? SET.appearance.scale : 125;
  const notchZoom = scale / 100;
  const targetZoom = isMenuView(appState.currentView) ? 1.10 : notchZoom;
  island.style.zoom = targetZoom;
  island.classList.toggle('no-anim', SET.appearance.animations === false);

  const heavySig = heavySettingsSig();
  const lookOnly = _lastHeavySig !== null && heavySig === _lastHeavySig;
  _lastHeavySig = heavySig;
  if (lookOnly && appState.currentView !== 'view-control' && appState.currentView !== 'view-control-deck') {
    syncIslandHit(targetZoom);
    return;
  }

  applySlots();
  applyDeckMenuConfig();

  const wantDeckMenu = isDeckLayout();
  if ((wantDeckMenu && appState.currentView === 'view-control') || (!wantDeckMenu && appState.currentView === 'view-control-deck')) {
    openControlMenu();
  } else {
    syncIslandHit(targetZoom);
  }
  renderQuickActionTiles();

  const vMedia = document.getElementById('view-media');
  if (vMedia) vMedia.classList.toggle('no-ambient', !SET.notch.ambientGlow);
  const cMediaBtn = document.getElementById('c-media-btn');
  if (cMediaBtn) cMediaBtn.classList.toggle('glow', SET.notch.compactGlow);

  updateClocks();
  syncCompactCycleTimer();
  renderWidgets();
  syncLoadTimer();
  applyPrivacy();
  syncWeatherTimer();
  refreshWeather();
  syncEq();
  refreshMedia();
}

export function scheduleApplySettings() {
  if (_applyRaf) return;
  _applyRaf = requestAnimationFrame(() => {
    _applyRaf = 0;
    applySettings();
  });
}

export function nextWeatherDelay() {
  if (weather.text) {
    weatherFails = 0;
    return 12 * 60 * 1000;
  }
  weatherFails = Math.min((weatherFails || 0) + 1, 6);
  return Math.min(15 * 60 * 1000, 2 * 60 * 1000 * Math.pow(2, weatherFails - 1));
}

export function scheduleWeather(ms) {
  clearTimeout(weatherTimer);
  weatherTimer = setTimeout(async () => {
    weatherTimer = null;
    if (!weatherWanted()) return;
    if (!document.hidden) await refreshWeather();
    scheduleWeather(nextWeatherDelay());
  }, ms);
}

export function syncWeatherTimer() {
  if (weatherWanted()) {
    if (!weatherTimer) scheduleWeather(12 * 60 * 1000);
  } else {
    clearTimeout(weatherTimer);
    weatherTimer = null;
    weatherFails = 0;
  }
}

const WELCOME_KEY = 'inex.welcome.done';

export function welcomeShouldRun() {
  try {
    return localStorage.getItem(WELCOME_KEY) !== '1';
  } catch {
    return false;
  }
}

export function welcomeRun(done) {
  const box = document.getElementById('c-biometric-box');
  const glyph = document.getElementById('bio-glyph-wrap');
  const txt = document.getElementById('bio-label');
  if (!box || !glyph || !txt || !island) {
    done();
    return;
  }
  clearTimeout(bioTimer);
  clearTimeout(bioAnimPhaseTimer);
  clearTimeout(bioStartTimer);
  clearTimeout(bioEndTimer);
  txt.textContent = '';

  island.classList.add('bio-hud', 'welcome-hud', 'biometric-active');
  box.classList.add('hidden');
  Promise.resolve(reportIslandSize({ width: ISLAND_WIN_W, height: 112 }))
    .catch((err) => console.warn('[startup] reportIslandSize err:', err))
    .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    .then(() => new Promise((r) => setTimeout(r, 160)))
    .then(() => {
      try {
        localStorage.setItem(WELCOME_KEY, '1');
      } catch (err) {
        console.warn('[startup] localStorage err:', err);
      }
      glyph.innerHTML = '<span class="welcome-text">Welcome</span>';
      box.classList.remove('hidden');
      island.classList.remove('intro-pre');
      void island.offsetWidth;
      island.classList.add('intro-play');
      setTimeout(() => island.classList.remove('intro-play'), 900);

      bioTimer = setTimeout(() => {
        const w = glyph.querySelector('.welcome-text');
        if (w) w.classList.add('welcome-leave');
        bioEndTimer = setTimeout(() => {
          island.classList.remove('biometric-active', 'welcome-hud');
          island.classList.add('hud-back');
          setTimeout(() => {
            box.classList.add('hidden');
            glyph.innerHTML = '';
            island.classList.remove('hud-back', 'bio-hud');
            hudRestoreSize();
            renderCenter();
            updateClocks();
            refreshMedia();
            done();
          }, 560);
        }, 650);
      }, 3200);
    })
    .catch(() => {
      island.classList.remove('bio-hud', 'welcome-hud', 'biometric-active');
      done();
    });
}

export function introAnimation() {
  if (!island) return;
  let started = false;
  const play = () => {
    if (started) return;
    started = true;
    if (welcomeShouldRun()) {
      let fin = false;
      const finish = () => {
        if (fin) return;
        fin = true;
        island.classList.remove('intro-pre');
      };
      try {
        welcomeRun(finish);
        return;
      } catch {
        finish();
      }
    }
    island.classList.remove('intro-pre');
    void island.offsetWidth;
    island.classList.add('intro-play');
    setTimeout(() => island.classList.remove('intro-play'), 900);
  };
  island.classList.add('intro-pre');
  setTimeout(play, 1500);
  (async () => {
    try {
      const SET = loadSettings();
      const h = (SET.notch && SET.notch.style === 'floating') ? 48 : 36;
      await reportIslandSize({ width: ISLAND_WIN_W, height: h });
    } catch (err) {
      console.warn('[startup] intro reportIslandSize err:', err);
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 160));
    play();
  })();
}

export function checkAutoUpdate() {
  setTimeout(async () => {
    const SET = loadSettings();
    if (!SET.general?.autoUpdate) return;
    try {
      const res = await invokeTauri('check_update');
      if (!(res && res.available && res.latest_version)) return;
      if (appState.transferring || appState.prompting || appState.lockerPrompting) return;
      showToast('spark', `Updating to v${res.latest_version}...`, 4000);
      const ok = await invokeTauri('apply_update');
      if (ok) {
        showToast('spark', 'Update installed. Restarting...', 2500);
        setTimeout(() => invokeTauri('restart_app'), 2500);
      }
    } catch (e) {
      console.warn('[startup] auto update failed:', e);
    }
  }, 25000);
}

export function pixelSnap() {
  if (!island) return;
  const snap = () => {
    if (typeof appState !== 'undefined' && appState.currentView !== 'view-compact') {
      island.style.left = '0px';
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const zoom = parseFloat(island.style.zoom) || 1;
    island.style.left = '0px';
    const r = island.getBoundingClientRect();
    const d = Math.round(r.left * dpr) / dpr - r.left;
    if (Math.abs(d) > 0.001) island.style.left = `${d / zoom}px`;
  };
  let snapT = 0;
  const snapLater = () => {
    clearTimeout(snapT);
    snapT = setTimeout(snap, 550);
  };
  if (typeof window.ResizeObserver === 'function') new window.ResizeObserver(snapLater).observe(island);
  window.addEventListener('resize', snap);
  snap();
}

export function initStartup() {
  window.applySettings = applySettings;
  window.scheduleApplySettings = scheduleApplySettings;
  window.syncWeatherTimer = syncWeatherTimer;
  window.pixelSnap = pixelSnap;

  onSettings(() => {
    scheduleApplySettings();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && weatherWanted()) refreshWeather();
  });

  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    if (t?.closest && t.closest('input:not([type="range"]):not([type="checkbox"]), textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });

  // First launch ever (nothing saved yet): the defaults are written down once, and "Launch at login" (on by default)
  // is registered with Windows right away instead of waiting for someone to flip the switch.
  try {
    if (localStorage.getItem(KEY) === null) {
      const first = loadSettings();
      saveSettings(first);
      if (first.general && first.general.launchAtLogin) invokeTauri('set_autostart', { on: true }).catch(() => {});
    }
  } catch (_) { /* storage blocked: nothing to remember */ }

  applySettings();
  syncWeatherTimer();
  introAnimation();
  pixelSnap();
  checkAutoUpdate();
}
