import { DEFAULTS, SLOT_OPTIONS, ALL_ACTION_TILES, DEFAULT_ACTION_TILES, load, save, subscribe } from './shared.js';

const invoke = (cmd, args) => (window.__TAURI__?.core ? window.__TAURI__.core.invoke(cmd, args) : Promise.resolve(null));
let S = load();

// ---------- settings window theme (dark | light | system) ----------
function applySettingsTheme(theme) {
  const t = theme || 'system';
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
  } else {
    delete document.documentElement.dataset.theme;
  }
}
applySettingsTheme(S.general?.settingsTheme);

// ---------- icons ----------
const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  palette: I('<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4a4 4 0 0 0 4-4C21.4 6 17.1 2 12 2z"/>'),
  notch: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'),
  layers: I('<path d="M12 2 2 7l10 5 10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
  power: I('<path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0"/>'),
  upload: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  download: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  battery: I('<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2M6 10v4"/>'),
  refresh: I('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>'),
  logout: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  music: I('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  bell: I('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  sound: I('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'),
  calendar: I('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  spark: I('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
  circle: I('<circle cx="12" cy="12" r="9"/>'),
  eq: I('<path d="M4 20V10M9 20V4M14 20v-8M19 20V7"/>'),
  cloud: I('<path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>'),
  pin: I('<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="3"/>'),
  widgets: I('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
  drop: I('<path d="M12 2.7s7 7.2 7 12.3a7 7 0 0 1-14 0c0-5.1 7-12.3 7-12.3z"/>'),
  sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: I('<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>'),
  corner: I('<path d="M4 20V10a6 6 0 0 1 6-6h10"/>'),
  expand: I('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  monitor: I('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  bt: I('<path d="M6.5 6.5 17.5 17.5 12 23V1l5.5 5.5-11 11"/>'),
  mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  reset: I('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>'),
  border: I('<rect x="3" y="3" width="18" height="18" rx="4"/>'),
  font: I('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  snip: I('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>'),
  calc: I('<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M8 18h.01M12 18h.01"/>'),
  notepad: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>'),
  clipboard: I('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/>'),
  folder: I('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  lock: I('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  plus: I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  minus: I('<line x1="5" y1="12" x2="19" y2="12"/>'),
  chevDown: I('<polyline points="6 9 12 15 18 9"/>'),
  github: I('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>'),
  check: I('<polyline points="20 6 9 17 4 12"/>')
};

// ---------- settings schema ----------
const WIDGET_OPTS = [['none', 'None'], ['weather', 'Weather'], ['ram', 'RAM'], ['cpu', 'CPU'], ['gpu', 'GPU'], ['battery', 'Battery'], ['disk', 'Disk'], ['net', 'Net Speed']];
const COMPACT_CONTENT_OPTS = [
  ['clock', 'Time (Default)'],
  ['weather', 'Weather'],
  ['cpu', 'CPU %'],
  ['ram', 'RAM %'],
  ['battery', 'Battery %'],
  ['cycle', 'Auto Cycle']
];
const FONT_OPTS = [
  ['jakarta', 'Plus Jakarta Sans (Modern Clean)'],
  ['matrix', 'Doto Matrix (Dot Matrix Display)'],
  ['spacemono', 'Space Mono (Technical Monospace)'],
  ['inter', 'Inter (Crisp & Minimal)'],
  ['poppins', 'Poppins (Geometric & Vibrant)'],
  ['outfit', 'Outfit (Friendly & Rounded)'],
  ['space', 'Space Grotesk (Tech & Brutalist)'],
  ['montserrat', 'Montserrat (Classic & Elegant)'],
  ['lexend', 'Lexend (Ultra-Readable)'],
  ['syne', 'Syne (Futuristic & Expressive)'],
  ['raleway', 'Raleway (Stylish & Sleek)'],
  ['system', 'Windows Segoe UI (Native)'],
  ['mono', 'JetBrains Mono (Developer Code)']
];

const menuIs = (mode) => (s) => (s.appearance?.menuLayout || 'classic') === mode;
const weatherNeededByNotch = (s) => ['weather', 'cycle'].includes(s.notch?.compactContent || 'clock');
const weatherShown = (s) => (s.widgets?.enabled || weatherNeededByNotch(s) || (menuIs('mac')(s) && s.macMenu?.showWeather)) && s.weather?.enabled;

const PAGES = [
  {
    id: 'notch', num: '01', label: 'Notch', eyebrow: 'NOTCH & PILL',
    title: 'Notch', sub: 'Configure resting status, pill shape, music mode and hover widgets.',
    icon: 'notch',
    sections: [
      { id: 'notch-shape', title: 'Design & Resting Pill', defaultOpen: true, rows: [
        { path: 'notch.style', type: 'seg', icon: 'notch', t: 'Notch Style', d: 'Bezel Notch touches the top edge; Floating Island floats below as a pill', options: [['attached', 'Bezel Notch'], ['floating', 'Floating Island']] },
        { path: 'notch.macEars', type: 'toggle', icon: 'corner', t: 'Curved Bezel Ears (Mac Style)', d: 'Add smooth outward-curving corners connecting the notch to the screen top edge', showIf: (s) => s.notch.style !== 'floating' },
        { path: 'notch.mode', type: 'seg', icon: 'notch', t: 'Behavior', d: 'Smart hides on fullscreen, Fixed stays, Ghost is glass outline', options: [['smart', 'Smart'], ['fixed', 'Fixed'], ['ghost', 'Ghost']] },
        { path: 'notch.compactContent', type: 'select', icon: 'clock', t: 'Resting Pill Display', d: 'What sits in the center when idle — works in both Classic and Control Deck', options: COMPACT_CONTENT_OPTS },
        { path: 'appearance.cornerRadius', type: 'range', icon: 'corner', t: 'Corner Roundness', d: 'Curvature of the notch and menus', min: 0, max: 28, step: 1, unit: 'px', showIf: (s) => s.notch.style !== 'floating' }
      ] },
      { id: 'notch-type', title: 'Typography & Scale', defaultOpen: false, rows: [
        { path: 'appearance.fontStyle', type: 'select', icon: 'font', t: 'Font Family', d: 'Curated modern typefaces applied across the island', options: FONT_OPTS },
        { path: 'appearance.scale', type: 'range', stepper: true, icon: 'expand', t: 'UI Scale', d: 'Smoothly scales entire island interface and fonts', min: 110, max: 140, step: 5, unit: '%' }
      ] },
      { id: 'notch-music', title: 'Music & Visualizer', defaultOpen: false, rows: [
        { path: 'notch.musicMode', type: 'toggle', icon: 'music', t: 'Music Mode', d: 'Live interactive music widget' },
        { path: 'notch.compactMode', type: 'toggle', icon: 'expand', t: 'Compact Wave', d: 'Show wave & thumbnail when collapsed', showIf: (s) => s.notch.musicMode },
        { path: 'notch.compactGlow', type: 'toggle', icon: 'circle', t: 'Artwork Glow', d: 'Glow around collapsed artwork', showIf: (s) => s.notch.musicMode },
        { path: 'notch.ambientGlow', type: 'toggle', icon: 'spark', t: 'Ambient Glow', d: 'Album-coloured glow behind the notch and Control Deck media cards', showIf: (s) => s.notch.musicMode },
        { path: 'notch.eqSync', type: 'toggle', icon: 'eq', t: 'Sync with Sound', d: 'Bars react to real computer audio output', showIf: (s) => s.notch.musicMode },
        { path: 'notch.eqSensitivity', type: 'range', icon: 'eq', t: 'Sensitivity', d: 'Higher = reacts to quieter volume', min: 50, max: 300, step: 10, unit: '%', showIf: (s) => s.notch.musicMode && s.notch.eqSync }
      ] },
      { id: 'notch-widgets', title: 'Hover Widgets & Weather', defaultOpen: false, rows: [
        { path: 'notch.calendarTimer', type: 'toggle', icon: 'calendar', t: 'Calendar & Timer', d: 'Productivity split-view on time click' },
        { path: 'widgets.enabled', type: 'toggle', icon: 'widgets', t: 'Hover Widgets', d: 'Expand pill sides on hover. Off = pill never stretches on hover' },
        { path: 'widgets.left', type: 'select', icon: 'widgets', t: 'Left Hover Widget', d: 'Shown on the left on notch hover', options: WIDGET_OPTS, showIf: (s) => s.widgets.enabled },
        { path: 'widgets.right', type: 'select', icon: 'widgets', t: 'Right Hover Widget', d: 'Shown on the right on notch hover', options: WIDGET_OPTS, showIf: (s) => s.widgets.enabled },
        { path: 'weather.enabled', type: 'toggle', icon: 'cloud', t: 'Live Weather', d: 'Fetch real-time local temperature for notch & widgets', showIf: (s) => s.widgets.enabled || weatherNeededByNotch(s) || (menuIs('mac')(s) && s.macMenu?.showWeather) },
        { path: 'weather.unit', type: 'seg', icon: 'sun', t: 'Unit', d: 'Celsius or Fahrenheit', options: [['C', '°C'], ['F', '°F']], showIf: weatherShown },
        { path: 'weather.city', type: 'text', icon: 'pin', t: 'City', d: 'Leave empty for automatic location. Press Enter to apply', placeholder: 'e.g. Dhaka', showIf: weatherShown },
        { path: 'overlays.privacyDot', type: 'toggle', icon: 'mic', t: 'Mic Indicator', d: 'Small dot beside the clock while an app uses your microphone' }
      ] }
    ]
  },

  {
    id: 'menu', num: '02', label: 'Menu', eyebrow: 'CONTROL MENU & LAYOUT',
    title: 'Menu', sub: 'Switch between the Classic Control Center and the Control Deck widget dashboard.',
    icon: 'layers',
    hero: 'menuLayout',
    sections: [
      { id: 'menu-appearance', title: 'Panel Appearance', defaultOpen: true, rows: [
        { path: 'appearance.menuStyle', type: 'seg', icon: 'layers', t: 'Glass Style', d: 'Transparent blurred glass or solid contrast color', options: [['transparent', 'Transparent Glass'], ['color', 'Solid Color']] }
      ] },
      { id: 'menu-slots', title: 'Classic 2×2 Control Slots', defaultOpen: false, showIf: menuIs('classic'), rows: [
        { path: 'slots.a', type: 'select', icon: 'widgets', t: 'Slot 1 (Top-Left)', d: 'Default is Bluetooth', options: SLOT_OPTIONS, onChange: slotChange('a') },
        { path: 'slots.b', type: 'select', icon: 'widgets', t: 'Slot 2 (Top-Right)', d: 'Default is Wi-Fi', options: SLOT_OPTIONS, onChange: slotChange('b') },
        { path: 'slots.c', type: 'select', icon: 'widgets', t: 'Slot 3 (Bottom-Left)', d: 'Default is Inex Drop', options: SLOT_OPTIONS, onChange: slotChange('c') },
        { path: 'slots.d', type: 'select', icon: 'widgets', t: 'Slot 4 (Bottom-Right)', d: 'Default is File Tray', options: SLOT_OPTIONS, onChange: slotChange('d') }
      ] },
      { id: 'menu-mac-widgets', title: 'Control Deck Widgets', defaultOpen: true, showIf: menuIs('mac'), rows: [
        { path: 'macMenu.showClock', type: 'toggle', icon: 'clock', t: 'Clock & Date Card', d: 'Show time and weekday header inside the Control Deck' },
        { path: 'macMenu.showBattery', type: 'toggle', icon: 'battery', t: 'Laptop Battery in Header', d: 'Display battery percentage and charging indicator in the top right' },
        { path: 'macMenu.showWeather', type: 'toggle', icon: 'cloud', t: 'Weather Widget', d: 'Live temperature card in the expanded Control Deck' },
        { path: 'macMenu.showStats', type: 'toggle', icon: 'monitor', t: 'System Stats Card', d: 'Compact live performance meters inside the Control Deck' },
        { path: 'macMenu.statsMode', type: 'seg', icon: 'monitor', t: 'Stat Card Mode', d: 'What to display in the mini status card', options: [['sys', 'CPU & RAM'], ['bt', 'Bluetooth Device'], ['battery', 'Laptop Battery'], ['disk', 'Disk']], showIf: (s) => s.macMenu.showStats !== false },
        { path: 'macMenu.showMedia', type: 'toggle', icon: 'music', t: 'Media Quick Card', d: 'Music card in the Control Deck, shown whether or not music is playing' },
        { path: 'macMenu.showSliders', type: 'toggle', icon: 'sound', t: 'Volume & Brightness Sliders', d: 'Keep quick sliders accessible inside the Control Deck' }
      ] },
      { id: 'menu-motion', title: 'Motion & Feel', defaultOpen: false, rows: [
        { path: 'appearance.animations', type: 'toggle', icon: 'spark', t: 'Micro-Interactions', d: 'Haptic button scaling, spring transitions & glass highlights' }
      ] }
    ]
  },

  {
    id: 'sounds', num: '03', label: 'Sounds', eyebrow: 'AUDIO FEEDBACK',
    title: 'Sounds', sub: 'Subtle native Windows sounds rendered in memory — zero extra RAM or background audio service.',
    icon: 'sound',
    hero: 'soundsMaster',
    sections: [
      { id: 'sounds-events', title: 'System Status Sounds', defaultOpen: true, rows: [
        { path: 'sounds.power', type: 'toggle', icon: 'battery', t: 'Charger & Low Battery', d: 'Soft chime on plug-in, unplug and low battery warning', disabledIf: (s) => !s.sounds?.enabled, preview: 'power' },
        { path: 'sounds.bluetooth', type: 'toggle', icon: 'bt', t: 'Bluetooth Connect', d: 'Crisp pluck when headphones or BT devices connect', disabledIf: (s) => !s.sounds?.enabled, preview: 'bluetooth' },
        { path: 'sounds.transfer', type: 'toggle', icon: 'upload', t: 'File Drop & P2P Transfer', d: 'Tone for incoming files and completed transfers', disabledIf: (s) => !s.sounds?.enabled, preview: 'transfer' },
        { path: 'sounds.lock', type: 'toggle', icon: 'lock', t: 'Lock / Unlock Reveal', d: 'Chime paired with biometric / locker unlock animation', disabledIf: (s) => !s.sounds?.enabled, preview: 'lock' }
      ] },
      { id: 'sounds-timer', title: 'Productivity & Timer', defaultOpen: true, rows: [
        { path: 'notch.timerSound', type: 'toggle', icon: 'bell', t: 'Focus Timer Chime', d: 'Gentle crystal alarm when Focus Timer finishes', preview: 'alarm' }
      ] }
    ]
  },

  {
    id: 'connect', num: '04', label: 'Connect', eyebrow: 'BLUETOOTH & NEARBY SHARE',
    title: 'Connect', sub: 'Manage paired Bluetooth battery overlays and P2P discovery identity.',
    icon: 'bt',
    sections: [
      { id: 'connect-devices', title: 'Devices & Share', defaultOpen: true, rows: [
        { path: 'overlays.btBattery', type: 'toggle', icon: 'bt', t: 'Bluetooth Battery', d: 'Show battery % on connected Bluetooth headphones' },
        { path: 'share.deviceName', type: 'text', icon: 'monitor', t: 'Device Name', d: 'Name shown to nearby devices on Inex Drop & P2P Link', placeholder: 'My PC' }
      ] }
    ]
  },

  {
    id: 'system', num: '05', label: 'System', eyebrow: 'THEME, STARTUP & ALERTS',
    title: 'System', sub: 'Pick your Settings appearance, Windows startup behavior, and toast alerts.',
    icon: 'gear',
    hero: 'settingsTheme',
    sections: [
      { id: 'sys-island-color', title: 'Island Color', defaultOpen: true, rows: [
        { path: 'appearance.notchColor', type: 'color', icon: 'palette', t: 'Color', d: 'One colour for the notch, bezel ears and menu. Icons, tiles and text switch to black or white automatically to stay readable' },
        { path: 'appearance.notchOpacity', type: 'range', icon: 'drop', t: 'Opacity', d: 'Solid or translucent notch and menu', min: 30, max: 100, step: 5, unit: '%' }
      ] },
      { id: 'sys-startup', title: 'Startup & Time', defaultOpen: true, rows: [
        { path: 'general.launchAtLogin', type: 'toggle', icon: 'power', t: 'Launch at Login', d: 'Start Inex Island automatically with Windows', onChange: (v) => invoke('set_autostart', { on: v }) },
        { path: 'general.autoUpdate', type: 'toggle', icon: 'spark', t: 'Auto Update', d: 'Download and install updates automatically on launch', },
        { path: 'general.hour24', type: 'toggle', icon: 'clock', t: '24-Hour Time', d: 'Display 24-hour clock format everywhere' }
      ] },
      { id: 'sys-alerts', title: 'Island Popups & Battery', defaultOpen: false, rows: [
        { path: 'general.lockToast', type: 'toggle', icon: 'lock', t: 'Unlock Animation', d: 'Reveal animation after Windows or Locker unlock' },
        { path: 'general.copyToast', type: 'toggle', icon: 'clipboard', t: 'Clipboard Popup HUD', d: 'Island toast preview when text or a screenshot is captured' },
        { path: 'general.chargeToast', type: 'toggle', icon: 'battery', t: 'Charger Notification', d: 'Island HUD when laptop charger connects or disconnects' },
        { path: 'general.lowBatteryAlert', type: 'toggle', icon: 'battery', t: 'Low Battery Alert', d: 'Warn when battery drops below threshold' },
        { path: 'general.lowBattery', type: 'range', icon: 'battery', t: 'Alert Level', d: 'Threshold to trigger low battery warning', min: 5, max: 50, step: 5, unit: '%', showIf: (s) => s.general.lowBatteryAlert }
      ] },
      { id: 'sys-backup', title: 'Backup & Restore', defaultOpen: false, rows: [
        { type: 'action', icon: 'download', t: 'Export Settings', d: 'Save current configuration to a JSON file', run: exportSettings },
        { type: 'action', icon: 'upload', t: 'Import Settings', d: 'Load a saved inex-island-settings.json file', run: importSettings }
      ] },
      { id: 'sys-maint', title: 'App Maintenance', defaultOpen: false, rows: [
        { type: 'action', icon: 'reset', t: 'Reset to Defaults', d: 'Restore all factory settings and reboot Inex Island', danger: true, run: resetAll },
        { type: 'action', icon: 'refresh', t: 'Restart Inex Island', d: 'Reinitialize island window and system listeners', run: () => invoke('restart_app') },
        { type: 'action', icon: 'logout', t: 'Quit Inex Island', d: 'Completely exit application', danger: true, run: () => invoke('quit_app') }
      ] }
    ]
  },

  {
    id: 'about', num: '06', label: 'About', eyebrow: 'VERSION & UPDATES',
    title: 'About', sub: 'Application build info, release updates, and developer links.',
    icon: 'info',
    about: true,
    sections: [
      { id: 'about-links', title: 'Updates & Developer', defaultOpen: true, rows: [
        { type: 'action', icon: 'refresh', t: 'Check for Updates', d: 'Check GitHub releases for the latest version', run: checkUpdatesAction },
        { type: 'action', icon: 'github', t: 'Developer Profile', d: 'https://github.com/inrwxyz', run: () => openExternalUrl('https://github.com/inrwxyz') }
      ] }
    ]
  }
];

// ---------- section header icons (non-collapsible group labels) ----------
const SECTION_ICON = {
  'notch-shape': 'notch', 'notch-type': 'font', 'notch-music': 'music', 'notch-widgets': 'widgets',
  'menu-appearance': 'palette', 'menu-slots': 'widgets', 'menu-mac-widgets': 'layers', 'menu-motion': 'spark', 'menu-quick-actions': 'widgets',
  'sounds-events': 'sound', 'sounds-timer': 'bell',
  'connect-devices': 'bt',
  'sys-startup': 'power', 'sys-alerts': 'bell', 'sys-backup': 'download', 'sys-maint': 'gear',
  'about-links': 'info'
};
function sectionHead(id, title, tag) {
  return el('div', 'sec-head',
    `<span class="sec-ico">${ICON[SECTION_ICON[id]] || ICON.circle}</span><span class="sec-t">${title}</span><span class="sec-rule"></span>${tag != null ? `<span class="sec-tag">${tag}</span>` : ''}`);
}

// ---------- helpers ----------
const get = (path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), S);
function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let cur = S;
  for (const k of keys) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
}
// Dropdown opens as a fixed layer so the card / page scroll area can never cut it off.
// Opens below the button; if there is not enough room below it flips up.
function placeSelMenu(trigger, menu) {
  const r = trigger.getBoundingClientRect();
  const gap = 5, pad = 10;
  menu.style.visibility = 'hidden';
  menu.style.maxHeight = '';
  const natural = menu.scrollHeight + 10;
  const below = window.innerHeight - r.bottom - gap - pad;
  const above = r.top - gap - pad;
  const up = natural > below && above > below;
  const maxH = Math.max(80, Math.min(natural, up ? above : below, 320));
  menu.style.maxHeight = maxH + 'px';
  const h = Math.min(natural, maxH);
  menu.style.top = (up ? r.top - gap - h : r.bottom + gap) + 'px';
  const w = Math.max(menu.offsetWidth, r.width);
  menu.style.left = Math.max(pad, Math.min(r.right - w, window.innerWidth - w - pad)) + 'px';
  menu.style.visibility = '';
}

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', 'toast'); document.querySelector('.win').append(t); }
  t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1800);
}
let isSelfSaving = false;
let isDragging = false;
let saveDebounce = null;

function commit(path, value, onChange) {
  const prev = get(path);
  set(path, value);
  if (path === 'general.settingsTheme') {
    applySettingsTheme(value);
  }
  isSelfSaving = true;
  save(S);
  setTimeout(() => { isSelfSaving = false; }, 300);
  if (onChange) onChange(value, prev);
}

function debouncedCommit(path, value, onChange) {
  const prev = get(path);
  set(path, value);
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => {
    isSelfSaving = true;
    save(S);
    setTimeout(() => { isSelfSaving = false; }, 300);
  }, 40);
  if (onChange) onChange(value, prev);
}

function slotChange(currentKey) {
  return (v, prev) => {
    if (!S.slots) S.slots = { a: 'bt', b: 'wifi', c: 'drop', d: 'tray' };
    const keys = ['a', 'b', 'c', 'd'];
    for (const k of keys) {
      if (k !== currentKey && S.slots[k] === v) {
        S.slots[k] = prev;
        save(S);
        break;
      }
    }
    renderPage();
  };
}

function previewSound(kind) {
  if (kind === 'alarm') invoke('play_alarm_sound').catch(() => {});
  else invoke('play_status_sound', { kind }).catch(() => {});
}

// ---------- row renderers ----------
function control(row) {
  const v = row.path ? get(row.path) : null;
  const wrap = el('div', 'ctl');
  const change = (nv, rerender = true) => { commit(row.path, nv, row.onChange); if (rerender) renderPage(); };

  if (row.preview) {
    const testBtn = el('button', 'btn btn-outline', 'Test');
    testBtn.type = 'button';
    testBtn.title = 'Play sound preview';
    testBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      previewSound(row.preview);
    });
    wrap.append(testBtn);
  }

  if (row.type === 'toggle') {
    const b = el('button', 'sw' + (v ? ' on' : ''));
    b.addEventListener('click', () => {
      const next = !get(row.path);
      change(next);
      if (next && row.preview) previewSound(row.preview);
    });
    wrap.append(b);
  } else if (row.type === 'range' && row.stepper) {
    // − / + buttons (no dragging): every click moves one step, quick clicks are merged into ONE change,
    // so the island window is resized once instead of many times (no shaking).
    const box = el('div', 'range stepper');
    let cur = +v;
    const out = el('span', 'v', cur + (row.unit || ''));
    const minus = el('button', 'step-btn', '\u2212'); minus.type = 'button'; minus.title = 'Smaller';
    const plus = el('button', 'step-btn', '+'); plus.type = 'button'; plus.title = 'Bigger';
    let t = null;
    const sync = () => { out.textContent = cur + (row.unit || ''); minus.disabled = cur <= row.min; plus.disabled = cur >= row.max; };
    const bump = (dir) => {
      const nv = Math.min(row.max, Math.max(row.min, cur + dir * row.step));
      if (nv === cur) return;
      cur = nv; sync();
      clearTimeout(t);
      t = setTimeout(() => commit(row.path, cur, row.onChange), 140);
    };
    minus.addEventListener('click', () => bump(-1));
    plus.addEventListener('click', () => bump(1));
    sync();
    box.append(minus, out, plus); wrap.append(box);
  } else if (row.type === 'range') {
    const box = el('div', 'range');
    const inp = el('input'); inp.type = 'range'; inp.min = row.min; inp.max = row.max; inp.step = row.step; inp.value = v;
    const out = el('span', 'v', v + (row.unit || ''));
    const paint = () => { inp.style.setProperty('--p', ((inp.value - row.min) / (row.max - row.min)) * 100 + '%'); out.textContent = inp.value + (row.unit || ''); };
    paint();
    inp.addEventListener('pointerdown', () => { isDragging = true; });
    inp.addEventListener('input', () => {
      paint();
      debouncedCommit(row.path, +inp.value, row.onChange);
    });
    inp.addEventListener('change', () => {
      commit(row.path, +inp.value, row.onChange);
    });
    box.append(inp, out); wrap.append(box);
  } else if (row.type === 'seg') {
    const seg = el('div', 'seg');
    row.options.forEach(([val, label]) => {
      const b = el('button', val === v ? 'on' : '', label);
      b.addEventListener('click', () => change(val));
      seg.append(b);
    });
    wrap.append(seg);
  } else if (row.type === 'select') {
    const customSel = el('div', 'c-sel');
    const curOpt = row.options.find(([val]) => val === v) || row.options[0];
    const trigger = el('button', 'c-sel-trigger', `<span>${curOpt ? curOpt[1] : ''}</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`);
    trigger.type = 'button';
    const menu = el('div', 'c-sel-menu hidden');
    row.options.forEach(([val, label]) => {
      const item = el('button', 'c-sel-item' + (val === v ? ' active' : ''), label);
      item.type = 'button';
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        trigger.classList.remove('open');
        change(val, true);
      });
      menu.append(item);
    });
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.c-sel-menu:not(.hidden)').forEach(m => {
        if (m !== menu) {
          m.classList.add('hidden');
          m.previousElementSibling?.classList.remove('open');
        }
      });
      const isOpen = !menu.classList.contains('hidden');
      menu.classList.toggle('hidden', isOpen);
      trigger.classList.toggle('open', !isOpen);
      if (!isOpen) placeSelMenu(trigger, menu);
    });
    customSel.append(trigger, menu);
    wrap.append(customSel);
  } else if (row.type === 'text') {
    const inp = el('input', 'txtin'); inp.type = 'text'; inp.value = v || ''; inp.placeholder = row.placeholder || '';
    inp.addEventListener('input', () => {
      if (row.path === 'weather.city') return;
      set(row.path, inp.value.trim());
      if (row.path === 'share.deviceName') localStorage.setItem('island_pc_name', inp.value.trim());
      save(S);
    });
    inp.addEventListener('change', () => {
      if (row.path === 'share.deviceName') localStorage.setItem('island_pc_name', inp.value.trim());
      change(inp.value.trim(), false);
    });
    wrap.append(inp);
  } else if (row.type === 'color') {
    const box = el('div', 'color');
    if (row.swatches) {
      const sw = el('div', 'swatches');
      row.swatches.forEach((c) => { const i = el('i'); i.style.background = c; i.addEventListener('click', () => change(c)); sw.append(i); });
      box.append(sw);
    }
    const inp = el('input'); inp.type = 'color'; inp.value = v;
    const hex = el('span', 'hex', String(v || '#000000').toUpperCase());
    inp.addEventListener('pointerdown', () => { isDragging = true; });
    inp.addEventListener('input', () => {
      hex.textContent = inp.value.toUpperCase();
      debouncedCommit(row.path, inp.value, row.onChange);
    });
    inp.addEventListener('change', () => {
      commit(row.path, inp.value, row.onChange);
    });
    box.append(inp, hex); wrap.append(box);
  }
  return wrap;
}

