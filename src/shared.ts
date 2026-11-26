// Settings store shared by the island window and the settings window.
// Saved in localStorage (same origin for both windows) and broadcast through Tauri.
import type { ActionTileDef, AlarmItem, InexSettings } from './types/models.js';

export const KEY = 'inex.settings.v1';

export const DEFAULTS: InexSettings = {
  general: { launchAtLogin: true, hour24: false, autoUpdate: false, lowBatteryAlert: false, lowBattery: 20, chargeToast: false, lockToast: true, copyToast: false, settingsTheme: 'system' },
  appearance: {
    menuLayout: 'deck',
    notchColor: '#030305', notchOpacity: 100, notchBorderColor: '#000000', notchBorderOpacity: 0, cornerRadius: 8,
    menuStyle: 'color',
    themeStyle: 'default',
    borderColor: '#000000', borderOpacity: 0,
    fontStyle: 'mono', scale: 125, animations: true
  },
  notch: {
    mode: 'smart', style: 'curved', compactContent: 'clock', musicMode: true, compactMode: true, mediaCard: 'glass', ambientGlow: true, compactGlow: true,
    calendarTimer: true, timerSound: true, eqSync: true, eqStyle: 'bottom', eqSensitivity: 100
  },
  sounds: {
    enabled: true,
    power: true,
    bluetooth: true,
    transfer: true,
    lock: true
  },
  deckMenu: {
    showClock: true,
    showWeather: true,
    showStats: true,
    showBattery: true,
    statsMode: 'sys',
    widgetsEnabled: true,
    market1: 'BTC-USD',
    market2: '^NSEI'
  },
  weather: { enabled: true, unit: 'C', city: '', lat: null, lon: null, alerts: true },
  prayer: { enabled: false, city: '', asrMethod: 'standard', masjidOverride: false,
    masjid: { fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' }, adhanSound: 'madinah', fullAdhan: true, alertLead: '0', alertRepeat: '0' },
  widgets: { enabled: true, left: 'weather', right: 'ram' },
  menu: {
    actionTiles: ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings']
  },
  overlays: { btBattery: true, privacyDot: true },
  companion: { enabled: false, skin: 'eyes', monogram: false, tracking: true, peekMinMin: 25, peekMaxMin: 60, activityPeekMin: 45 },
  wellness: { enabled: false, water: true, waterEvery: 45, eye: true, eyeEvery: 20, stretch: true, stretchEvery: 60, idleReset: 30 },
  share: { deviceName: '' },
  animations: {
    enabled: false,
    tray: { enabled: false, id: 'bounce' },
    receive: { enabled: false, id: 'radar' },
    send: { enabled: false, id: 'beam' }
  }
};

export const MAX_ACTION_TILES = 7;   // the classic menu row fits 7 circles; more would be cut off
export const DEFAULT_ACTION_TILES = ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings'];

export const ALL_ACTION_TILES: Record<string, ActionTileDef> = {
  awake: { id: 'awake', label: 'Keep Awake', desc: 'Prevent PC from sleeping', icon: 'sun' },
  mic: { id: 'mic', label: 'Microphone Mute', desc: 'Mute/unmute microphone', icon: 'mic' },
  snip: { id: 'snip', label: 'Snip Tool', desc: 'Screenshot crop tool (Win+Shift+S)', icon: 'snip' },
  calendar: { id: 'calendar', label: 'Calendar', desc: 'Monthly calendar view', icon: 'calendar' },
  timer: { id: 'timer', label: 'Focus Timer', desc: 'Productivity split timer', icon: 'clock' },
  clipboard: { id: 'clipboard', label: 'Clipboard', desc: 'Recent copied snippets & history', icon: 'clipboard' },
  lock: { id: 'lock', label: 'Lock PC', desc: 'Instantly lock Windows session', icon: 'lock' },
  settings: { id: 'settings', label: 'Settings', desc: 'Open Inex Island settings', icon: 'gear' },
  calc: { id: 'calc', label: 'Calculator', desc: 'Windows Calculator tool', icon: 'calc' },
  restart: { id: 'restart', label: 'Restart Island', desc: 'Restart Inex Island engine', icon: 'refresh' },
  notepad: { id: 'notepad', label: 'Quick Notes', desc: 'Floating note editor', icon: 'clipboard' }
};

const FONT_MAP: Record<string, string> = {
  jakarta: "'Plus Jakarta Sans', sans-serif",
  inter: "'Inter', sans-serif",
  poppins: "'Poppins', sans-serif",
  outfit: "'Outfit', sans-serif",
  space: "'Space Grotesk', sans-serif",
  montserrat: "'Montserrat', sans-serif",
  lexend: "'Lexend', sans-serif",
  syne: "'Syne', sans-serif",
  raleway: "'Raleway', sans-serif",
  system: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  matrix: "'Doto', 'Space Mono', monospace",
  spacemono: "'Space Mono', monospace",
  grotesk: "'Space Grotesk', sans-serif"
};

// "24.2741, 87.8230" or "24.2741, 87.8230, West Bengal" -> { lat, lon }; null when the text is not a coordinate pair.
export function parseCoords(text: string): { lat: number; lon: number } | null {
  const m = /^\s*([+-]?\d{1,2}(?:\.\d+)?)\s*°?\s*[,;\s]\s*([+-]?\d{1,3}(?:\.\d+)?)\s*°?(?:\s*,\s*[^0-9\n]+)?\s*$/.exec(String(text || ''));
  if (!m) return null;
  const lat = +m[1];
  const lon = +m[2];
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null;
  return { lat, lon };
}

// Name of the place at a coordinate (village / town / city), or null when it can not be found.
export async function reverseGeoName(lat: number, lon: number): Promise<{ name: string; cc: string } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 7000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&accept-language=en&lat=${lat}&lon=${lon}`, { signal: ctl.signal });
    if (!res.ok) return null;
    const d = await res.json();
    const a = (d && d.address) || {};
    const name = a.village || a.hamlet || a.suburb || a.neighbourhood || a.town || a.city || a.municipality ||
      a.city_district || a.county || a.state_district || a.state || (d && d.name) || '';
    return name ? { name, cc: String(a.country_code || '').toUpperCase() } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base: Record<string, unknown>, extra: Record<string, unknown> | null | undefined): Record<string, unknown> {
  for (const k of Object.keys(extra || {})) {
    const ex = extra?.[k];
    const b = base[k];
    if (isObj(b) && isObj(ex)) merge(b, ex);
    else if (k in base) base[k] = ex;
  }
  return base;
}

export function load(): InexSettings {
  const base = JSON.parse(JSON.stringify(DEFAULTS)) as InexSettings;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, unknown> | null;
      merge(base as unknown as Record<string, unknown>, saved);
      const sn = saved && isObj(saved.notch) ? saved.notch : null;
      if (sn && 'curvedEars' in sn && sn.style !== 'floating') {
        base.notch.style = sn.curvedEars === false ? 'attached' : 'curved';
      }
      if (base.appearance && (base.appearance.menuLayout as string) === 'mac') {
        base.appearance.menuLayout = 'deck';
      }
      if (base.appearance && base.appearance.themeStyle === 'matrix') {
        base.appearance.themeStyle = 'default';
      }
      if (saved && isObj(saved.macMenu)) {
        if (!saved.deckMenu) {
          base.deckMenu = { ...base.deckMenu, ...saved.macMenu } as InexSettings['deckMenu'];
        }
      }
      if (base.animations && base.animations.receive && !['radar', 'notch'].includes(base.animations.receive.id)) {
        base.animations.receive.id = 'radar';
      }
    }
    delete base.macMenu;
    delete base.notch.curvedEars;
    if (!base.menu) base.menu = { actionTiles: [...DEFAULT_ACTION_TILES] };
    if (!Array.isArray(base.menu.actionTiles) || base.menu.actionTiles.length === 0) {
      base.menu.actionTiles = [...DEFAULT_ACTION_TILES];
    }
    base.menu.actionTiles = base.menu.actionTiles.filter((id) => ALL_ACTION_TILES[id]);
    if (base.menu.actionTiles.length === 0) {
      base.menu.actionTiles = [...DEFAULT_ACTION_TILES];
    }
    if (base.menu.actionTiles.length > MAX_ACTION_TILES) {
      const withoutNotes = base.menu.actionTiles.filter((id) => id !== 'notepad');
      base.menu.actionTiles = (withoutNotes.length >= MAX_ACTION_TILES ? withoutNotes : base.menu.actionTiles).slice(0, MAX_ACTION_TILES);
    }
    if (!base.share.deviceName) base.share.deviceName = localStorage.getItem('island_pc_name') || '';
    if (base.share) delete base.share.firebaseUrl;
    localStorage.removeItem('island_firebase_url');
  } catch { /* storage blocked: defaults */ }
  return base;
}

export function save(settings: InexSettings): void {
  const json = JSON.stringify(settings);
  try {
    localStorage.setItem(KEY, json);
    if (settings.share.deviceName) localStorage.setItem('island_pc_name', settings.share.deviceName);
  } catch { /* ignore */ }
  try { window.__TAURI__?.core?.invoke('settings_changed', { json }); } catch { /* ignore */ }
}

export function subscribe(cb: (settings: InexSettings) => void): void {
  window.addEventListener('storage', (e) => { if (e.key === KEY) cb(load()); });
  const register = (): void => {
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
      window.__TAURI__.event.listen('settings-changed', (e) => {
        try {
          if (e && e.payload) {
            const raw = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload);
            localStorage.setItem(KEY, raw);
          }
        } catch { /* ignore */ }
        cb(load());
      });
    } else {
      setTimeout(register, 100);
    }
  };
  register();
}

export const ALARM_KEY = 'inex.alarms.v1';
export const MAX_ALARMS = 12;

export function loadAlarms(): AlarmItem[] {
  try {
    const a = JSON.parse(localStorage.getItem(ALARM_KEY) || '[]');
    if (Array.isArray(a)) {
      return a
        .filter((x) => x && Number.isInteger(x.h) && Number.isInteger(x.m) && x.h >= 0 && x.h < 24 && x.m >= 0 && x.m < 60)
        .map((x) => ({ id: String(x.id || Date.now().toString(36)), h: x.h as number, m: x.m as number, on: !!x.on, daily: !!x.daily }));
    }
  } catch { /* ignore */ }
  return [];
}

export function storeAlarms(list: AlarmItem[]): void {
  try { localStorage.setItem(ALARM_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function subscribeAlarms(cb: (list: AlarmItem[]) => void): void {
  window.addEventListener('storage', (e) => { if (e.key === ALARM_KEY || e.key === null) cb(loadAlarms()); });
}

export function hexToRgb(hex: string | null | undefined): [number, number, number] {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function isLightRgb(r: number, g: number, b: number): boolean {
  return (r * 299 + g * 587 + b * 114) / 1000 > 155;
}

export function menuSurface(a: InexSettings['appearance']): { style: string; color: string; opacity: number } {
  return { style: a.menuStyle, color: a.notchColor, opacity: a.notchOpacity };
}

export function applyTheme(s: InexSettings): void {
  const root = document.documentElement.style;
  const a = s.appearance;
  const [nr, ng, nb] = hexToRgb(a.notchColor);
  const ms = menuSurface(a);
  const [mr, mg, mb] = hexToRgb(ms.color);

  root.setProperty('--notch-line', 'transparent');

  const notchLight = isLightRgb(nr, ng, nb) && a.notchOpacity > 45;
  const menuLight = ms.style === 'color' && isLightRgb(mr, mg, mb) && ms.opacity > 45;

  root.setProperty('--font-main', FONT_MAP[a.fontStyle] || FONT_MAP.jakarta);
  root.setProperty('--notch-bg', `rgba(${nr}, ${ng}, ${nb}, ${a.notchOpacity / 100})`);
  root.setProperty('--ear-overlap', a.notchOpacity >= 98 ? '1px' : '0px');
  root.setProperty('--notch-fg', notchLight ? '#050507' : '#f5f5f7');
  root.setProperty('--notch-fg-dim', notchLight ? 'rgba(5, 5, 7, 0.62)' : '#8e8e98');
  root.setProperty('--notch-fg-rgb', notchLight ? '5, 5, 7' : '245, 245, 247');
  document.documentElement.dataset.notchTone = notchLight ? 'light' : 'dark';

  root.setProperty('--menu-bg', `rgba(${mr}, ${mg}, ${mb}, ${ms.opacity / 100})`);
  root.setProperty('--menu-fg', menuLight ? '#050507' : '#f5f5f7');
  root.setProperty('--menu-fg-dim', menuLight ? 'rgba(5, 5, 7, 0.58)' : '#8e8e98');

  root.setProperty('--color-tile-bg', menuLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.07)');
  root.setProperty('--color-tile-border', menuLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)');
  root.setProperty('--color-tile-on-bg', menuLight ? '#050507' : '#f5f5f7');
  root.setProperty('--color-tile-on-fg', menuLight ? '#ffffff' : '#050507');

  const menuBgRgb: [number, number, number] = ms.style === 'color' ? [mr, mg, mb] : [14, 14, 20];
  const menuBgLight = isLightRgb(menuBgRgb[0], menuBgRgb[1], menuBgRgb[2]) && (ms.style !== 'color' || ms.opacity > 45);
  root.setProperty('--on', menuBgLight ? '5, 5, 7' : '245, 245, 247');

  root.setProperty('--deck-accent', menuBgLight ? '#111114' : '#f5f5f7');
  root.setProperty('--deck-accent-fg', menuBgLight ? '#ffffff' : '#050507');
  root.setProperty('--deck-accent-text', 'var(--menu-fg)');
  root.setProperty('--line', 'transparent');

  const NOTCH_RADIUS = 8;
  root.setProperty('--radius', NOTCH_RADIUS + 'px');
  root.setProperty('--radius-menu', Math.round(NOTCH_RADIUS * 1.15) + 'px');
}
