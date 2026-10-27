import { DEFAULTS, SLOT_OPTIONS, load, save, subscribe } from './shared.js';

const invoke = (cmd, args) => (window.__TAURI__?.core ? window.__TAURI__.core.invoke(cmd, args) : Promise.resolve(null));
let S = load();

// ---------- icons ----------
const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  palette: I('<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4a4 4 0 0 0 4-4C21.4 6 17.1 2 12 2z"/>'),
  notch: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'),
  layers: I('<path d="M12 2 2 7l10 5 10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
  power: I('<path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0"/>'),
  download: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  upload: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  battery: I('<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2M6 10v4"/>'),
  refresh: I('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>'),
  logout: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  music: I('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  bell: I('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  calendar: I('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  spark: I('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
  circle: I('<circle cx="12" cy="12" r="9"/>'),
  eq: I('<path d="M4 20V10M9 20V4M14 20v-8M19 20V7"/>'),
  cloud: I('<path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>'),
  pin: I('<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="3"/>'),
  widgets: I('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
  drop: I('<path d="M12 2.7s7 7.2 7 12.3a7 7 0 0 1-14 0c0-5.1 7-12.3 7-12.3z"/>'),
  sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  corner: I('<path d="M4 20V10a6 6 0 0 1 6-6h10"/>'),
  expand: I('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  monitor: I('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  bt: I('<path d="M6.5 6.5 17.5 17.5 12 23V1l5.5 5.5-11 11"/>'),
  mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  reset: I('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>'),
  border: I('<rect x="3" y="3" width="18" height="18" rx="4"/>'),
  font: I('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  github: I('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>'),
  check: I('<polyline points="20 6 9 17 4 12"/>')
};

// ---------- settings schema ----------
const WIDGET_OPTS = [['none', 'None'], ['weather', 'Weather'], ['ram', 'RAM'], ['cpu', 'CPU'], ['battery', 'Battery'], ['disk', 'Disk']];
const FONT_OPTS = [
  ['jakarta', 'Plus Jakarta Sans (Modern Clean)'],
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
const GLOW_SWATCHES = ['#ffffff', '#dc143c', '#38bdf8', '#22c55e', '#a855f7', '#f59e0b'];

const PAGES = [
  { id: 'notch', label: 'Notch', icon: 'notch', sections: [
    { title: 'Design & Shape', rows: [
      { path: 'notch.style', type: 'seg', icon: 'notch', t: 'Notch Style', d: 'Mac Notch touches top bezel; Floating Island floats below with all rounded corners', options: [['attached', 'Mac Notch'], ['floating', 'Floating Island']] },
      { path: 'notch.mode', type: 'seg', icon: 'notch', t: 'Behavior', d: 'Smart hides on fullscreen, Fixed stays, Ghost is glass outline', options: [['smart', 'Smart'], ['fixed', 'Fixed'], ['ghost', 'Ghost']] },
      { path: 'appearance.notchColor', type: 'color', icon: 'palette', t: 'Color', d: 'Background colour of the collapsed notch' },
      { path: 'appearance.notchOpacity', type: 'range', icon: 'drop', t: 'Opacity', d: 'Solid or translucent notch', min: 30, max: 100, step: 5, unit: '%' },
      { path: 'appearance.cornerRadius', type: 'range', icon: 'corner', t: 'Corner Roundness', d: 'Curvature of the notch and menus', min: 6, max: 26, step: 1, unit: 'px' }
    ] },
    { title: 'Music & Visualizer', rows: [
      { path: 'notch.musicMode', type: 'toggle', icon: 'music', t: 'Music Mode', d: 'Live interactive music widget' },
      { path: 'notch.compactMode', type: 'toggle', icon: 'expand', t: 'Compact Wave', d: 'Show wave & thumbnail when collapsed', showIf: (s) => s.notch.musicMode },
      { path: 'notch.compactGlow', type: 'toggle', icon: 'circle', t: 'Artwork Glow', d: 'Glow around collapsed artwork', showIf: (s) => s.notch.musicMode },
      { path: 'notch.ambientGlow', type: 'toggle', icon: 'spark', t: 'Ambient Glow', d: 'Dynamic album-coloured glow behind expanded player', showIf: (s) => s.notch.musicMode },
      { path: 'notch.eqSync', type: 'toggle', icon: 'eq', t: 'Sync with Sound', d: 'Bars react to real computer audio output', showIf: (s) => s.notch.musicMode },
      { path: 'notch.eqSensitivity', type: 'range', icon: 'eq', t: 'Sensitivity', d: 'Higher = reacts to quieter volume', min: 50, max: 300, step: 10, unit: '%', showIf: (s) => s.notch.musicMode && s.notch.eqSync }
    ] },
    { title: 'Widgets & Productivity', rows: [
      { path: 'notch.calendarTimer', type: 'toggle', icon: 'calendar', t: 'Calendar & Timer', d: 'Productivity split-view on time click' },
      { path: 'notch.timerSound', type: 'toggle', icon: 'bell', t: 'Timer Chime', d: 'Gentle sound when timer finishes', showIf: (s) => s.notch.calendarTimer },
      { path: 'widgets.left', type: 'select', icon: 'widgets', t: 'Left Hover Widget', d: 'Shown on the left on notch hover', options: WIDGET_OPTS },
      { path: 'widgets.right', type: 'select', icon: 'widgets', t: 'Right Hover Widget', d: 'Shown on the right on notch hover', options: WIDGET_OPTS },
      { path: 'weather.enabled', type: 'toggle', icon: 'cloud', t: 'Live Weather', d: 'Show real-time local weather' },
      { path: 'weather.unit', type: 'seg', icon: 'sun', t: 'Unit', d: 'Celsius or Fahrenheit', options: [['C', '°C'], ['F', '°F']], showIf: (s) => s.weather.enabled }
    ] }
  ] },

  { id: 'menu', label: 'Menu', icon: 'layers', sections: [
    { title: 'Appearance', rows: [
      { path: 'appearance.menuStyle', type: 'seg', icon: 'layers', t: 'Style', d: 'Transparent blurred glass or solid contrast color', options: [['transparent', 'Transparent Glass'], ['color', 'Solid Color']] },
      { path: 'appearance.menuColor', type: 'color', icon: 'palette', t: 'Background', d: 'Panel colour in solid mode', showIf: (s) => s.appearance.menuStyle === 'color' },
      { path: 'appearance.menuOpacity', type: 'range', icon: 'drop', t: 'Glass Transparency', d: 'Lower = more see-through blur', min: 20, max: 100, step: 5, unit: '%', showIf: (s) => s.appearance.menuStyle === 'color' },
      { path: 'appearance.borderColor', type: 'color', icon: 'border', t: 'Border Outline', d: 'Color of the menu borders' },
      { path: 'appearance.borderOpacity', type: 'range', icon: 'drop', t: 'Border Strength', d: 'Outline visibility', min: 10, max: 100, step: 5, unit: '%' },
      { path: 'appearance.glowColor', type: 'color', icon: 'spark', t: 'Active Glow', d: 'Accent outline on active switches and sliders', swatches: GLOW_SWATCHES }
    ] },
    { title: '2x2 Slots', rows: [
      { path: 'slots.a', type: 'select', icon: 'widgets', t: 'Slot 1 (Top-Left)', d: 'Default is Wi-Fi. Inactive backends power down', options: SLOT_OPTIONS, onChange: slotChange('b') },
      { path: 'slots.b', type: 'select', icon: 'widgets', t: 'Slot 2 (Bottom-Left)', d: 'Default is Bluetooth. Pair devices or notepad', options: SLOT_OPTIONS, onChange: slotChange('a') }
    ] },
    { title: 'Motion', rows: [
      { path: 'appearance.animations', type: 'toggle', icon: 'spark', t: 'Micro-Interactions', d: 'Haptic button scaling, spring transitions & glass highlights' }
    ] }
  ] },

  { id: 'style', label: 'Style', icon: 'palette', sections: [
    { title: 'Typography & Scale', rows: [
      { path: 'appearance.fontStyle', type: 'select', icon: 'font', t: 'Font Family', d: 'Curated modern typefaces applied across the island', options: FONT_OPTS },
      { path: 'appearance.scale', type: 'range', icon: 'expand', t: 'UI Scale', d: 'Smoothly scales entire island interface and fonts', min: 80, max: 140, step: 5, unit: '%' }
    ] }
  ] },

  { id: 'connect', label: 'Connect', icon: 'bt', sections: [
    { title: 'Devices & Share', rows: [
      { path: 'overlays.btBattery', type: 'toggle', icon: 'bt', t: 'Bluetooth Battery', d: 'Show battery % on connected Bluetooth headphones' },
      { path: 'share.deviceName', type: 'text', icon: 'monitor', t: 'Device Name', d: 'Name when discovering nearby PCs via P2P Link', placeholder: 'My PC' }
    ] }
  ] },

  { id: 'firebase', label: 'Firebase', icon: 'cloud', firebase: true, sections: [] },

  { id: 'system', label: 'System', icon: 'gear', sections: [
    { title: 'Startup & Alerts', rows: [
      { path: 'general.launchAtLogin', type: 'toggle', icon: 'power', t: 'Launch at Login', d: 'Start Inex Island automatically with Windows', onChange: (v) => invoke('set_autostart', { on: v }) },
      { path: 'general.autoUpdate', type: 'toggle', icon: 'spark', t: 'Auto Update', d: 'Automatically check and notify for updates' },
      { path: 'general.hour24', type: 'toggle', icon: 'clock', t: '24-Hour Time', d: 'Display military 24-hour time' },
      { path: 'general.lockToast', type: 'toggle', icon: 'power', t: 'Unlock Animation', d: 'Reveal animation after Windows unlock' },
      { path: 'general.chargeToast', type: 'toggle', icon: 'battery', t: 'Charger Notification', d: 'Island popup when laptop charger is connected' },
      { path: 'general.lowBatteryAlert', type: 'toggle', icon: 'battery', t: 'Low Battery Alert', d: 'Alert when PC reaches low battery threshold' },
      { path: 'general.lowBattery', type: 'range', icon: 'battery', t: 'Alert Level', d: 'Threshold to trigger low battery warning', min: 5, max: 50, step: 5, unit: '%', showIf: (s) => s.general.lowBatteryAlert }
    ] },
    { title: 'App Maintenance', rows: [
      { type: 'action', icon: 'reset', t: 'Reset to Defaults', d: 'Restore all factory settings and reboot Inex Island', danger: true, run: resetAll },
      { type: 'action', icon: 'refresh', t: 'Restart Inex Island', d: 'Reinitialize island window and system listeners', run: () => invoke('restart_app') },
      { type: 'action', icon: 'logout', t: 'Quit Inex Island', d: 'Completely exit application', danger: true, run: () => invoke('quit_app') }
    ] }
  ] },

  { id: 'about', label: 'About', icon: 'info', about: true, sections: [
    { title: 'Updates & Developer', rows: [
      { type: 'action', icon: 'refresh', t: 'Check for Updates', d: 'Check GitHub releases for the latest version', run: checkUpdatesAction },
      { type: 'action', icon: 'github', t: 'Developer Profile', d: 'https://github.com/inrwxyz', run: () => openExternalUrl('https://github.com/inrwxyz') }
    ] }
  ] }
];

// ---------- helpers ----------
const get = (path) => path.split('.').reduce((o, k) => o[k], S);
function set(path, value) {
  const keys = path.split('.'); const last = keys.pop();
  keys.reduce((o, k) => o[k], S)[last] = value;
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
// Two control-panel slots can never hold the same item: picking one that the other slot has swaps them.
function slotChange(other) {
  return (v, prev) => {
    if (S.slots[other] === v) { S.slots[other] = prev; save(S); }
    renderPage();
  };
}

// ---------- detected weather location (written by the island window) ----------
function detectedPlaceText() {
  try {
    const d = JSON.parse(localStorage.getItem('inex.weather.place') || 'null');
    if (!d) return 'Detecting…';
    if (d.src === 'none') return 'Not found (turn on Windows Location)';
    return d.place || 'Unknown place';
  } catch (_) { return 'Detecting…'; }
}

// ---------- row renderers ----------
function control(row) {
  const v = row.path ? get(row.path) : null;
  const wrap = el('div', 'ctl');
  const change = (nv, rerender = true) => { commit(row.path, nv, row.onChange); if (rerender) renderPage(); };

  if (row.type === 'toggle') {
    const b = el('button', 'sw' + (v ? ' on' : ''));
    b.addEventListener('click', () => change(!get(row.path)));
    wrap.append(b);
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
    const sel = el('select', 'sel');
    row.options.forEach(([val, label]) => { const o = el('option', '', label); o.value = val; if (val === v) o.selected = true; sel.append(o); });
    sel.addEventListener('change', () => change(sel.value, true));
    wrap.append(sel);
  } else if (row.type === 'text') {
    const inp = el('input', 'txtin'); inp.type = 'text'; inp.value = v || ''; inp.placeholder = row.placeholder || '';
    inp.addEventListener('input', () => {
      set(row.path, inp.value.trim());
      if (row.path === 'share.deviceName') {
        localStorage.setItem('island_pc_name', inp.value.trim());
      }
      save(S);
    });
    inp.addEventListener('change', () => {
      if (row.path === 'share.deviceName') {
        localStorage.setItem('island_pc_name', inp.value.trim());
      }
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
    const hex = el('span', 'hex', v.toUpperCase());
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
  const r = el('div', 'row' + (row.danger ? ' danger' : '') + (row.type === 'action' ? ' click' : ''));
  if (row.actionId) r.dataset.action = row.actionId;
  r.append(el('div', 'ico-box', ICON[row.icon] || ''));
  const title = typeof row.t === 'function' ? row.t() : row.t;
  const desc = typeof row.d === 'function' ? row.d() : (row.d || '');
  const txt = el('div', 'txt'); txt.append(el('div', 't', title), el('div', 'd', desc)); r.append(txt);
  if (row.type === 'action') {
    r.addEventListener('click', row.run);
  }
  else if (row.type === 'info') {
    const wrap = el('div', 'ctl');
    const val = el('input', 'txtin'); val.type = 'text'; val.readOnly = true; val.value = row.value();
    wrap.append(val);
    if (row.value().startsWith('Not found')) {
      const b2 = el('button', 'sel', 'Open Location settings');
      b2.style.cssText = 'color:#f5f5f7;cursor:pointer;min-width:auto;white-space:nowrap';
      b2.addEventListener('click', () => invoke('open_location_settings'));
      wrap.append(b2);
    }
    r.append(wrap);
  }
  else r.append(control(row));
  return r;
}

// ---------- pages ----------
let current = 'notch';

let updateStatusMsg = localStorage.getItem('inex.update.status') || 'Inex Island is up to date (v0.2.0)';
let updateCheckTime = localStorage.getItem('inex.update.time') || 'Checked today';

let isUpdating = false;
async function checkUpdatesAction() {
  if (isUpdating) return;
  toast('Checking for updates...');
  try {
    const res = await fetch('https://api.github.com/repos/inrwxyz/inex-island/releases/latest', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      const latestTag = data.tag_name || data.name || '';
      if (latestTag && latestTag !== 'v0.2.0' && latestTag !== '0.2.0') {
        updateStatusMsg = `Downloading & installing ${latestTag}...`;
        toast(`Found ${latestTag}! Downloading update...`);
        renderPage();
        isUpdating = true;
        try {
          const installed = await invoke('apply_update');
          if (installed) {
            updateStatusMsg = `Update ${latestTag} installed! Restarting...`;
            toast('Update complete! Restarting Inex Island...');
            renderPage();
            setTimeout(() => invoke('restart_app'), 1500);
            return;
          }
        } catch (err) {
          console.warn('Update failed:', err);
        } finally {
          isUpdating = false;
        }
      }
    }
  } catch (_) {}
  updateStatusMsg = 'Inex Island is up to date (v0.2.0)';
  toast('You are on the latest version!');
  const now = new Date();
  updateCheckTime = `Checked ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  localStorage.setItem('inex.update.status', updateStatusMsg);
  localStorage.setItem('inex.update.time', updateCheckTime);
  renderPage();
}

function openExternalUrl(url) {
  invoke('open_url', { url });
}

function renderNav() {
  const nav = document.getElementById('nav'); nav.innerHTML = '';
  PAGES.forEach((p) => {
    const b = el('button', p.id === current ? 'on' : '', ICON[p.icon] + `<span>${p.label}</span>`);
    b.addEventListener('click', () => {
      current = p.id;
      renderNav();
      renderPage(true);
    });
    nav.append(b);
  });
}
function renderPage(resetScroll) {
  const main = document.getElementById('page');
  const keep = main.scrollTop;
  main.innerHTML = '';
  const page = PAGES.find((p) => p.id === current);
  if (page.firebase) {
    const isCustom = !!(S.share && S.share.firebaseUrl);
    const rulesJson = '{\\n  \\"rules\\": {\\n    \\"rooms\\": {\\n      \\"$roomCode\\": {\\n        \\".read\\": true,\\n        \\".write\\": true\\n      }\\n    }\\n  }\\n}';
    const rulesFormatted = '{\n  "rules": {\n    "rooms": {\n      "$roomCode": {\n        ".read": true,\n        ".write": true\n      }\n    }\n  }\n}';
    const fb = el('div', 'firebase-page');
    fb.innerHTML = `
      <div class="firebase-banner">
        <div class="fb-icon-box">${ICON.cloud}</div>
        <div class="fb-info">
          <div class="fb-title-wrap">
            <span class="fb-title">Firebase Signaling</span>
            <span class="pill ${isCustom ? 'pill-purple' : 'pill-green'}">${isCustom ? 'Custom Database' : 'Official Server'}</span>
          </div>
          <div class="fb-sub">Encrypted WebRTC P2P signaling backend. Files are transferred directly between devices.</div>
        </div>
      </div>

      <div class="sec-title">Signaling Connection</div>
      <div class="card">
        <div class="row">
          <div class="ico-box">${ICON.pin}</div>
          <div class="txt">
            <div class="t">Active Database</div>
            <div class="d">${isCustom ? 'Active private Firebase instance' : 'No Firebase URL set (configure below)'}</div>
          </div>
          <div class="ctl">
            <div class="url-masked-pill" title="Protected & Hidden">
              <span class="masked-dots">••••••••••••••••••••••••</span>
              <span class="lock-tag">${isCustom ? 'Configured' : 'Not Set'}</span>
            </div>
          </div>
        </div>

        <div class="row">
          <div class="ico-box">${ICON.spark}</div>
          <div class="txt">
            <div class="t">Database URL</div>
            <div class="d">Paste your private Firebase Realtime Database URL</div>
          </div>
          <div class="ctl">
            <div class="fb-input-wrap">
              <input type="password" id="inp-custom-firebase" class="txtin" placeholder="https://your-db.asia-southeast1.firebasedatabase.app" />
              <button id="btn-save-custom-fb" class="btn btn-save-fb">Save</button>
            </div>
          </div>
        </div>

        ${isCustom ? `
        <div class="row click" id="row-reset-fb">
          <div class="ico-box">${ICON.reset}</div>
          <div class="txt">
            <div class="t" style="color: #f4f4f6;">Clear Database URL</div>
            <div class="d">Remove saved Firebase Realtime Database URL</div>
          </div>
          <div class="ctl">
            <button class="btn btn-outline" id="btn-revert-fb">Clear URL</button>
          </div>
        </div>` : ''}
      </div>

      <div class="sec-title">Setup Instructions</div>
      <div class="card fb-guide-card">
        <div class="fb-guide-steps">
          <div class="guide-step">
            <span class="step-num">1</span>
            <div class="step-text">
              Go to <button class="link-btn" id="btn-fb-console-link">Firebase Console ↗</button> and click <b>Add project</b> (Free Spark plan).
            </div>
          </div>
          <div class="guide-step">
            <span class="step-num">2</span>
            <div class="step-text">
              In the sidebar, navigate to <b>Build &gt; Realtime Database</b> and click <b>Create Database</b>.
            </div>
          </div>
          <div class="guide-step">
            <span class="step-num">3</span>
            <div class="step-text">
              Under the <b>Rules</b> tab, replace everything with the Security Rules below and click <b>Publish</b>.
            </div>
          </div>
          <div class="guide-step">
            <span class="step-num">4</span>
            <div class="step-text">
              Copy your database URL (e.g. <code>https://your-db.asia-southeast1.firebasedatabase.app</code>) and paste it into <b>Replace Database URL</b> above.
            </div>
          </div>
        </div>
      </div>

      <div class="sec-title">Firebase Security Rules</div>
      <div class="card fb-rules-card">
        <div class="fb-rules-header">
          <span class="rules-badge">Database Rules (JSON)</span>
          <button id="btn-copy-rules" class="btn-copy-rules">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span id="copy-rules-txt">Copy Rules</span>
          </button>
        </div>
        <pre class="fb-rules-code"><code>{\n  "rules": {\n    "rooms": {\n      "$roomCode": {\n        ".read": true,\n        ".write": true\n      }\n    }\n  }\n}</code></pre>
      </div>
    `;

    main.append(fb);

    const saveBtn = fb.querySelector('#btn-save-custom-fb');
    const inp = fb.querySelector('#inp-custom-firebase');
    const saveUrl = () => {
      const val = (inp?.value || '').trim();
      if (!val) { toast('Please enter a Firebase URL'); return; }
      if (!val.startsWith('https://')) { toast('URL must begin with https://'); return; }
      if (!S.share) S.share = {};
      S.share.firebaseUrl = val;
      save(S);
      toast('Custom Firebase URL saved!');
      renderPage();
    };
    saveBtn?.addEventListener('click', saveUrl);
    inp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveUrl(); });

    const revertBtn = fb.querySelector('#btn-revert-fb');
    const revertRow = fb.querySelector('#row-reset-fb');
    const doRevert = () => {
      if (!S.share) S.share = {};
      S.share.firebaseUrl = '';
      save(S);
      toast('Cleared Firebase URL');
      renderPage();
    };
    revertBtn?.addEventListener('click', (e) => { e.stopPropagation(); doRevert(); });
    revertRow?.addEventListener('click', doRevert);

    fb.querySelector('#btn-fb-console-link')?.addEventListener('click', () => {
      openExternalUrl('https://console.firebase.google.com');
    });

    const copyBtn = fb.querySelector('#btn-copy-rules');
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rulesFormatted);
        toast('Firebase Rules copied to clipboard!');
        const txt = fb.querySelector('#copy-rules-txt');
        if (txt) {
          txt.textContent = '✓ Copied!';
          setTimeout(() => { if (txt) txt.textContent = 'Copy Rules'; }, 2000);
        }
      } catch (_) {
        toast('Failed to copy to clipboard');
      }
    });

    main.scrollTop = resetScroll ? 0 : keep;
    return;
  }

  if (page.about) {
    const a = el('div', 'about-minimal');
    a.innerHTML = `
      <div class="about-head">
        <img src="logo.svg" alt="Inex Island" class="about-icon" />
        <div class="about-title-wrap">
          <span class="about-title">Inex Island</span>
          <span class="pill pill-green">v0.2.0 Stable</span>
        </div>
      </div>
      <div class="update-banner">
        <div class="up-dot"></div>
        <div class="up-info">
          <div class="up-status">${updateStatusMsg}</div>
          <div class="up-time">${updateCheckTime}</div>
        </div>
      </div>
    `;
    main.append(a);
  }
  page.sections.filter((sec) => !sec.showIf || sec.showIf(S)).forEach((sec) => {
    const visible = sec.rows.filter((r) => !r.showIf || r.showIf(S));
    if (!visible.length) return;
    main.append(el('div', 'sec-title', sec.title));
    const card = el('div', 'card');
    visible.forEach((r) => card.append(renderRow(r)));
    main.append(card);
  });
  main.scrollTop = resetScroll ? 0 : keep;
}

// ---------- actions ----------
function resetAll() {
  if (!confirm('Reset all settings to defaults?')) return;
  S = JSON.parse(JSON.stringify(DEFAULTS));
  save(S); invoke('set_autostart', { on: false });
  renderPage(); toast('Settings reset');
  setTimeout(() => invoke('restart_app'), 600);
}
function exportSettings() {
  const exportData = JSON.parse(JSON.stringify(S));
  if (exportData.share && exportData.share.firebaseUrl) {
    delete exportData.share.firebaseUrl; // Protect private Firebase URL from being leaked in export
  }
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
      S = load(); save(S); renderPage(); toast('Settings imported');
    } catch (_) { toast('That file is not a valid settings file'); }
  });
  inp.click();
}

// ---------- window ----------
document.getElementById('btn-close').addEventListener('click', () => invoke('close_settings'));
document.getElementById('btn-reset-header')?.addEventListener('click', resetAll);
document.getElementById('titlebar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) return; invoke('drag_settings'); });
window.addEventListener('pointerup', () => { isDragging = false; });

subscribe((incoming) => {
  if (isSelfSaving || isDragging) return;
  if (JSON.stringify(incoming) !== JSON.stringify(S)) {
    S = incoming;
    renderPage();
  }
});
invoke('get_autostart').then((on) => { if (typeof on === 'boolean' && on !== S.general.launchAtLogin) { S.general.launchAtLogin = on; renderPage(); } });
window.addEventListener('focus', () => renderPage());
renderNav(); renderPage(true);