function renderRow(row) {
  const isDisabled = row.disabledIf && row.disabledIf(S);
  const r = el('div', 'row' + (row.danger ? ' danger' : '') + (row.type === 'action' ? ' click' : '') + (isDisabled ? ' is-off' : ''));
  if (row.actionId) r.dataset.action = row.actionId;
  r.append(el('div', 'ico-box', ICON[row.icon] || ''));
  const title = typeof row.t === 'function' ? row.t() : row.t;
  const desc = typeof row.d === 'function' ? row.d() : (row.d || '');
  const txt = el('div', 'txt'); txt.append(el('div', 't', title), el('div', 'd', desc)); r.append(txt);
  if (row.type === 'action') {
    r.addEventListener('click', row.run);
  } else {
    r.append(control(row));
  }
  return r;
}

// ---------- heroes ----------
function renderMenuLayoutHero(main) {
  const cur = S.appearance?.menuLayout || 'classic';
  const hero = el('div', 'hero');
  hero.innerHTML = `
    <div class="hero-head">
      <div class="hero-title">Menu Mode</div>
      <div class="hero-desc">Settings automatically adapts below to match your chosen menu experience.</div>
    </div>
    <div class="opt-grid">
      <button type="button" class="opt ${cur === 'classic' ? 'on' : ''}" data-mode="classic">
        <div class="mp mp-classic"><i></i><i></i><i></i><i></i><b></b></div>
        <div class="o-t"><span>Classic</span><i></i></div>
        <div class="o-d">Compact 2×2 control tiles, quick actions & sliders.</div>
      </button>
      <button type="button" class="opt ${cur === 'mac' ? 'on' : ''}" data-mode="mac">
        <div class="mp mp-mac"><i class="w1"></i><i></i><i></i></div>
        <div class="o-t"><span>Control Deck</span><i></i></div>
        <div class="o-d">Wide bento panel with live widgets & a media card.</div>
      </button>
    </div>
  `;
  hero.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      commit('appearance.menuLayout', btn.dataset.mode);
      renderPage();
    });
  });
  main.append(hero);
}

