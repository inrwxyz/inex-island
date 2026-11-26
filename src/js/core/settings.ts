// Core settings interface wrapping shared.ts
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
import type { InexSettings } from '../../types/models.js';

export function loadSettings(): InexSettings {
  return loadSettingsFromDisk();
}

export function saveSettings(next: InexSettings): void {
  saveSettingsToDisk(next);
}

export function onSettings(cb: (settings: InexSettings) => void): void {
  onSettingsFromDisk(cb);
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
