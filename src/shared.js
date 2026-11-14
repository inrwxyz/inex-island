// Settings store shared by the island window and the settings window.
// Saved in localStorage (same origin for both windows) and broadcast through Tauri.

export const KEY = 'inex.settings.v1';

export const DEFAULTS = {
  general: { launchAtLogin: false, hour24: false, autoUpdate: false, lowBatteryAlert: true, lowBattery: 20, chargeToast: true, lockToast: true, copyToast: false, settingsTheme: 'system' },
  appearance: {
    menuLayout: 'classic',
    notchColor: '#030305', notchOpacity: 100, notchBorderColor: '#000000', notchBorderOpacity: 0, cornerRadius: 9,
    menuStyle: 'color',
    themeStyle: 'default',
    borderColor: '#000000', borderOpacity: 0,
    fontStyle: 'mono', scale: 110, animations: true
  },
  notch: {
    mode: 'smart', style: 'attached', macEars: true, compactContent: 'clock', musicMode: true, compactMode: true, ambientGlow: true, compactGlow: true,
    calendarTimer: true, timerSound: true, eqSync: true, eqSensitivity: 100
  },
  sounds: {
    enabled: true,
    power: true,
    bluetooth: true,
    transfer: true,
    lock: true
  },
  macMenu: {
    showClock: true,
    showWeather: true,
    showStats: true,
    showMedia: true,
    showSliders: true,
    showBattery: true,
    statsMode: 'sys'
  },
  weather: { enabled: true, unit: 'C', city: '' },
  widgets: { enabled: true, left: 'weather', right: 'ram' },
  slots: { a: 'bt', b: 'wifi', c: 'drop', d: 'tray' },
  menu: {
    actionTiles: ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings']
  },
  overlays: { btBattery: true, privacyDot: true },
  share: { deviceName: '' }
};

export const MAX_ACTION_TILES = 7;   // the classic menu row fits 7 circles; more would be cut off
export const DEFAULT_ACTION_TILES = ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings'];

export const ALL_ACTION_TILES = {
  awake: { id: 'awake', label: 'Keep Awake', desc: 'Prevent PC from sleeping', icon: 'sun' },
  snip: { id: 'snip', label: 'Snip Tool', desc: 'Screenshot crop tool (Win+Shift+S)', icon: 'snip' },
  calendar: { id: 'calendar', label: 'Calendar', desc: 'Monthly calendar view', icon: 'calendar' },
  timer: { id: 'timer', label: 'Focus Timer', desc: 'Productivity split timer', icon: 'clock' },
  clipboard: { id: 'clipboard', label: 'Clipboard', desc: 'Recent copied snippets & history', icon: 'clipboard' },
  lock: { id: 'lock', label: 'Lock PC', desc: 'Instantly lock Windows session', icon: 'lock' },
  settings: { id: 'settings', label: 'Settings', desc: 'Open Inex Island settings', icon: 'gear' },
  alarm: { id: 'alarm', label: 'Alarm', desc: 'Wake-up / clock alarms with snooze', icon: 'bell' },
  calc: { id: 'calc', label: 'Calculator', desc: 'Windows Calculator tool', icon: 'calc' },
  restart: { id: 'restart', label: 'Restart Island', desc: 'Restart Inex Island engine', icon: 'refresh' },
  notepad: { id: 'notepad', label: 'Quick Notes', desc: 'Floating note editor', icon: 'clipboard' },
  drop: { id: 'drop', label: 'Inex Drop', desc: 'Nearby file sharing with Android & Windows', icon: 'folder' }
};

// Control-panel slots: id + label. The island (main.js) holds the behaviour of each id.
// To add a new one: add it here and add a SLOT_DEFS entry (+ tile) in main.js.
export const SLOT_OPTIONS = [
  ['wifi', 'Wi-Fi'],
  ['drop', 'Inex Drop'],
  ['bt', 'Bluetooth'],
  ['tray', 'File Tray'],
  ['notepad', 'Quick Notes'],
  ['mic', 'Microphone']
];

const FONT_MAP = {
  jakarta: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif",
  inter: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  poppins: "'Poppins', sans-serif",
  outfit: "'Outfit', sans-serif",
  space: "'Space Grotesk', sans-serif",
  montserrat: "'Montserrat', sans-serif",
  lexend: "'Lexend', sans-serif",
  syne: "'Syne', sans-serif",
  raleway: "'Raleway', sans-serif",
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  matrix: "'Doto', 'Space Mono', monospace",
  spacemono: "'Space Mono', monospace",
  grotesk: "'Space Grotesk', sans-serif"
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, extra) {
  for (const k of Object.keys(extra || {})) {
    if (isObj(base[k]) && isObj(extra[k])) merge(base[k], extra[k]);
    else if (k in base) base[k] = extra[k];
  }
  return base;
}

