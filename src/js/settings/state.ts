import { DEFAULTS, load, save } from '../../shared.js';
import type { InexSettings } from '../../types/models.js';

export const invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | null> =>
  window.__TAURI__?.core ? window.__TAURI__.core.invoke<T>(cmd, args) : Promise.resolve(null);

export function ensureDefaults(s: unknown): InexSettings {
  const obj: Record<string, unknown> = (s && typeof s === 'object') ? (s as Record<string, unknown>) : {};
  ['general', 'notch', 'appearance', 'widgets', 'weather', 'companion', 'wellness', 'sounds', 'prayer', 'overlays', 'deckMenu', 'menu', 'share'].forEach((k) => {
    if (!obj[k] || typeof obj[k] !== 'object') obj[k] = {};
  });
  const prayer = obj.prayer as Record<string, unknown>;
  if (!prayer.masjid || typeof prayer.masjid !== 'object') {
    prayer.masjid = { fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' };
  }
  return obj as unknown as InexSettings;
}

export let S: InexSettings = ensureDefaults(load());

export function replaceState(next: unknown): InexSettings {
  S = ensureDefaults(next);
  return S;
}

export function reloadState(): InexSettings {
  S = ensureDefaults(load());
  return S;
}

export function resetStateToDefaults(): InexSettings {
  S = ensureDefaults(JSON.parse(JSON.stringify(DEFAULTS)));
  return S;
}

export interface SettingsUIState {
  skinOpen: boolean;
  compEdit: boolean;
  trayOpen: boolean;
  recvOpen: boolean;
  sendOpen: boolean;
  mcOpen: boolean;
  eqOpen: boolean;
  wellEdit: boolean;
  sndEdit: boolean;
  tilesEdit: boolean;
  prayerEdit: boolean;
  mkCustom: Record<string, boolean>;
  [key: string]: boolean | Record<string, boolean>;
}

// UI-only state (not saved): which collapsed blocks are open
export const UI: SettingsUIState = {
  skinOpen: false,
  compEdit: false,
  trayOpen: false,
  recvOpen: false,
  sendOpen: false,
  mcOpen: false,
  eqOpen: false,
  wellEdit: false,
  sndEdit: false,
  tilesEdit: false,
  prayerEdit: false,
  mkCustom: {}
};

export interface CommitHooks {
  onCompanionToggle: (() => void) | null;
  onCommit: (() => void) | null;
}

let hooks: CommitHooks = { onCompanionToggle: null, onCommit: null };
export function registerCommitHooks(next: Partial<CommitHooks>): void {
  hooks = { ...hooks, ...next };
}

export function esc(v: unknown): string {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function getPath<T = unknown>(obj: unknown, path: string, def?: T): T {
  try {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return def as T;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur !== undefined ? (cur as T) : (def as T);
  } catch {
    return def as T;
  }
}

export function setPath(obj: unknown, path: string, val: unknown): void {
  try {
    const parts = path.split('.');
    let cur = obj as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = val;
  } catch { /* ignore */ }
}

export function commit(path: string, val: unknown): void {
  setPath(S, path, val);
  if (path === 'companion.enabled' || path === 'animations.enabled') {
    const compActive = !!(getPath(S, 'animations.enabled', false) && getPath(S, 'companion.enabled', false));
    if (!compActive && getPath(S, 'notch.compactContent') === 'pet') {
      setPath(S, 'notch.compactContent', 'clock');
    }
    if (typeof hooks.onCompanionToggle === 'function') hooks.onCompanionToggle();
  }
  save(S);
  if (typeof hooks.onCommit === 'function') hooks.onCommit();
}
