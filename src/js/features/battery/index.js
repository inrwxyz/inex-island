// Battery Feature
// Handles laptop battery indicators, charging animations, and battery alerts
import { $ } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { listenTauri, invokeTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';

const BOLT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const BATT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/></svg>';

export function renderBattery(stats) {
  if (!stats) return;
  const batTop = $('deck-battery');
  if (!batTop) return;

  const SET = loadSettings();
  const hasBat = stats.battery_pct >= 0;
  const showBat = hasBat && (SET.deckMenu?.showBattery !== false);
  batTop.classList.toggle('hidden', !showBat);

  if (showBat) {
    const pctEl = $('deck-bat-pct');
    if (pctEl) pctEl.textContent = `${stats.battery_pct}%`;
    const lvl = (Math.max(0.08, Math.min(1, stats.battery_pct / 100)) * 13.4).toFixed(1);
    const lvlEl = $('deck-bat-level');
    if (lvlEl) lvlEl.setAttribute('width', lvl);
    const bolt = $('deck-bat-bolt');
    if (bolt) bolt.classList.toggle('hidden', !stats.charging);
    batTop.classList.toggle('charging', !!stats.charging);
    batTop.classList.toggle('low', stats.battery_pct <= 20 && !stats.charging);
  }
}

export function batteryOverlays(stats) {
  if (!stats || !(stats.battery_pct >= 0)) return;
  const SET = loadSettings();
  const g = SET.general || {};

  if (appState.prevCharging !== undefined && stats.charging !== appState.prevCharging && g.chargeToast) {
    const kind = stats.charging ? 'power' : 'power-off';
    invokeTauri('play_status_sound', { kind }).catch(() => {});
    if (stats.charging) {
      bus.emit('hud:show', {
        iconHTML: BOLT_SVG,
        battery: true,
        plain: true,
        accent: 'green',
        name: 'Charging',
        tag: `${stats.battery_pct}% • Power`,
        pct: stats.battery_pct,
        ms: 3200
      });
    } else {
      bus.emit('hud:show', {
        iconHTML: BATT_SVG,
        battery: true,
        plain: true,
        name: 'On Battery',
        tag: `${stats.battery_pct}% Remaining`,
        pct: stats.battery_pct,
        ms: 2400
      });
    }
  }
  appState.prevCharging = stats.charging;

  if (g.lowBatteryAlert && stats.battery_pct <= (g.lowBattery || 20) && !stats.charging) {
    if (!appState.lowBatteryAlerted) {
      appState.lowBatteryAlerted = true;
      invokeTauri('play_status_sound', { kind: 'low-battery' }).catch(() => {});
      bus.emit('hud:show', {
        iconHTML: BATT_SVG,
        battery: true,
        plain: true,
        accent: 'red',
        name: 'Battery Low',
        tag: `${stats.battery_pct}% Remaining`,
        pct: stats.battery_pct,
        ms: 4000
      });
    }
  } else if (stats.battery_pct > (g.lowBattery || 20) || stats.charging) {
    appState.lowBatteryAlerted = false;
  }
}

export function initBattery() {
  listenTauri('battery-changed', (event) => {
    const data = (event && event.payload !== undefined) ? event.payload : (event || {});
    if (appState.stats && data) {
      appState.stats.battery_pct = data.battery_pct;
      appState.stats.charging = data.charging;
      renderBattery(appState.stats);
      batteryOverlays(appState.stats);
      bus.emit('battery:change', appState.stats);
    }
  });

  bus.on('stats:change', (stats) => {
    renderBattery(stats);
    batteryOverlays(stats);
  });
}