function renderSoundsHero(main) {
  const on = S.sounds?.enabled !== false;
  const hero = el('div', 'hero');
  hero.innerHTML = `
    <div class="hero-top">
      <div class="ico-box">${ICON.sound}</div>
      <div class="txt">
        <div class="hero-title">Status Sound Effects</div>
        <div class="hero-desc">${on ? 'Enabled — subtle chimes play on system status events' : 'Muted — all status sounds are silenced'}</div>
      </div>
      <button type="button" class="sw lg ${on ? 'on' : ''}" aria-label="Toggle Status Sounds"></button>
    </div>
  `;
  hero.querySelector('.sw').addEventListener('click', () => {
    const next = !(S.sounds?.enabled !== false);
    commit('sounds.enabled', next);
    if (next) previewSound('clipboard');
    renderPage();
  });
  main.append(hero);
}

function renderSettingsThemeHero(main) {
  const cur = S.general?.settingsTheme || 'system';
  const hero = el('div', 'hero');
  hero.innerHTML = `
    <div class="hero-head">
      <div class="hero-title">Settings Appearance</div>
      <div class="hero-desc">Choose Light, Dark, or follow Windows System Default.</div>
    </div>
    <div class="opt-grid">
      <button type="button" class="opt ${cur === 'dark' ? 'on' : ''}" data-theme="dark">
        <div class="tp tp-dark"><span class="sd"></span><span class="ln l1"></span><span class="ln l2"></span><span class="ln l3"></span><span class="dot"></span></div>
        <div class="o-t"><span>Dark</span><i></i></div>
        <div class="o-d">Deep charcoal, easy on the eyes.</div>
      </button>
      <button type="button" class="opt ${cur === 'light' ? 'on' : ''}" data-theme="light">
        <div class="tp tp-light"><span class="sd"></span><span class="ln l1"></span><span class="ln l2"></span><span class="ln l3"></span><span class="dot"></span></div>
        <div class="o-t"><span>Light</span><i></i></div>
        <div class="o-d">Warm off-white surface & clean cards.</div>
      </button>
      <button type="button" class="opt ${cur === 'system' ? 'on' : ''}" data-theme="system">
        <div class="tp tp-system"><span class="sd"></span><span class="ln l1"></span><span class="ln l2"></span><span class="ln l3"></span><span class="dot"></span></div>
        <div class="o-t"><span>System Default</span><i></i></div>
        <div class="o-d">Follows Windows light or dark mode.</div>
      </button>
    </div>
  `;
  hero.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      commit('general.settingsTheme', btn.dataset.theme);
      renderPage();
    });
  });
  main.append(hero);
}