export function load() {
  const base = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) merge(base, JSON.parse(raw));
    if (!base.menu) base.menu = {};
    if (!Array.isArray(base.menu.actionTiles) || base.menu.actionTiles.length === 0) {
      base.menu.actionTiles = [...DEFAULT_ACTION_TILES];
    }
    base.menu.actionTiles = base.menu.actionTiles.filter((id) => ALL_ACTION_TILES[id]);
    if (base.menu.actionTiles.length === 0) {
      base.menu.actionTiles = [...DEFAULT_ACTION_TILES];
    }
    // never more than MAX_ACTION_TILES (older saves had 8 because Quick Notes was force-added): drop Quick Notes first
    if (base.menu.actionTiles.length > MAX_ACTION_TILES) {
      const withoutNotes = base.menu.actionTiles.filter((id) => id !== 'notepad');
      base.menu.actionTiles = (withoutNotes.length >= MAX_ACTION_TILES ? withoutNotes : base.menu.actionTiles).slice(0, MAX_ACTION_TILES);
    }
    if (!base.slots) base.slots = { a: 'wifi', b: 'drop', c: 'bt', d: 'tray' };
    if (!base.slots.a) base.slots.a = 'bt';
    if (!base.slots.b) base.slots.b = 'wifi';
    if (!base.slots.c) base.slots.c = 'drop';
    if (!base.slots.d) base.slots.d = 'tray';
    const usedSlots = new Set();
    const validSlots = ['wifi', 'drop', 'bt', 'tray', 'notepad', 'mic'];
    for (const k of ['a', 'b', 'c', 'd']) {
      let val = base.slots[k];
      if (!validSlots.includes(val) || usedSlots.has(val)) {
        val = validSlots.find(opt => !usedSlots.has(opt)) || 'wifi';
        base.slots[k] = val;
      }
      usedSlots.add(val);
    }
    if (!base.share.deviceName) base.share.deviceName = localStorage.getItem('island_pc_name') || '';
    if (base.share) delete base.share.firebaseUrl;          // Firebase is gone: drop the old saved URL
    localStorage.removeItem('island_firebase_url');
  } catch (_) { /* storage blocked: defaults */ }
  return base;
}

export function save(settings) {
  const json = JSON.stringify(settings);
  try {
    localStorage.setItem(KEY, json);
    if (settings.share.deviceName) localStorage.setItem('island_pc_name', settings.share.deviceName);
  } catch (_) {}
  try { window.__TAURI__?.core.invoke('settings_changed', { json }); } catch (_) {}
}

export function subscribe(cb) {
  window.addEventListener('storage', (e) => { if (e.key === KEY) cb(load()); });
  const register = () => {
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
      window.__TAURI__.event.listen('settings-changed', (e) => {
        try {
          if (e && e.payload) {
            const raw = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload);
            localStorage.setItem(KEY, raw);
          }
        } catch (_) {}
        cb(load());
      });
    } else {
      setTimeout(register, 100);
    }
  };
  register();
}

export function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function isLightRgb(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000 > 155;
}

// The surface the menu is painted with. main.js imports this, so it must exist.
// Notch, bezel ears and menu are ONE piece: the menu always uses the notch colour and opacity
// (picked once in Settings > System > Island Color). Only the glass style is separate.
export function menuSurface(a) {
  return { style: a.menuStyle, color: a.notchColor, opacity: a.notchOpacity };
}

// Writes the CSS variables the island styles read (with Auto Contrast for White/Light themes)
export function applyTheme(s) {
  const root = document.documentElement.style;
  const a = s.appearance;
  const [nr, ng, nb] = hexToRgb(a.notchColor);
  const ms = menuSurface(a);
  const [mr, mg, mb] = hexToRgb(ms.color);
  const [br, bg, bb] = hexToRgb(a.borderColor);

  root.setProperty('--notch-line', 'transparent');

  const notchLight = isLightRgb(nr, ng, nb) && a.notchOpacity > 45;
  const menuLight = ms.style === 'color' && isLightRgb(mr, mg, mb) && ms.opacity > 45;

  root.setProperty('--font-main', FONT_MAP[a.fontStyle] || FONT_MAP.jakarta);
  root.setProperty('--notch-bg', `rgba(${nr}, ${ng}, ${nb}, ${a.notchOpacity / 100})`);
  // ears overlap the island by half a pixel to hide the seam, but only when opaque (translucent colours would double up)
  root.setProperty('--ear-overlap', a.notchOpacity >= 98 ? '1px' : '0px');
  root.setProperty('--notch-fg', notchLight ? '#050507' : '#f5f5f7');
  root.setProperty('--notch-fg-dim', notchLight ? 'rgba(5, 5, 7, 0.62)' : '#8e8e98');

  root.setProperty('--menu-bg', `rgba(${mr}, ${mg}, ${mb}, ${ms.opacity / 100})`);
  root.setProperty('--menu-fg', menuLight ? '#050507' : '#f5f5f7');
  root.setProperty('--menu-fg-dim', menuLight ? 'rgba(5, 5, 7, 0.58)' : '#8e8e98');

  // Solid contrast tiles when Menu Style = Color
  root.setProperty('--color-tile-bg', menuLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.07)');
  root.setProperty('--color-tile-border', menuLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)');
  root.setProperty('--color-tile-on-bg', menuLight ? '#050507' : '#f5f5f7');
  root.setProperty('--color-tile-on-fg', menuLight ? '#ffffff' : '#050507');

  // Active glow is automatic now: always the opposite of the menu background, so it never disappears
  const menuBgRgb = ms.style === 'color' ? [mr, mg, mb] : [14, 14, 20];
  const menuBgLight = isLightRgb(menuBgRgb[0], menuBgRgb[1], menuBgRgb[2]) && (ms.style !== 'color' || ms.opacity > 45);
  root.setProperty('--on', menuBgLight ? '5, 5, 7' : '245, 245, 247');

  // Accent is automatic: always the opposite of the menu surface (light menu -> near-black, dark menu -> white),
  // so active tiles, icons, sliders and gauges can never blend into the panel.
  root.setProperty('--mac-accent', menuBgLight ? '#111114' : '#f5f5f7');
  root.setProperty('--mac-accent-fg', menuBgLight ? '#ffffff' : '#050507');
  root.setProperty('--mac-accent-text', 'var(--menu-fg)');
  root.setProperty('--line', 'transparent');
  root.setProperty('--radius', a.cornerRadius + 'px');
  root.setProperty('--radius-menu', Math.round(a.cornerRadius * 1.15) + 'px');
}