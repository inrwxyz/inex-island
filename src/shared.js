// Settings store shared by the island window and the settings window.
// Saved in localStorage (same origin for both windows) and broadcast through Tauri.

export const KEY = 'inex.settings.v1';

export const DEFAULTS = {
  general: { launchAtLogin: false, hour24: false, autoUpdate: true, lowBatteryAlert: true, lowBattery: 20, chargeToast: true, lockToast: true },
  appearance: {
    notchColor: '#030305', notchOpacity: 100, cornerRadius: 13,
    menuStyle: 'transparent', menuColor: '#0b0b10', menuOpacity: 92,
    glowColor: '#ffffff', borderColor: '#ffffff', borderOpacity: 45,
    fontStyle: 'jakarta', scale: 100, animations: true
  },
  notch: {
    mode: 'smart', style: 'attached', musicMode: true, compactMode: true, ambientGlow: true, compactGlow: true,
    calendarTimer: true, timerSound: true, eqSync: true, eqSensitivity: 100
  },
  weather: { enabled: true, unit: 'C' },
  widgets: { left: 'weather', right: 'ram' },
  slots: { a: 'wifi', b: 'bt' },
  overlays: { btBattery: true },
  share: { deviceName: '', firebaseUrl: '' }
};

// Control-panel slots: id + label. The island (main.js) holds the behaviour of each id.
// To add a new one: add it here and add a SLOT_DEFS entry (+ tile) in main.js.
export const SLOT_OPTIONS = [
  ['wifi', 'Wi-Fi'],
  ['bt', 'Bluetooth'],
  ['mic', 'Microphone mute'],
  ['notepad', 'Notepad']
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
  mono: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace"
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
    if (!base.share.deviceName) base.share.deviceName = localStorage.getItem('island_pc_name') || '';
    if (!base.share.firebaseUrl) base.share.firebaseUrl = localStorage.getItem('island_firebase_url') || '';
  } catch (_) { /* storage blocked: defaults */ }
  return base;
}

export function save(settings) {
  const json = JSON.stringify(settings);
  try {
    localStorage.setItem(KEY, json);
    if (settings.share.deviceName) localStorage.setItem('island_pc_name', settings.share.deviceName);
    if (settings.share.firebaseUrl !== undefined) localStorage.setItem('island_firebase_url', settings.share.firebaseUrl);
  } catch (_) {}
  try { window.__TAURI__?.core.invoke('settings_changed', { json }); } catch (_) {}
}

export function subscribe(cb) {
  window.addEventListener('storage', (e) => { if (e.key === KEY) cb(load()); });
  try {
    window.__TAURI__?.event.listen('settings-changed', (e) => {
      try { localStorage.setItem(KEY, e.payload); } catch (_) {}
      cb(load());
    });
  } catch (_) {}
}

export function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function isLightRgb(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000 > 155;
}

// Writes the CSS variables the island styles read (with Auto Contrast for White/Light themes)
export function applyTheme(s) {
  const root = document.documentElement.style;
  const a = s.appearance;
  const [nr, ng, nb] = hexToRgb(a.notchColor);
  const [mr, mg, mb] = hexToRgb(a.menuColor);
  const [br, bg, bb] = hexToRgb(a.borderColor);

  const notchLight = isLightRgb(nr, ng, nb) && a.notchOpacity > 45;
  const menuLight = a.menuStyle === 'color' && isLightRgb(mr, mg, mb) && a.menuOpacity > 45;

  root.setProperty('--font-main', FONT_MAP[a.fontStyle] || FONT_MAP.jakarta);
  root.setProperty('--notch-bg', `rgba(${nr}, ${ng}, ${nb}, ${a.notchOpacity / 100})`);
  root.setProperty('--notch-fg', notchLight ? '#050507' : '#f5f5f7');
  root.setProperty('--notch-fg-dim', notchLight ? 'rgba(5, 5, 7, 0.62)' : '#8e8e98');

  root.setProperty('--menu-bg', `rgba(${mr}, ${mg}, ${mb}, ${a.menuOpacity / 100})`);
  root.setProperty('--menu-fg', menuLight ? '#050507' : '#f5f5f7');
  root.setProperty('--menu-fg-dim', menuLight ? 'rgba(5, 5, 7, 0.58)' : '#8e8e98');

  // Solid contrast tiles when Menu Style = Color
  root.setProperty('--color-tile-bg', menuLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.07)');
  root.setProperty('--color-tile-border', menuLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)');
  root.setProperty('--color-tile-on-bg', menuLight ? '#050507' : '#f5f5f7');
  root.setProperty('--color-tile-on-fg', menuLight ? '#ffffff' : '#050507');

  root.setProperty('--on', hexToRgb(a.glowColor).join(', '));
  root.setProperty('--line', `rgba(${br}, ${bg}, ${bb}, ${a.borderOpacity / 100})`);
  root.setProperty('--radius', a.cornerRadius + 'px');
  root.setProperty('--radius-menu', Math.round(a.cornerRadius * 1.15) + 'px');
}