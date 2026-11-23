// Core settings interface, wrapping shared.js with in-memory caching
import {
  KEY,
  DEFAULTS,
  load as loadSettingsFromDisk,
  save as saveSettingsToDisk,
  subscribe as onSettingsFromDisk,
  applyTheme,
  menuSurface,
  ALARM_KEY,
  loadAlarms,
  subscribeAlarms
} from '../../shared.js';

let cachedSettings = null;

export function loadSettings() {
  return loadSettingsFromDisk();
}

export function saveSettings(next) {
  cachedSettings = next;
  return saveSettingsToDisk(next);
}

export function onSettings(cb) {
  return onSettingsFromDisk((next) => {
    cachedSettings = next;
    cb(next);
  });
}

export {
  KEY,
  DEFAULTS,
  applyTheme,
  menuSurface,
  ALARM_KEY,
  loadAlarms,
  subscribeAlarms
};