// ---------- pages & version ----------
let current = 'notch';
let currentAppVer = '0.4.1';
function updateVerLabels() {
  const bv = document.getElementById('brand-ver');
  if (bv) bv.textContent = `v${currentAppVer}`;
  const badge = document.querySelector('.about-title-wrap .pill');
  if (badge) badge.textContent = `v${currentAppVer} Stable`;
}
updateVerLabels();
invoke('get_app_version').then((v) => {
  if (v) { currentAppVer = v; updateVerLabels(); }
});

// ---------- Updates ----------
let updateState = 'idle';
let updateLatest = '';
let updateCheckTime = '';
let updateCheckedAt = 0;

async function checkForUpdate(manual) {
  if (updateState === 'checking' || updateState === 'installing') return;
  if (!manual && updateCheckedAt && Date.now() - updateCheckedAt < 10 * 60 * 1000) return;
  updateState = 'checking';
  if (current === 'about') renderPage();
  try {
    const res = await invoke('check_update');
    if (res && res.available && res.latest_version) {
      updateState = 'available';
      updateLatest = res.latest_version;
      if (manual) toast(`v${res.latest_version} found. Click the banner to update`);
    } else if (res && res.error) {
      updateState = 'error';
      if (manual) toast('Could not check updates. Check your connection.');
    } else {
      updateState = 'uptodate';
      if (res && res.current_version) { currentAppVer = res.current_version; updateVerLabels(); }
      if (manual) toast('You are on the latest version!');
    }
  } catch (_) {
    updateState = 'error';
    if (manual) toast('Could not check updates. Check your connection.');
  }
  updateCheckedAt = Date.now();
  updateCheckTime = `Checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (current === 'about') renderPage();
}

async function installUpdate() {
  if (updateState !== 'available') return;
  updateState = 'installing';
  renderPage();
  try {
    const ok = await invoke('apply_update');
    if (ok) {
      toast('Update installed! Restarting Inex Island...');
      setTimeout(() => invoke('restart_app'), 1200);
      return;
    }
    updateState = 'uptodate';
  } catch (_) {
    toast('Update failed. Please try again.');
    updateState = 'available';
  }
  renderPage();
}

function checkUpdatesAction() { checkForUpdate(true); }

function updateBannerInfo() {
  switch (updateState) {
    case 'checking':   return { cls: 'checking', text: 'Checking for updates...', sub: '' };
    case 'available':  return { cls: 'available', text: `Version v${updateLatest} is available`, sub: 'Click here to update' };
    case 'installing': return { cls: 'installing', text: `Downloading & installing v${updateLatest}...`, sub: 'Inex Island will restart when done' };
    case 'error':      return { cls: 'error', text: 'Could not check for updates', sub: updateCheckTime || 'Check your connection' };
    case 'uptodate':   return { cls: '', text: `Inex Island is up to date (v${currentAppVer})`, sub: updateCheckTime };
    default:           return { cls: '', text: `Inex Island v${currentAppVer}`, sub: '' };
  }
}

function openExternalUrl(url) { invoke('open_url', { url }); }

// ---------- sidebar navigation ----------
function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  PAGES.forEach((p) => {
    const b = el('button', p.id === current ? 'on' : '', `<span class="n">${p.num}</span><span>${p.label}</span>`);
    b.addEventListener('click', () => {
      current = p.id;
      renderNav();
      renderPage(true);
      if (current === 'about') checkForUpdate(false);
    });
    nav.append(b);
  });
}

const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderQuickActionTilesGroup(main) {
  if (!S.menu) S.menu = { actionTiles: [...DEFAULT_ACTION_TILES] };
  if (!Array.isArray(S.menu.actionTiles)) S.menu.actionTiles = [...DEFAULT_ACTION_TILES];

  const addedIds = S.menu.actionTiles;
  const moreBuiltInIds = Object.keys(ALL_ACTION_TILES).filter((id) => !addedIds.includes(id));

  const grp = el('section', 'sec');
  grp.append(sectionHead('menu-quick-actions', 'Quick Action Bar', `${addedIds.length} / 7`));

  const mgr = el('div', 'tile-manager');
  const grp1 = el('div', 'tile-group-header');
  grp1.innerHTML = `<span class="grp-title">Active Tiles (${addedIds.length} / 7)</span><span class="grp-sub">Click − to remove</span>`;
  mgr.append(grp1);

  const grid1 = el('div', 'tiles-grid');
  addedIds.forEach((id) => {
    const tile = ALL_ACTION_TILES[id];
    if (!tile) return;
    const it = el('div', 'action-tile-item');
    it.title = tile.desc || tile.label;
    it.innerHTML = `
      <div class="tile-badge badge-remove" title="Remove tile">${ICON.minus}</div>
      <div class="tile-icon-wrap">${ICON[tile.icon] || ICON.spark}</div>
      <div class="tile-label">${escHtml(tile.label)}</div>
    `;
    it.addEventListener('click', (e) => {
      e.stopPropagation();
      if (addedIds.length <= 1) { toast('At least 1 tile must remain active'); return; }
      S.menu.actionTiles = addedIds.filter((x) => x !== id);
      save(S); toast(`Removed ${tile.label}`); renderPage();
    });
    grid1.append(it);
  });
  mgr.append(grid1);

  if (moreBuiltInIds.length > 0) {
    const grp2 = el('div', 'tile-group-header');
    grp2.innerHTML = `<span class="grp-title">Available Tiles</span><span class="grp-sub">Click + to add</span>`;
    mgr.append(grp2);

    const grid2 = el('div', 'tiles-grid');
    moreBuiltInIds.forEach((id) => {
      const tile = ALL_ACTION_TILES[id];
      if (!tile) return;
      const it = el('div', 'action-tile-item');
      it.title = tile.desc || tile.label;
      it.innerHTML = `
        <div class="tile-badge badge-add" title="Add tile">${ICON.plus}</div>
        <div class="tile-icon-wrap">${ICON[tile.icon] || ICON.spark}</div>
        <div class="tile-label">${escHtml(tile.label)}</div>
      `;
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        if (addedIds.length >= 7) { toast('Maximum 7 action tiles allowed'); return; }
        S.menu.actionTiles = [...addedIds, id];
        save(S); toast(`Added ${tile.label}`); renderPage();
      });
      grid2.append(it);
    });
    mgr.append(grid2);
  }

  const note = el('div', 'tile-note', 'Changes apply immediately to the island menu.');
  mgr.append(note);
  grp.append(mgr);
  main.append(grp);
}

// ---------- main page renderer ----------
function renderPage(resetScroll) {
  const main = document.getElementById('page');
  const keep = main.scrollTop;
  main.innerHTML = '';
  const page = PAGES.find((p) => p.id === current);
  if (!page) return;

  const visibleSections = page.sections
    .filter((sec) => !sec.showIf || sec.showIf(S))
    .map((sec) => ({ ...sec, visibleRows: sec.rows.filter((r) => !r.showIf || r.showIf(S)) }))
    .filter((sec) => sec.visibleRows.length > 0);

  const hasQuickActionsGroup = page.id === 'menu' && menuIs('classic')(S);

  // Page header with editorial eyebrow
  const head = el('div', 'page-head');
  head.append(
    el('div', 'eyebrow', `<span class="num">${page.num}</span><span class="bar"></span><span>${page.eyebrow}</span>`),
    el('h1', '', page.title),
    el('p', '', page.sub)
  );
  main.append(head);

  if (page.hero === 'menuLayout') renderMenuLayoutHero(main);
  else if (page.hero === 'soundsMaster') renderSoundsHero(main);
  else if (page.hero === 'settingsTheme') renderSettingsThemeHero(main);

  if (page.about) {
    const a = el('div', 'about-minimal');
    a.innerHTML = `
      <div class="about-head">
        <img src="logo.svg" alt="Inex Island" class="about-icon" />
        <div class="about-title-wrap">
          <span class="about-title">Inex Island</span>
          <span class="pill pill-green">v${currentAppVer} Stable</span>
        </div>
      </div>
      <div class="update-banner"><div class="up-dot"></div>
        <div class="up-info"><div class="up-status"></div><div class="up-time"></div></div>
      </div>
    `;
    const ub = updateBannerInfo();
    const bannerEl = a.querySelector('.update-banner');
    if (ub.cls) bannerEl.classList.add(ub.cls);
    a.querySelector('.up-status').textContent = ub.text;
    a.querySelector('.up-time').textContent = ub.sub;
    if (updateState === 'available') {
      bannerEl.setAttribute('role', 'button');
      bannerEl.addEventListener('click', installUpdate);
    }
    main.append(a);
  }

  visibleSections.forEach((sec) => {
    const grp = el('section', 'sec');
    grp.append(sectionHead(sec.id, sec.title, sec.visibleRows.length));
    const body = el('div', 'sec-body');
    sec.visibleRows.forEach((r) => body.append(renderRow(r)));
    grp.append(body);
    main.append(grp);
  });

  if (hasQuickActionsGroup) {
    renderQuickActionTilesGroup(main);
  }

  main.scrollTop = resetScroll ? 0 : keep;
}

// ---------- actions ----------
function askConfirm(title, message, okLabel = 'OK', cancelLabel = 'Cancel') {
  return new Promise((resolve) => {
    const back = el('div', 'dlg-back');
    const box = el('div', 'dlg');
    const h = el('div', 'dlg-title'); h.textContent = title;
    const m = el('div', 'dlg-msg'); m.textContent = message;
    const row = el('div', 'dlg-actions');
    const no = el('button', 'dlg-btn'); no.textContent = cancelLabel;
    const ok = el('button', 'dlg-btn primary'); ok.textContent = okLabel;
    row.append(no, ok); box.append(h, m, row); back.append(box);
    const done = (v) => { document.removeEventListener('keydown', onKey, true); back.remove(); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    no.onclick = () => done(false);
    ok.onclick = () => done(true);
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.querySelector('.win').append(back);
    ok.focus();
  });
}

async function resetAll() {
  if (!(await askConfirm('Reset settings', 'Reset all settings to defaults? Inex Island will restart.', 'Reset'))) return;
  S = JSON.parse(JSON.stringify(DEFAULTS));
  applySettingsTheme(S.general.settingsTheme);
  save(S); invoke('set_autostart', { on: false });
  renderPage(); toast('Settings reset');
  setTimeout(() => invoke('restart_app'), 600);
}

function exportSettings() {
  const exportData = JSON.parse(JSON.stringify(S));
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'inex-island-settings.json';
  document.body.append(a); a.click(); a.remove(); toast('Settings exported');
}

function importSettings() {
  const inp = el('input'); inp.type = 'file'; inp.accept = 'application/json';
  inp.addEventListener('change', async () => {
    try {
      const data = JSON.parse(await inp.files[0].text());
      localStorage.setItem('inex.settings.v1', JSON.stringify(data));
      S = load();
      applySettingsTheme(S.general?.settingsTheme);
      save(S);
      renderPage();
      toast('Settings imported');
    } catch (_) { toast('That file is not a valid settings file'); }
  });
  inp.click();
}

// ---------- window ----------
function resetSettingsState() {
  renderPage(false);
}

document.getElementById('btn-close')?.addEventListener('click', () => {
  invoke('close_settings');
});

try {
  window.__TAURI__?.event?.listen('settings-opened', () => {
    S = load();
    renderPage(true);
  });
} catch (_) {}
document.getElementById('btn-reset-header')?.addEventListener('click', resetAll);
document.getElementById('titlebar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) return; invoke('drag_settings'); });
window.addEventListener('pointerup', () => { isDragging = false; });
document.querySelector('main')?.addEventListener('scroll', () => {
  document.querySelectorAll('.c-sel-menu:not(.hidden)').forEach(m => {
    m.classList.add('hidden');
    m.previousElementSibling?.classList.remove('open');
  });
}, { passive: true });
document.addEventListener('click', () => {
  document.querySelectorAll('.c-sel-menu:not(.hidden)').forEach(m => {
    m.classList.add('hidden');
    m.previousElementSibling?.classList.remove('open');
  });
});

subscribe((incoming) => {
  if (isSelfSaving || isDragging) return;
  if (JSON.stringify(incoming) !== JSON.stringify(S)) {
    S = incoming;
    applySettingsTheme(S.general?.settingsTheme);
    renderPage();
  }
});
invoke('get_autostart').then((on) => { if (typeof on === 'boolean' && on !== S.general.launchAtLogin) { S.general.launchAtLogin = on; renderPage(); } });
window.addEventListener('focus', () => renderPage());
renderNav();
renderPage(true);
