import { DEFAULTS, load, save } from '../../shared.js';

export const invoke = (cmd, args) =>
  window.__TAURI__?.core ? window.__TAURI__.core.invoke(cmd, args) : Promise.resolve(null);

export function ensureDefaults(s) {
  if (!s || typeof s !== 'object') s = {};
  ['general', 'notch', 'appearance', 'widgets', 'weather', 'companion', 'wellness', 'sounds', 'prayer', 'overlays', 'deckMenu', 'menu', 'share'].forEach((k) => {
    if (!s[k] || typeof s[k] !== 'object') s[k] = {};
  });
  if (!s.prayer.masjid || typeof s.prayer.masjid !== 'object') {
    s.prayer.masjid = { fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' };
  }
  return s;
}

export let S = ensureDefaults(load());

export function replaceState(next) {
  S = ensureDefaults(next);
  return S;
}

export function reloadState() {
  S = ensureDefaults(load());
  return S;
}

export function resetStateToDefaults() {
  S = ensureDefaults(JSON.parse(JSON.stringify(DEFAULTS)));
  return S;
}

// UI-only state (not saved): which collapsed blocks are open
export const UI = {
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

let hooks = { onCompanionToggle: null, onCommit: null };
export function registerCommitHooks(next) {
  hooks = { ...hooks, ...next };
}

export function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function getPath(obj, path, def) {
  try {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return def;
      cur = cur[p];
    }
    return cur !== undefined ? cur : def;
  } catch (_) {
    return def;
  }
}

export function setPath(obj, path, val) {
  try {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = val;
  } catch (_) {}
}

export function commit(path, val) {
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
