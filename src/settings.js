import { DEFAULTS, ALL_ACTION_TILES, DEFAULT_ACTION_TILES, MAX_ACTION_TILES, MAX_ALARMS, load, save, subscribe, loadAlarms, storeAlarms, parseCoords, reverseGeoName } from './shared.js';

const invoke = (cmd, args) => (window.__TAURI__?.core ? window.__TAURI__.core.invoke(cmd, args) : Promise.resolve(null));

function ensureDefaults(s) {
  if (!s || typeof s !== 'object') s = {};
  ['general', 'notch', 'appearance', 'widgets', 'weather', 'companion', 'wellness', 'sounds', 'prayer', 'overlays', 'deckMenu', 'menu', 'share'].forEach((k) => {
    if (!s[k] || typeof s[k] !== 'object') s[k] = {};
  });
  if (!s.prayer.masjid || typeof s.prayer.masjid !== 'object') s.prayer.masjid = { fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' };
  return s;
}

let S = ensureDefaults(load());

// ---------- navigation structure ----------
const NAV = [
  ['Island', [
    ['notch', 'Notch', 'ti-device-desktop', '#0a84ff'],
    ['menu', 'Menu', 'ti-layout-grid', '#8e5cf5'],
    ['music', 'Music', 'ti-music', '#ff375f'],
    ['widgets', 'Widgets', 'ti-cloud', '#32ade6']
  ]],
  ['Activities', [
    ['sounds', 'Sounds and time', 'ti-volume', '#ff453a'],
    ['connect', 'Connect', 'ti-bluetooth', '#30b0c7'],
    ['screentime', 'Screen time', 'ti-hourglass', '#ff9f0a']
  ]],
  ['App', [
    ['system', 'System', 'ti-settings', '#8e8e93'],
    ['about', 'About', 'ti-info-circle', '#64748b']
  ]]
];

// every font the island supports (keys match FONT_MAP in shared.js)
const FONT_OPTS = [
  ['matrix', 'Doto (Dot Matrix Display)'],
  ['spacemono', 'Space Mono (Technical Mono)'],
  ['mono', 'JetBrains Mono (Developer Code)'],
  ['inter', 'Inter (Crisp & Minimal)'],
  ['poppins', 'Poppins (Geometric & Vibrant)'],
  ['outfit', 'Outfit (Friendly & Rounded)'],
  ['space', 'Space Grotesk (Tech & Brutalist)'],
  ['montserrat', 'Montserrat (Classic & Elegant)'],
  ['lexend', 'Lexend (Ultra-Readable)'],
  ['syne', 'Syne (Futuristic & Expressive)'],
  ['raleway', 'Raleway (Stylish & Sleek)'],
  ['jakarta', 'Plus Jakarta Sans'],
  ['system', 'Windows Segoe UI (Native)']
];

const WIDGET_OPTS = [
  ['weather', 'Weather'], ['cpu', 'CPU %'], ['ram', 'RAM %'], ['gpu', 'GPU %'],
  ['disk', 'Disk %'], ['battery', 'Battery %'], ['net', 'Net speed']
];

// symbol, label (same presets the Markets widget uses)
const MARKET_PRESETS = [
  ['BTC-USD', 'Bitcoin (BTC)'], ['ETH-USD', 'Ethereum (ETH)'], ['SOL-USD', 'Solana (SOL)'],
  ['^NSEI', 'NIFTY 50'], ['^BSESN', 'SENSEX'], ['^GSPC', 'S&P 500'], ['^IXIC', 'NASDAQ'], ['^DJI', 'DOW'],
  ['TSLA', 'Tesla (TSLA)'], ['AAPL', 'Apple (AAPL)'], ['NVDA', 'NVIDIA (NVDA)'], ['MSFT', 'Microsoft (MSFT)'],
  ['GOOGL', 'Alphabet (GOOGL)'], ['AMZN', 'Amazon (AMZN)'], ['GC=F', 'Gold']
];

const SKINS = [
  ['eyes', 'Cyber Eyes (Original)', '◉ ◉', '#2db8a6'],
  ['orbs', 'Round Eyes', '● ●', '#ffffff'],
  ['slits', 'Slit Eyes', '▮ ▮', '#ffb02e'],
  ['visor', 'Visor', '▬▬', '#c040e0'],
  ['cat', '8-Bit Cat', '🐱', '#ff9f0a'],
  ['dots', 'Dots', '• • •', '#ffffff']
];

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function getPath(obj, path, def) {
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

function setPath(obj, path, val) {
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

// City box of the weather: a place name is kept as typed; a coordinate pair ("24.2741, 87.8230") is turned into
// the name of the place there, and the box shows that name while the coordinates are what the weather uses.
async function commitWeatherCity(input, text) {
  const c = parseCoords(text);
  if (!c) {
    setPath(S, 'weather.lat', null);
    setPath(S, 'weather.lon', null);
    commit('weather.city', text);
    return;
  }
  const idle = input.placeholder;
  input.placeholder = 'Finding place…';
  const hit = await reverseGeoName(c.lat, c.lon);
  input.placeholder = idle;
  const name = hit ? hit.name : `${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`;
  input.value = name;
  setPath(S, 'weather.lat', c.lat);
  setPath(S, 'weather.lon', c.lon);
  commit('weather.city', name);
}

function commit(path, val) {
  setPath(S, path, val);
  if (path === 'companion.enabled') {
    if (!val && getPath(S, 'notch.compactContent') === 'pet') {
      setPath(S, 'notch.compactContent', 'clock');
    }
    const pn = document.getElementById('p-notch');
    if (pn) {
      const P = buildPages();
      pn.innerHTML = P.notch;
    }
  }
  save(S);
  if (typeof refreshPreviews === 'function') refreshPreviews();
}

// ---------- UI builders ----------
function sw(path, def) {
  const on = !!getPath(S, path, def);
  return `<div class="sw${on ? ' on' : ''}" data-path="${path}"></div>`;
}

function seg(path, opts, def) {
  const cur = getPath(S, path, def);
  return `<div class="seg" data-path="${path}">${opts.map(([v, l]) => `<b class="${v === cur ? 'on' : ''}" data-val="${v}">${l}</b>`).join('')}</div>`;
}

function pop(path, opts, def) {
  const cur = getPath(S, path, def);
  const found = opts.find(([v]) => String(v) === String(cur)) || opts[0] || [cur, cur];
  return `<div class="pw" data-path="${path}">
    <button class="pop" type="button">${found[1]} <i class="ti ti-selector" aria-hidden="true"></i></button>
    <div class="mn">${opts.map(([v, l]) => `<div class="mi${String(v) === String(cur) ? ' on' : ''}" data-val="${v}"><i class="ti ti-check" aria-hidden="true"></i>${l}</div>`).join('')}</div>
  </div>`;
}

function sl(path, min, max, unit, def) {
  const v = getPath(S, path, def);
  return `<div class="sl" data-path="${path}"><input type="range" min="${min}" max="${max}" value="${v}" data-u="${unit}"><span>${v}${unit}</span></div>`;
}

function tx(path, ph, w, extra) {
  return `<input class="tx" type="text" data-path="${path}" value="${esc(getPath(S, path, ''))}" placeholder="${esc(ph)}" style="width:${w}px" spellcheck="false" ${extra || ''}>`;
}

function btn(act, label, extra) {
  return `<button class="btn" type="button" data-act="${act}" ${extra || ''}>${label}</button>`;
}

function row(t, d, c, cls) {
  return `<div class="rw${cls ? ' ' + cls : ''}"><div class="t">${t}</div>${c || ''}</div>`;
}

// UI-only state (not saved): which collapsed blocks are open
const UI = { skinOpen: false, sndEdit: false, tilesEdit: false, prayerEdit: false, mkCustom: {} };

function card(rows) {
  return `<div class="gp">${rows.join('')}</div>`;
}

// ---------- live previews ----------
const FONT_CSS = {
  inter: 'Inter', outfit: 'Outfit', poppins: 'Poppins', jakarta: '"Plus Jakarta Sans"', mono: '"JetBrains Mono"',
  matrix: '"Doto","Space Mono"', spacemono: '"Space Mono"', space: '"Space Grotesk"', montserrat: 'Montserrat',
  lexend: 'Lexend', syne: 'Syne', raleway: 'Raleway', system: '"Segoe UI"'
};

function clockText() {
  const d = new Date();
  const h = S.general?.hour24 ? String(d.getHours()).padStart(2, '0') : String(d.getHours() % 12 || 12);
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function skinGlyph() {
  const k = getPath(S, 'companion.skin', 'eyes');
  const s = SKINS.find((x) => x[0] === k) || SKINS[0];
  return `<span style="color:${s[3]};font-size:11px;letter-spacing:1px">${s[2]}</span>`;
}

function pillStyle() {
  const col = getPath(S, 'appearance.notchColor', '#030305');
  const op = getPath(S, 'appearance.notchOpacity', 100) / 100;
  return `background:${col};opacity:${op}`;
}

const ic = (n, c) => `<i class="ti ti-${n}${c ? ' ' + c : ''}" aria-hidden="true"></i>`;

// w = real notch width in px; scalable previews follow the UI scale, status popups stay fixed
function pill(inner, cls, w, scalable, extra) {
  const st = getPath(S, 'notch.style', 'curved');
  const width = w ? `;width:${scalable ? `calc(${w}px*var(--sc))` : `${w}px`}` : '';
  return `<div class="pill ${st} ${cls || ''}" style="${pillStyle()}${width}${extra ? ';' + extra : ''}">${inner}</div>`;
}

function stage(inner) {
  const sc = (getPath(S, 'appearance.scale', 125) / 110).toFixed(3);
  return `<div class="pv" style="--sc:${sc}">${inner}</div>`;
}

function hud(icon, tone, name, tag, ring) {
  const r = ring ? `<span class="hd-ring ${tone}"></span>` : '';
  return pill(`<span class="hd-l">${ic(icon, 'hd-ic ' + tone)}<span class="hd-t"><b>${name}</b><small>${tag}</small></span></span>${r}`, 'hud', 220);
}

function lockCard() {
  const glyph = `<span class="lk-g">
    <svg class="lk-scan" viewBox="0 0 44 44" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15v-4a6 6 0 0 1 6-6h4"/><path d="M39 15v-4a6 6 0 0 0-6-6h-4"/><path d="M5 29v4a6 6 0 0 0 6 6h4"/><path d="M39 29v4a6 6 0 0 1-6 6h-4"/><rect x="14" y="14" width="16" height="16" rx="5"/><rect class="lk-bar" x="9" y="9" width="26" height="2.2" rx="1.1" fill="#fff" stroke="none"/></svg>
    <svg class="lk-ok" viewBox="0 0 44 44" fill="none"><circle class="fc" cx="22" cy="22" r="17" fill="rgba(48,209,88,0.16)"/><circle class="ring" cx="22" cy="22" r="17" stroke="#30d158" stroke-width="2.4" stroke-linecap="round" transform="rotate(-90 22 22)"/><path class="tick" d="M14 22.5l6 6 11-12.5" stroke="#30d158" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </span><b class="lk-lbl">Unlocked</b>`;
  return pill(glyph, 'lock', 92);
}

const WIDGET_SAMPLE = { cpu: 'CPU 23%', ram: 'RAM 41%', gpu: 'GPU 18%', disk: 'Disk 63%', battery: '82%', net: '↓1.2 ↑0.3' };

const PV = {
  notch() {
    const compOn = !!getPath(S, 'companion.enabled', false);
    let c = getPath(S, 'notch.compactContent', 'clock');
    if (c === 'pet' && !compOn) c = 'clock';
    const chip = { weather: ic('sun') + '28°', cpu: ic('activity') + '23%', ram: ic('cpu') + '41%', battery: ic('battery-3') + '82%' };
    let inner = clockText();
    if (c === 'pet') inner = skinGlyph();
    else if (chip[c]) inner = `<span class="chip">${chip[c]}</span>`;
    return stage(pill(inner, '', 156, true));
  },
  type() {
    const f = FONT_CSS[getPath(S, 'appearance.fontStyle', 'mono')] || 'Inter';
    const sc = getPath(S, 'appearance.scale', 125) / 110;
    return stage(pill(`Inex Island ${clockText()}`, '', 0, true, `font-family:${f},system-ui,sans-serif;font-size:${(12 * sc).toFixed(1)}px`));
  },
  music() {
    const on = getPath(S, 'notch.musicMode', true), cm = getPath(S, 'notch.compactMode', true);
    const glow = getPath(S, 'notch.compactGlow', true) ? ' glow' : '';
    if (!(on && cm)) return stage(pill(clockText(), '', 156, true));
    return stage(pill(`<span class="art${glow}"></span><span>${clockText()}</span><span class="eq"><i></i><i></i><i></i><i></i><i></i></span>`, 'sp', 192, true));
  },
  hover() {
    const on = getPath(S, 'widgets.enabled', true);
    if (!on) return stage(pill(clockText(), '', 156, true));
    const f = getPath(S, 'weather.unit', 'C') === 'F';
    const wxOn = getPath(S, 'weather.enabled', true);
    const side = (k) => {
      if (k === 'weather') return wxOn ? f ? '82°F' : '28°C' : '';
      return WIDGET_SAMPLE[k] || '';
    };
    const l = side(getPath(S, 'widgets.left', 'weather'));
    const r = side(getPath(S, 'widgets.right', 'ram'));
    const dot = getPath(S, 'overlays.privacyDot', true) ? '<span class="pd"></span>' : '';
    return stage(pill(`<span class="side-l"><span class="dim">${l}</span>${dot}</span><span>${clockText()}</span><span class="dim">${r}</span>`, 'sp', 256, true));
  },
  pet() {
    const on = getPath(S, 'companion.enabled', false);
    return stage(pill(on ? skinGlyph() : clockText(), '', 156, true));
  },
  health() {
    const on = getPath(S, 'wellness.enabled', false);
    const w = getPath(S, 'wellness.water', true), e = getPath(S, 'wellness.eye', true), s = getPath(S, 'wellness.stretch', true);
    if (!on || !(w || e || s)) return stage(pill(clockText(), '', 156, true));
    if (w) return stage(hud('droplet', 'tone-w', 'Time for a sip!', 'Stay hydrated'));
    if (e) return stage(hud('eye', 'tone-e', 'Rest your eyes', 'Look 20 ft away'));
    return stage(hud('stretching', 'tone-s', 'Time to stretch', 'Stand up, roll your shoulders'));
  },
  popups() {
    const lv = getPath(S, 'general.lowBattery', 20);
    const items = [];
    if (getPath(S, 'general.lockToast', true)) items.push(lockCard());
    if (getPath(S, 'general.copyToast', false)) items.push(hud('clipboard', 'tone-n', 'Copied', 'Text copied'));
    if (getPath(S, 'general.chargeToast', false)) items.push(hud('bolt', 'tone-g', 'Charging', '82% • Power', true));
    if (getPath(S, 'general.lowBatteryAlert', false)) items.push(hud('battery-1', 'tone-r', 'Battery Low', `${lv}% Remaining`, true));
    return stage(items.join(''));
  },
  bt() {
    return stage(getPath(S, 'overlays.btBattery', true) ? hud('headphones', 'tone-g', 'Device', 'Connected', true) : '');
  },
  glass() {
    const g = getPath(S, 'appearance.menuStyle', 'color') === 'transparent';
    const bg = g ? 'rgba(255,255,255,.25);backdrop-filter:blur(14px)' : '#1c1c1e';
    return stage(`<div class="pill gl" style="background:${bg};color:${g ? '#fff' : '#eee'}">${g ? 'Transparent glass' : 'Solid colour'}</div>`);
  },
  color() {
    return stage(pill(clockText(), '', 156, true));
  }
};

function pv(key) { return `<div data-pv="${key}" style="display:contents">${PV[key]()}</div>`; }

function refreshPreviews() {
  document.querySelectorAll('[data-pv]').forEach((el) => {
    if (el.firstElementChild?.matches(':hover')) return;
    el.innerHTML = PV[el.dataset.pv]?.() || '';
  });
}

// section = label + live preview + card of rows
function sec(title, key, rows) {
  return `<div class="lb">${title}</div>${key ? pv(key) : ''}${card(rows)}`;
}

// ---------- alarms (real store shared with the island: inex.alarms.v1) ----------
const AP = { h: 7, m: 30, daily: false };

function fmtAlarm(h, m) {
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function alarmBoxHtml() {
  const list = loadAlarms();
  const h12 = AP.h % 12 || 12;
  const rows = list.length
    ? list.map((a) => `<div class="rw"><div class="t">${fmtAlarm(a.h, a.m)} · ${a.daily ? 'Daily' : 'Once'}</div>
        <div class="sw${a.on ? ' on' : ''}" data-al="toggle" data-id="${esc(a.id)}"></div>
        <div class="xb" data-al="del" data-id="${esc(a.id)}" title="Delete"><i class="ti ti-x" aria-hidden="true"></i></div></div>`).join('')
    : `<div class="rw"><div class="t" style="color:var(--faint)">No alarms yet</div></div>`;
  return `<div class="gp">${rows}</div>
    <div class="gp"><div class="rw"><div class="t">New alarm</div>
      <div class="st"><b data-al="h-">−</b><span style="min-width:30px">${String(h12).padStart(2, '0')}</span><b data-al="h+">+</b></div>
      <div class="st"><b data-al="m-">−</b><span style="min-width:30px">${String(AP.m).padStart(2, '0')}</span><b data-al="m+">+</b></div>
      <div class="seg"><b class="${AP.h < 12 ? 'on' : ''}" data-al="am">AM</b><b class="${AP.h >= 12 ? 'on' : ''}" data-al="pm">PM</b></div>
    </div>
    <div class="rw"><div class="t">Repeat daily</div><div class="sw${AP.daily ? ' on' : ''}" data-al="daily"></div>${btn('', 'Add alarm', 'data-al="add"')}</div></div>`;
}

function renderAlarmBox() {
  const el = document.getElementById('alarm-box');
  if (el) el.innerHTML = alarmBoxHtml();
}

function alarmAction(act, id) {
  let list = loadAlarms();
  if (act === 'toggle') list = list.map((a) => (a.id === id ? { ...a, on: !a.on } : a));
  else if (act === 'del') list = list.filter((a) => a.id !== id);
  else if (act === 'h+' || act === 'h-') {
    const h12 = AP.h % 12 || 12;
    const n = act === 'h+' ? (h12 % 12) + 1 : ((h12 + 10) % 12) + 1;
    AP.h = (n % 12) + (AP.h >= 12 ? 12 : 0);
    return renderAlarmBox();
  } else if (act === 'm+') { AP.m = (AP.m + 1) % 60; return renderAlarmBox(); }
  else if (act === 'm-') { AP.m = (AP.m + 59) % 60; return renderAlarmBox(); }
  else if (act === 'am') { AP.h = AP.h % 12; return renderAlarmBox(); }
  else if (act === 'pm') { AP.h = (AP.h % 12) + 12; return renderAlarmBox(); }
  else if (act === 'daily') { AP.daily = !AP.daily; return renderAlarmBox(); }
  else if (act === 'add') {
    if (list.length >= MAX_ALARMS) return;
    const dup = list.find((a) => a.h === AP.h && a.m === AP.m && !!a.daily === AP.daily);
    if (dup) dup.on = true;
    else list.push({ id: Date.now().toString(36), h: AP.h, m: AP.m, on: true, daily: AP.daily });
  }
  storeAlarms(list);
  renderAlarmBox();
}

// ---------- page definitions ----------
function skinName() {
  const k = getPath(S, 'companion.skin', 'eyes');
  return (SKINS.find((x) => x[0] === k) || SKINS[0])[1];
}

function skinGridHtml() {
  const cur = getPath(S, 'companion.skin', 'eyes');
  return `<div class="skg" data-path="companion.skin">${SKINS.map(([v, l, g, c]) =>
    `<div class="sk${v === cur ? ' on' : ''}" data-val="${v}"><div class="sg2" style="color:${c}">${g}</div><span>${l}</span></div>`).join('')}</div>`;
}

// ---------- Prayer times & location calculation ----------
function getSavedLocation() {
  try {
    const pl = JSON.parse(localStorage.getItem('inex.prayer.loc') || 'null');
    if (pl && pl.loc && isFinite(pl.loc.lat) && isFinite(pl.loc.lon)) return pl.loc;
    const wl = JSON.parse(localStorage.getItem('inex.loc') || 'null');
    if (wl && wl.loc && isFinite(wl.loc.lat) && isFinite(wl.loc.lon)) return wl.loc;
  } catch (_) {}
  return null;
}

function getCalculatedPrayerTimes(loc, hanafi) {
  if (!loc || !isFinite(loc.lat) || !isFinite(loc.lon)) return null;
  try {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const base = Date.UTC(y, m, d);
    const tzH = -now.getTimezoneOffset() / 60;
    const jdAt = (localH) => (base + (localH - tzH) * 3600000) / 86400000 + 2440587.5;
    const R = Math.PI / 180;
    const sunCalc = (jd) => {
      const n = jd - 2451545.0;
      const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360;
      const g = (((357.528 + 0.9856003 * n) % 360) + 360) % 360 * R;
      const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * R;
      const dec = Math.asin(Math.sin(23.439 * R) * Math.sin(lambda));
      let ra = Math.atan2(Math.cos(23.439 * R) * Math.sin(lambda), Math.cos(lambda)) / R;
      ra = (((ra % 360) + 360) % 360) / 15;
      const eqMin = (L / 15 - ra) * 60;
      return { dec, eqMin: eqMin > 20 ? eqMin - 1440 : eqMin < -20 ? eqMin + 1440 : eqMin };
    };
    const transit = (sp) => 12 + tzH - loc.lon / 15 - sp.eqMin / 60;
    let T = transit(sunCalc(jdAt(12)));
    T = transit(sunCalc(jdAt(T)));
    const ev = (alt, sign) => {
      let g = T;
      for (let k = 0; k < 3; k++) {
        const sp = sunCalc(jdAt(g));
        const a = alt === 'asr'
          ? Math.atan(1 / ((hanafi ? 2 : 1) + Math.tan(Math.abs(loc.lat - sp.dec / R) * R))) / R
          : alt;
        const cosH = (Math.sin(a * R) - Math.sin(loc.lat * R) * Math.sin(sp.dec)) / (Math.cos(loc.lat * R) * Math.cos(sp.dec));
        if (cosH < -1 || cosH > 1) return NaN;
        g = transit(sp) + sign * (Math.acos(cosH) / R / 15);
      }
      return g;
    };
    const pad = (n) => String(Math.floor(n)).padStart(2, '0');
    const toClock = (hours) => {
      if (isNaN(hours)) return '';
      let totalM = Math.round(hours * 60);
      let h = Math.floor(totalM / 60) % 24;
      let min = totalM % 60;
      return `${pad(h)}:${pad(min)}`;
    };
    return {
      fajr: toClock(ev(-18, -1)),
      dhuhr: toClock(T + 1 / 60),
      asr: toClock(ev('asr', 1)),
      maghrib: toClock(ev(-0.833, 1)),
      isha: toClock(ev(-18, 1))
    };
  } catch (_) { return null; }
}

async function fetchLiveIpLocation() {
  const tries = [
    async () => {
      const r = await fetch('https://ipwho.is/');
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.success !== false && d.latitude && d.longitude) ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '' } : null;
    },
    async () => {
      const r = await fetch('https://ipapi.co/json/');
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.latitude && d.longitude) ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '' } : null;
    },
    async () => {
      const r = await fetch('https://freeipapi.com/api/json');
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.latitude && d.longitude) ? { lat: +d.latitude, lon: +d.longitude, city: d.cityName || '' } : null;
    }
  ];
  for (const t of tries) {
    try {
      const res = await t();
      if (res && isFinite(res.lat) && isFinite(res.lon)) return res;
    } catch (_) {}
  }
  return null;
}

async function resolvePrayerLocation() {
  let loc = null;
  const city = String(S.prayer?.city || '').trim();
  if (city) {
    try {
      const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=en&format=json');
      if (res.ok) {
        const d = await res.json();
        if (d && d.results && d.results[0]) {
          const r = d.results[0];
          loc = { lat: +r.latitude, lon: +r.longitude, city: r.name || city };
        }
      }
    } catch (_) {}
  }
  if (!loc) loc = getSavedLocation();
  if (!loc) {
    loc = await fetchLiveIpLocation();
    if (loc) {
      try {
        localStorage.setItem('inex.prayer.loc', JSON.stringify({ mode: 'auto', loc: loc, at: Date.now() }));
        localStorage.setItem('inex.loc', JSON.stringify({ loc: loc, at: Date.now() }));
      } catch (_) {}
    }
  }
  return loc;
}

function updateMasjidInputs(times) {
  ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].forEach((k) => {
    const input = document.querySelector(`input[data-path="prayer.masjid.${k}"]`);
    if (input) input.value = (times && times[k]) || '';
  });
}

function updatePrayerCityUI(cityName) {
  const cityInput = document.querySelector(`input[data-path="prayer.city"]`);
  if (cityInput) {
    if (!cityInput.value) cityInput.placeholder = cityName || 'Auto-detect';
  }
}

async function resetMasjidToCalculated() {
  if (!S.prayer) S.prayer = {};
  const loc = await resolvePrayerLocation();
  if (loc && isFinite(loc.lat) && isFinite(loc.lon)) {
    const calc = getCalculatedPrayerTimes(loc, S.prayer.asrMethod === 'hanafi');
    if (calc) {
      S.prayer.masjid = {
        fajr: calc.fajr,
        dhuhr: calc.dhuhr,
        asr: calc.asr,
        maghrib: calc.maghrib,
        isha: calc.isha
      };
      save(S);
      try { localStorage.setItem('inex.prayer.refreshLoc', String(Date.now())); } catch (_) {}
      updateMasjidInputs(calc);
      if (loc.city) updatePrayerCityUI(loc.city);
      return;
    }
  }
  S.prayer.masjid = { fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' };
  save(S);
  updateMasjidInputs({ fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' });
}

function tileIconClass(icon) {
  const map = {
    sun: 'ti-sun',
    mic: 'ti-microphone',
    snip: 'ti-scissors',
    calendar: 'ti-calendar',
    clock: 'ti-clock',
    clipboard: 'ti-clipboard',
    lock: 'ti-lock',
    gear: 'ti-settings',
    calc: 'ti-calculator',
    refresh: 'ti-rotate-clockwise',
    notepad: 'ti-notes'
  };
  return map[icon] || ('ti-' + icon);
}

function tilePickerHtml() {
  return `<div id="qa-picker-box">${tilePickerInnerHtml()}</div>`;
}

function refreshTilePicker() {
  const box = document.getElementById('qa-picker-box');
  if (box) box.innerHTML = tilePickerInnerHtml();
}

function tilePickerInnerHtml() {
  const cur = Array.isArray(S.menu?.actionTiles) ? S.menu.actionTiles : DEFAULT_ACTION_TILES;
  const atMax = cur.length >= MAX_ACTION_TILES;
  const allTiles = Object.values(ALL_ACTION_TILES);
  const avail = allTiles.filter(t => !cur.includes(t.id));

  return `
    <div class="gp" style="margin-top:12px">
      <div class="rw" style="align-items:center;padding:10px 14px">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="qa-hdr-ico"><i class="ti ti-layout-grid" aria-hidden="true"></i></span>
          <div>
            <div class="t" style="font-weight:600;font-size:13px">Quick Action Tiles</div>
            <div class="d" style="font-size:11px;color:var(--faint)">${cur.length} / ${MAX_ACTION_TILES} tiles active. Tap Edit to add or remove</div>
          </div>
        </div>
        <button class="btn" data-act="tiles-toggle">${UI.tilesEdit ? 'Done' : 'Edit'}</button>
      </div>
      ${UI.tilesEdit ? `
        <div style="height:1px;background:var(--line);margin:0 14px"></div>
        <div class="qa-section">
          <div class="qa-sec-hdr">
            <b>Active Tiles (${cur.length} / ${MAX_ACTION_TILES})</b>
            <span>Click – to remove</span>
          </div>
          <div class="qa-grid">
            ${cur.map(id => {
              const t = ALL_ACTION_TILES[id];
              if (!t) return '';
              const ic = tileIconClass(t.icon);
              return `
                <div class="qa-tile active" data-tile-remove="${t.id}" title="Click to remove ${t.label}">
                  <span class="qa-badge minus"><i class="ti ti-minus" aria-hidden="true"></i></span>
                  <i class="ti ${ic} qa-icon" aria-hidden="true"></i>
                  <span class="qa-label">${t.label}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div class="qa-section" style="padding-top:4px">
          <div class="qa-sec-hdr">
            <b>Available Tiles</b>
            <span>${atMax ? 'Maximum ' + MAX_ACTION_TILES + ' tiles reached' : 'Click + to add'}</span>
          </div>
          <div class="qa-grid">
            ${avail.map(t => {
              const ic = tileIconClass(t.icon);
              return `
                <div class="qa-tile avail${atMax ? ' disabled' : ''}" ${atMax ? '' : `data-tile-add="${t.id}"`} title="${atMax ? 'Maximum tiles active' : `Click to add ${t.label}`}">
                  <span class="qa-badge plus"><i class="ti ti-plus" aria-hidden="true"></i></span>
                  <i class="ti ${ic} qa-icon" aria-hidden="true"></i>
                  <span class="qa-label">${t.label}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div class="qa-footer-note">Changes apply immediately to the island menu.</div>
      ` : ''}
    </div>
  `;
}

// Menu layout picker: true-to-scale miniatures (blueprints) of the two real menus, same proportions as the island.
function menuBlueprint(kind) {
  const BG = '#000', CARD = '#1c1c1e', CHIP = '#2c2c2e', LINE = '#48484a', DIM = '#6e6e73', MID = '#8e8e93', FG = '#f5f5f7';
  const r = (x, y, w, h, rx, f, extra) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${f}" ${extra || ''}/>`;
  const c = (x, y, rad, f, extra) => `<circle cx="${x}" cy="${y}" r="${rad}" fill="${f}" ${extra || ''}/>`;
  const ring = (x, y, rad, pct) => {
    const len = 2 * Math.PI * rad;
    return `<circle cx="${x}" cy="${y}" r="${rad}" fill="none" stroke="${LINE}" stroke-width="5"/>`
      + `<circle cx="${x}" cy="${y}" r="${rad}" fill="none" stroke="${FG}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(len * pct).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 ${x} ${y})"/>`;
  };
  const tile = (x, y, w, h, ico) => r(x, y, w, h, h / 2, CARD) + c(x + h / 2, y + h / 2, h * 0.33, CHIP)
    + r(x + h * 0.98, y + h * 0.3, w * 0.3, 8, 3, FG) + r(x + h * 0.98, y + h * 0.3 + 14, w * 0.17, 6, 3, DIM)
    + (ico ? `<path d="M${x + w - 18} ${y + h / 2 - 5}l5 5-5 5" fill="none" stroke="${MID}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : '');
  const slider = (x, y, w, h) => r(x, y, w, h, h / 2, FG) + c(x + h / 2 + 2, y + h / 2, h * 0.2, MID) + r(x + w - 46, y + h / 2 - 4, 30, 8, 3, MID);
  if (kind === 'deck') {
    let g = `<path d="M0 0H625V237A26 26 0 0 1 599 263H26A26 26 0 0 1 0 237Z" fill="${BG}"/>`;
    // top strip: time + date left, weather chip + switch pill + 5 round icons right
    g += r(16, 14, 62, 16, 3, FG) + r(86, 18, 54, 8, 3, DIM);
    g += c(334, 22, 6, '#fbbf24') + r(346, 17, 30, 10, 3, DIM);
    g += r(387, 8, 56, 28, 14, CHIP) + r(391, 11, 24, 22, 11, LINE);
    [465, 497, 530, 562, 595].forEach((x) => { g += c(x, 22, 9, CHIP); });
    // spotlight search card
    g += r(14, 45, 250, 125, 18, CARD) + r(26, 57, 226, 28, 10, CHIP) + c(40, 71, 5, MID) + r(52, 67, 60, 8, 3, DIM);
    [96, 120, 144].forEach((y) => { g += c(38, y + 4, 6, CHIP) + r(52, y, 70, 8, 3, FG); });
    // CPU / RAM card
    g += r(14, 178, 250, 70, 18, CARD) + ring(52, 213, 17, 0.06) + ring(172, 213, 19, 0.54) + r(139, 192, 1, 42, 0.5, LINE);
    g += r(80, 206, 30, 8, 3, FG) + r(206, 205, 30, 8, 3, FG) + r(206, 218, 38, 6, 3, DIM);
    // 2 x 2 tiles
    g += tile(276, 45, 163, 45, true) + tile(448, 45, 163, 45, true) + tile(276, 98, 163, 45, true) + tile(448, 98, 163, 45, false);
    // sliders
    g += slider(276, 152, 335, 28) + slider(276, 186, 335, 28);
    // quick action row (5)
    [276, 345, 414, 483, 551].forEach((x) => { g += r(x, 222, 60, 28, 14, CARD) + r(x + 25, 231, 10, 10, 2.5, 'none', `stroke="${MID}" stroke-width="1.8"`); });
    return `<svg viewBox="0 0 625 263" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${g}</svg>`;
  }
  // classic
  let g = `<path d="M0 0H390V332A28 28 0 0 1 362 360H28A28 28 0 0 1 0 332Z" fill="${BG}"/>`;
  g += r(18, 13, 40, 10, 3, MID) + r(178, 12, 46, 11, 3, FG) + r(332, 13, 40, 10, 3, MID);
  g += tile(19, 42, 170, 64, true) + tile(201, 42, 170, 64, true) + tile(19, 121, 170, 64, true) + tile(201, 121, 170, 64, false);
  [40, 92, 144, 195, 247, 298, 349].forEach((x) => { g += c(x, 219, 22, CARD) + r(x - 5, 214, 10, 10, 2.5, 'none', `stroke="${MID}" stroke-width="1.8"`); });
  g += slider(19, 252, 352, 38) + slider(19, 300, 352, 38);
  return `<svg viewBox="0 0 390 360" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${g}</svg>`;
}

function marketRow(label, path) {
  const def = path.endsWith('market2') ? '^NSEI' : 'BTC-USD';
  const cur = String(getPath(S, path, def) || def);
  const isPreset = MARKET_PRESETS.some(([sym]) => sym === cur);
  const custom = path in UI.mkCustom ? UI.mkCustom[path] : !isPreset;
  const opts = MARKET_PRESETS.concat([['__custom', 'Custom\u2026']]);
  const shown = custom ? '__custom' : cur;
  const found = opts.find(([v]) => v === shown) || opts[0];
  const dd = `<div class="pw mk" data-path="${path}">
    <button class="pop" type="button">${found[1]} <i class="ti ti-selector" aria-hidden="true"></i></button>
    <div class="mn">${opts.map(([v, l]) => `<div class="mi${v === shown ? ' on' : ''}" data-val="${esc(v)}"><i class="ti ti-check" aria-hidden="true"></i>${l}</div>`).join('')}</div>
  </div>`;
  const input = custom ? tx(path, 'e.g. BTC-USD', 120) : '';
  return row(label, '', `<div style="display:flex;gap:8px;align-items:center">${input}${dd}</div>`);
}

function buildPages() {
  const notchStyle = S.notch?.style || 'curved';
  const menuLayout = S.appearance?.menuLayout || 'deck';
  const P = {};

  // ----- Notch -----
  const compOn = !!getPath(S, 'companion.enabled', false);
  const compactOpts = [
    ['clock', 'Time'],
    ['weather', 'Weather'],
    ['cpu', 'CPU %'],
    ['ram', 'RAM %'],
    ['battery', 'Battery %'],
    ...(compOn ? [['pet', 'Companion Pet']] : []),
    ['cycle', 'Auto cycle']
  ];

  P.notch = `
    ${pv('notch')}
    ${card([
      `<div class="rw"><div class="t">Notch style</div></div>
       <div class="tg" data-path="notch.style">
         <div class="tl ${notchStyle === 'attached' ? 'on' : ''}" data-val="attached"><div class="s"><i style="border-radius:0 0 3px 3px"></i></div>Bezel</div>
         <div class="tl ${notchStyle === 'curved' ? 'on' : ''}" data-val="curved"><div class="s"><i style="border-radius:0 0 8px 8px"></i></div>Curved</div>
         <div class="tl ${notchStyle === 'floating' ? 'on' : ''}" data-val="floating"><div class="s"><i style="border-radius:7px;margin-top:4px"></i></div>Floating</div>
       </div>`,
      row('Behavior', '', seg('notch.mode', [['smart', 'Smart'], ['fixed', 'Fixed'], ['ghost', 'Ghost']], 'smart')),
      row('Resting pill', '', pop('notch.compactContent', compactOpts, 'clock'))
    ])}
    <div class="lb">Appearance</div>
    ${pv('type')}
    ${card([
      row('Font', '', pop('appearance.fontStyle', FONT_OPTS, 'mono')),
      row('Notch UI scale', '', sl('appearance.scale', 100, 140, '%', 125))
    ])}
    ${sec('Island colour', 'color', [
      row('Colour', '', `<input type="color" id="notchColorPicker" value="${S.appearance?.notchColor || '#030305'}" style="cursor:pointer;border:0;background:none;width:30px;height:24px;">`),
      row('Opacity', '', sl('appearance.notchOpacity', 20, 100, '%', 100))
    ])}
  `;

  // ----- Menu -----
  P.menu = `
    <div class="og" data-path="appearance.menuLayout">
      <div class="opt ${menuLayout === 'classic' ? 'on' : ''}" data-val="classic">
        <div class="m mp">${menuBlueprint('classic')}</div>
        <b>Classic</b>
      </div>
      <div class="opt ${menuLayout === 'deck' ? 'on' : ''}" data-val="deck">
        <div class="m mp">${menuBlueprint('deck')}</div>
        <b>Control Deck</b>
      </div>
    </div>
    ${pv('glass')}
    ${card([
      row('Glass style', '', seg('appearance.menuStyle', [['color', 'Solid'], ['transparent', 'Glass']], 'color')),
      row('Micro-interactions', '', sw('appearance.animations', true))
    ])}
    <div class="only-deck">
      <div class="lb">Control Deck</div>
      ${card([
        row('Widgets tab', '', sw('deckMenu.widgetsEnabled', true)),
        row('Stat card', '', pop('deckMenu.statsMode', [['sys', 'CPU & RAM'], ['bt', 'Bluetooth device'], ['none', 'None']], 'sys')),
        row('Weather chip', '', sw('deckMenu.showWeather', true)),
        row('Battery chip', '', sw('deckMenu.showBattery', true)),
        marketRow('Market ticker 1', 'deckMenu.market1'),
        marketRow('Market ticker 2', 'deckMenu.market2')
      ])}
    </div>
    <div class="only-classic">
      ${tilePickerHtml()}
    </div>
  `;

  // ----- Music -----
  P.music = `
    ${pv('music')}
    ${card([
      row('Music mode', '', sw('notch.musicMode', true)),
      row('Compact wave', '', sw('notch.compactMode', true), 'g-music'),
      row('Artwork glow', '', sw('notch.compactGlow', true), 'g-music'),
      row('Ambient glow', '', sw('notch.ambientGlow', true), 'g-music'),
      row('Sync with sound', '', sw('notch.eqSync', true), 'g-music'),
      row('Sound sensitivity', '', sl('notch.eqSensitivity', 50, 200, '%', 100), 'g-music')
    ])}
  `;

  // ----- Widgets -----
  const wellRow = (label, on, every, min, max) => [
    row(label, '', sw('wellness.' + on, true), 'g-well'),
    row('Remind every', '', sl('wellness.' + every, min, max, ' min', every === 'waterEvery' ? 45 : every === 'eyeEvery' ? 20 : 60), 'g-well g-' + on)
  ];
  P.widgets = `
    <div class="lb">Hover and weather</div>
    ${pv('hover')}
    ${card([
      row('Hover widgets', '', sw('widgets.enabled', true)),
      row('Left widget', '', pop('widgets.left', WIDGET_OPTS, 'weather'), 'g-hov'),
      row('Right widget', '', pop('widgets.right', WIDGET_OPTS, 'ram'), 'g-hov'),
      row('Live weather', '', sw('weather.enabled', true)),
      row('Temperature unit', '', seg('weather.unit', [['C', '°C'], ['F', '°F']], 'C'), 'g-wx'),
      row('City', '', tx('weather.city', 'Auto-detect', 150), 'g-wx'),
      row('Severe weather alerts', '', sw('weather.alerts', true), 'g-wx'),
      row('Mic indicator', '', sw('overlays.privacyDot', true))
    ])}
    <div class="lb">Companion</div>
    ${pv('pet')}
    ${card([
      row('Enable companion', '', sw('companion.enabled', false)),
      row('Eye style', '', `<span class="val" id="skin-name">${skinName()}</span>${btn('skin-toggle', UI.skinOpen ? 'Close' : 'Choose')}`, 'g-pet'),
      `<div class="g-pet g-skin" style="padding:0 14px 12px">${skinGridHtml()}</div>`,
      row('Dots monogram', '', sw('companion.monogram', false), 'g-pet'),
      row('Follow the mouse', '', sw('companion.tracking', true), 'g-pet'),
      row('Peek no sooner than', '', sl('companion.peekMinMin', 5, 120, ' min', 25), 'g-pet'),
      row('Peek no later than', '', sl('companion.peekMaxMin', 10, 240, ' min', 60), 'g-pet'),
      row('Play full tour', '', btn('pet-tour', 'Play'), 'g-pet'),
      row('Preview peek', '', btn('pet-peek', 'Preview'), 'g-pet')
    ])}
    <div class="lb">Health reminders</div>
    ${pv('health')}
    ${card([
      row('Enable reminders', '', sw('wellness.enabled', false)),
      ...wellRow('Drink water', 'water', 'waterEvery', 10, 120),
      ...wellRow('Eye rest', 'eye', 'eyeEvery', 10, 60),
      ...wellRow('Stretch', 'stretch', 'stretchEvery', 20, 120),
      row('Pause when away', '', sl('wellness.idleReset', 5, 60, ' min', 30), 'g-well')
    ])}
  `;

  // ----- Sounds and time -----
  const pLoc = getSavedLocation();
  const calcTimes = pLoc ? getCalculatedPrayerTimes(pLoc, S.prayer?.asrMethod === 'hanafi') : null;
  const detectedCityName = (pLoc && pLoc.city) ? pLoc.city : '';

  P.sounds = `
    ${card([
      row('Status sound effects', '', `<span class="g-snd">${btn('snd-edit', UI.sndEdit ? 'Done' : 'Edit')}</span>${sw('sounds.enabled', true)}`),
      row('Power connect', '', sw('sounds.power', true), 'g-snd g-sndedit'),
      row('Bluetooth', '', sw('sounds.bluetooth', true), 'g-snd g-sndedit'),
      row('File transfer', '', sw('sounds.transfer', true), 'g-snd g-sndedit'),
      row('Lock and unlock', '', sw('sounds.lock', true), 'g-snd g-sndedit')
    ])}
    <div class="lb">Prayer times</div>
    ${card([
      row('Show on island', '', `<span class="g-prayer">${btn('prayer-edit', UI.prayerEdit ? 'Done' : 'Edit')}</span>${sw('prayer.enabled', false)}`),
      row('City', '', `<div style="display:flex;gap:6px;align-items:center">${tx('prayer.city', detectedCityName || 'Auto-detect', 120)}<button class="btn" type="button" data-act="prayer-detect" title="Reset to auto-detected location">Auto</button><button class="btn" type="button" data-act="prayer-refresh" title="Refresh prayer times"><i class="ti ti-refresh" aria-hidden="true"></i></button></div>`, 'g-prayer g-prayeredit'),
      row('Asr method', '', seg('prayer.asrMethod', [['standard', 'Standard'], ['hanafi', 'Hanafi']], 'standard'), 'g-prayer g-prayeredit'),
      row('Prayer alert chime', '', pop('prayer.adhanSound', [['chime', 'Peaceful Chime'], ['mute', 'Off']], 'chime'), 'g-prayer g-prayeredit'),
      row('Heads-up (before)', '', pop('prayer.alertLead', [['0', 'Exact time only'], ['5', '5 min before'], ['10', '10 min before'], ['15', '15 min before']], '0'), 'g-prayer g-prayeredit'),
      row('Follow-up (after)', '', pop('prayer.alertRepeat', [['0', 'Off'], ['10', '10 min after'], ['15', '15 min after'], ['20', '20 min after']], '0'), 'g-prayer g-prayeredit'),
      row('Custom masjid timings', '', `<div style="display:flex;gap:8px;align-items:center"><button class="btn only-msj" type="button" data-act="prayer-reset-masjid" title="Reset all 5 waqt times to calculated">Reset</button>${sw('prayer.masjidOverride', false)}</div>`, 'g-prayer g-prayeredit'),
      ...['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map((k) => {
        const cVal = (calcTimes && calcTimes[k]) || 'hh:mm';
        return `<div class="rw only-msj g-prayer g-prayeredit"><div class="t">${k[0].toUpperCase() + k.slice(1)}</div>${tx('prayer.masjid.' + k, cVal, 80)}</div>`;
      }),
      row('Preview prayer alert', '', btn('prayer-preview', 'Preview'), 'g-prayer g-prayeredit')
    ])}
    <div class="lb">Focus timer</div>
    ${card([row('Timer chime', '', `${btn('chime-test', 'Test')}${sw('notch.timerSound', true)}`)])}
    <div class="lb">Alarms</div>
    <div id="alarm-box">${alarmBoxHtml()}</div>
  `;

  // ----- Connect -----
  P.connect = `
    ${pv('bt')}
    ${card([
      row('Bluetooth battery overlay', '', sw('overlays.btBattery', true)),
      row('Device name', '', tx('share.deviceName', 'This PC', 160))
    ])}
  `;

  // ----- Screen time -----
  const isStEnabled = getPath(S, 'general.screenTimeEnabled', true);
  P.screentime = `
    <div class="lb">Tracking</div>
    ${card([
      row('Track screen time', '', sw('general.screenTimeEnabled', true))
    ])}
    <div class="lb" style="display:flex;justify-content:space-between;align-items:center;">
      <span>Last 30 days</span>
      <span id="st-tracking-state" style="font-size:11px;font-weight:600;color:${isStEnabled ? 'var(--mint, #20c997)' : 'var(--faint, #8e8e93)'};">${isStEnabled ? 'Tracking' : 'Off'}</span>
    </div>
    <div class="gp st-chart-card">
      <div class="st-bars-wrap" id="st-bars-container">
        <div style="margin:auto;font-size:12px;color:var(--faint)">Loading history...</div>
      </div>
      <div class="st-chart-footer">
        <span id="st-chart-start-date">--</span>
        <span>Today</span>
      </div>
    </div>
    <div class="lb" id="st-day-header">${isStEnabled ? 'Today' : 'Today (Tracking Off)'}</div>
    <div class="gp" id="st-day-card">
      <div class="rw st-total-row">
        <div class="t">Total</div>
        <b class="st-total-time" id="st-total-val">--</b>
      </div>
      <div id="st-app-list">
        <div class="st-app-row"><div class="st-app-name" style="color:var(--faint)">No data yet</div></div>
      </div>
    </div>
    <div class="lb">History</div>
    <div class="gp">
      <div class="rw st-hist-row">
        <div class="st-hist-info">
          <div class="st-hist-title">Older than 30 days is removed automatically</div>
          <div class="st-hist-sub">Only tracked apps are counted</div>
        </div>
        <div id="st-hist-actions">
          <button class="btn" id="btn-st-clear" type="button" style="color:#ff453a">Clear history</button>
        </div>
      </div>
    </div>
  `;

  // ----- System -----
  P.system = `
    ${card([row('Theme', '', seg('general.settingsTheme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], 'system'))])}
    ${sec('Startup', null, [
      row('Launch at login', '', sw('general.launchAtLogin', true)),
      row('Auto update', '', sw('general.autoUpdate', false)),
      row('24-hour time', '', sw('general.hour24', false))
    ])}
    <div class="lb">Popups</div>
    ${pv('popups')}
    ${card([
      row('Unlock animation', '', sw('general.lockToast', true)),
      row('Clipboard popup', '', sw('general.copyToast', false)),
      row('Charging', '', sw('general.chargeToast', false)),
      row('Low battery', '', sw('general.lowBatteryAlert', false)),
      row('Low battery level', '', sl('general.lowBattery', 5, 40, '%', 20))
    ])}
    <div class="lb">Backup</div>
    ${card([
      row('Export settings', '', `<button class="btn" id="btn-export" type="button">Export</button>`),
      row('Import settings', '', `<button class="btn" id="btn-import" type="button">Import</button>`),
      row('Reset all settings', '', `<button class="btn" id="btn-reset" type="button" style="color:#ff453a">Reset</button>`)
    ])}
  `;

  P.about = `
    <div class="ab-hero">
      <div class="ab-logo"><img src="logo.png" alt="" /></div>
      <div class="ab-meta">
        <div class="ab-name">Inex Island</div>
        <div class="ab-tag">A Dynamic Island and control center for Windows</div>
        <div class="ab-chips">
          <span class="ab-chip v" id="about-ver-text">Version 1.0.0</span>
          <span class="ab-chip">Tauri 2</span>
          <span class="ab-chip">Rust</span>
          <span class="ab-chip">GPLv3</span>
        </div>
      </div>
      <button class="btn" id="btn-check-update" type="button">Check for updates</button>
    </div>
    <div class="gp">
      <div class="rw lk" data-url="https://github.com/inrwxyz"><span class="ic" style="background:#24292f"><i class="ti ti-brand-github" aria-hidden="true"></i></span><div class="t">Developer</div><span class="val">Inexorion</span><i class="ti ti-arrow-up-right go" aria-hidden="true"></i></div>
      <div class="rw lk" data-url="https://github.com/inrwxyz/inex-island/issues"><span class="ic" style="background:#ff9f0a"><i class="ti ti-bug" aria-hidden="true"></i></span><div class="t">Report a bug or suggest a feature</div><i class="ti ti-arrow-up-right go" aria-hidden="true"></i></div>
      <div class="rw lk" data-url="https://github.com/inrwxyz/inex-island/releases"><span class="ic" style="background:#30b0c7"><i class="ti ti-download" aria-hidden="true"></i></span><div class="t">Releases and changelog</div><i class="ti ti-arrow-up-right go" aria-hidden="true"></i></div>
      <div class="rw lk" data-url="https://www.gnu.org/licenses/gpl-3.0.html"><span class="ic" style="background:#8e8e93"><i class="ti ti-scale" aria-hidden="true"></i></span><div class="t">License</div><span class="val">GPL-3.0</span></div>
    </div>
    <div class="ab-spacer"></div>
    <div class="ab-note">
      <p>Inex Island started as a small idea: give Windows the same life that the notch gives a phone. Thank you for trying it. If something breaks or you want a feature, open an issue and I will read it.</p>
      <div class="sg">Inexorion <i class="ti ti-heart" aria-hidden="true"></i></div>
    </div>
  `;

  return P;
}

// ---------- apply theme ----------
function applyTheme(theme) {
  const win = document.getElementById('win');
  if (!win) return;
  let mode = theme || 'system';
  if (mode === 'system') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  win.setAttribute('data-t', mode);
  invoke('set_settings_glass', { dark: mode === 'dark' }).catch?.(() => {});
}

// page attributes that show/hide groups (Control deck only for the Control deck layout, masjid times only when custom timings are on)
function syncVisibility() {
  const pm = document.getElementById('p-menu');
  if (pm) pm.dataset.ml = S.appearance?.menuLayout || 'deck';
  const ps = document.getElementById('p-sounds');
  if (ps) ps.dataset.msj = S.prayer?.masjidOverride ? 'on' : 'off';
  // collapsed groups: a row with class g-xxx shows only while data-g-xxx="on" on the window
  const win = document.getElementById('win');
  if (!win) return;
  const g = (k, v) => { win.dataset[k] = v ? 'on' : 'off'; };
  g('gPet', getPath(S, 'companion.enabled', false));
  g('gWell', getPath(S, 'wellness.enabled', false));
  g('gWater', getPath(S, 'wellness.water', true));
  g('gEye', getPath(S, 'wellness.eye', true));
  g('gStretch', getPath(S, 'wellness.stretch', true));
  g('gHov', getPath(S, 'widgets.enabled', true));
  g('gWx', getPath(S, 'weather.enabled', true));
  g('gPrayer', getPath(S, 'prayer.enabled', false));
  g('gPrayeredit', UI.prayerEdit);
  g('gMusic', getPath(S, 'notch.musicMode', true));
  g('gSnd', getPath(S, 'sounds.enabled', true));
  g('gSndedit', UI.sndEdit);
  g('gSkin', UI.skinOpen);
}

// ---------- render & navigation ----------
let curTab = 'notch';

function renderAll() {
  const sb = document.getElementById('sb');
  const pages = document.getElementById('pages');
  if (!sb || !pages) return;

  sb.innerHTML = NAV.flatMap(([_, items]) => items).map(([id, label, icon, color]) => {
    return `<div class="nv${id === curTab ? ' on' : ''}" data-id="${id}">
      <em style="background:${color}"><i class="ti ${icon}" aria-hidden="true"></i></em>
      <span>${label}</span>
    </div>`;
  }).join('');

  const P = buildPages();
  pages.innerHTML = Object.keys(P).map(k => `<div class="pg${k === curTab ? ' on' : ''}" id="p-${k}">${P[k]}</div>`).join('');

  applyTheme(S.general?.settingsTheme);
  syncVisibility();
  setTitle();
  if (curTab === 'screentime') {
    renderScreenTimeData();
  }
}

function setTitle() {
  let m = null;
  NAV.forEach(([_, items]) => items.forEach(i => { if (i[0] === curTab) m = i; }));
  const t = document.getElementById('tb-title'), ic = document.getElementById('tb-ico');
  if (t && m) t.textContent = m[1];
  if (ic && m) { ic.style.background = m[3]; ic.innerHTML = `<i class="ti ${m[2]}" aria-hidden="true"></i>`; }
}

function go(id) {
  curTab = id;
  if (UI.skinOpen) { UI.skinOpen = false; const tb = document.querySelector('[data-act="skin-toggle"]'); if (tb) tb.textContent = 'Choose'; syncVisibility(); }
  setTitle();
  const targetPage = document.getElementById('p-' + id);
  if (targetPage && (id === 'notch' || id === 'companion' || id === 'screentime')) {
    const P = buildPages();
    targetPage.innerHTML = P[id];
  }
  document.querySelectorAll('.pg').forEach(p => p.classList.toggle('on', p.id === 'p-' + id));
  document.querySelectorAll('.nv').forEach(n => n.classList.toggle('on', n.dataset.id === id));
  if (id === 'screentime') {
    renderScreenTimeData();
  }
}

// ---------- Screen Time 30-day interactive viewer ----------
let stHistoryCache = [];
let stSelectedDayIdx = 29;
let stIconCache = {};

function fmtDuration(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}

function fmtDateTitle(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  const isToday = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (isToday) {
    return `Today, ${d.getDate()} ${months[d.getMonth()]}`;
  }
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
}

const APP_BADGE_COLORS = {
  Chrome: '#2563eb',
  'Google Chrome': '#2563eb',
  'VS Code': '#0284c7',
  'Visual Studio Code': '#0284c7',
  Discord: '#6366f1',
  Spotify: '#16a34a',
  Explorer: '#d97706',
  Others: '#64748b'
};

function getBadgeColor(name) {
  return APP_BADGE_COLORS[name] || '#64748b';
}

async function renderScreenTimeData() {
  const container = document.getElementById('st-bars-container');
  if (!container) return;

  try {
    const rawHistory = await invoke('get_screen_time_history') || [];
    const histMap = {};
    for (const d of rawHistory) {
      if (d && d.date) histMap[d.date] = d;
    }

    const days30 = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const dateKey = `${yyyy}-${mm}-${dd}`;
      const rec = histMap[dateKey] || { date: dateKey, total: 0, apps: [] };
      days30.push({ date: dateKey, dateObj: d, total: rec.total || 0, apps: rec.apps || [] });
    }
    stHistoryCache = days30;
    stSelectedDayIdx = 29;

    const startLbl = document.getElementById('st-chart-start-date');
    if (startLbl && days30[0]) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      startLbl.textContent = `${days30[0].dateObj.getDate()} ${months[days30[0].dateObj.getMonth()]}`;
    }

    const maxTotal = Math.max(60, ...days30.map(d => d.total));

    container.innerHTML = days30.map((d, idx) => {
      const heightPct = Math.min(100, Math.max(6, Math.round((d.total / maxTotal) * 100)));
      const isOn = idx === stSelectedDayIdx;
      return `<div class="st-bar-col${isOn ? ' on' : ''}" data-idx="${idx}" title="${fmtDateTitle(d.dateObj)}: ${fmtDuration(d.total)}">
        <div class="st-bar-fill" style="height:${heightPct}%"></div>
      </div>`;
    }).join('');

    container.querySelectorAll('.st-bar-col').forEach(col => {
      col.addEventListener('click', () => {
        const idx = parseInt(col.dataset.idx, 10);
        stSelectedDayIdx = idx;
        container.querySelectorAll('.st-bar-col').forEach((c, i) => c.classList.toggle('on', i === idx));
        renderSelectedDayView();
      });
    });

    renderSelectedDayView();
    setupHistoryClear();
  } catch (err) {
    console.error('Error loading screen time data:', err);
  }
}

async function renderSelectedDayView() {
  const day = stHistoryCache[stSelectedDayIdx];
  if (!day) return;

  const dayHdr = document.getElementById('st-day-header');
  const totVal = document.getElementById('st-total-val');
  const listEl = document.getElementById('st-app-list');
  if (dayHdr) dayHdr.textContent = fmtDateTitle(day.dateObj);
  if (totVal) totVal.textContent = fmtDuration(day.total);
  if (!listEl) return;

  if (!day.apps || day.apps.length === 0) {
    listEl.innerHTML = `<div class="st-app-row"><div class="st-app-name" style="color:var(--faint)">No apps recorded</div></div>`;
    return;
  }

  const maxAppSecs = Math.max(1, ...day.apps.map(a => a.secs));

  listEl.innerHTML = day.apps.map(app => {
    const widthPct = Math.min(100, Math.max(4, Math.round((app.secs / maxAppSecs) * 100)));
    const cachedIcon = stIconCache[app.exe];
    const iconHtml = cachedIcon
      ? `<img src="${cachedIcon}" class="st-app-ico" alt="" />`
      : `<span class="st-app-badge" style="background:${getBadgeColor(app.name)}">${(app.name || 'O')[0].toUpperCase()}</span>`;
    return `<div class="st-app-row" data-exe="${esc(app.exe)}">
      <div class="st-app-icon-box">${iconHtml}</div>
      <div class="st-app-name" title="${esc(app.name)}">${esc(app.name)}</div>
      <div class="st-app-bar-wrap">
        <div class="st-app-bar-fill" style="width:${widthPct}%"></div>
      </div>
      <div class="st-app-dur">${fmtDuration(app.secs)}</div>
    </div>`;
  }).join('');

  const neededExes = day.apps.map(a => a.exe).filter(e => !stIconCache[e]);
  if (neededExes.length > 0) {
    try {
      const newIcons = await invoke('get_app_icons', { exes: neededExes });
      if (newIcons && typeof newIcons === 'object') {
        Object.assign(stIconCache, newIcons);
        listEl.querySelectorAll('.st-app-row').forEach(row => {
          const exe = row.dataset.exe;
          const url = stIconCache[exe];
          if (url) {
            const box = row.querySelector('.st-app-icon-box');
            if (box) box.innerHTML = `<img src="${url}" class="st-app-ico" alt="" />`;
          }
        });
      }
    } catch (_) {}
  }
}

function setupHistoryClear() {
  const actions = document.getElementById('st-hist-actions');
  if (!actions) return;

  actions.innerHTML = `<button class="btn" id="btn-st-clear" type="button" style="color:#ff453a">Clear history</button>`;
  document.getElementById('btn-st-clear')?.addEventListener('click', () => {
    actions.innerHTML = `
      <span class="st-clear-prompt">Clear all 30 days?</span>
      <button class="btn" id="btn-st-cancel" type="button">Cancel</button>
      <button class="btn" id="btn-st-confirm" type="button" style="color:#ff453a;background:rgba(255,69,58,0.15)">Clear</button>
    `;
    document.getElementById('btn-st-cancel')?.addEventListener('click', setupHistoryClear);
    document.getElementById('btn-st-confirm')?.addEventListener('click', async () => {
      await invoke('clear_screen_time');
      stHistoryCache = [];
      await renderScreenTimeData();
    });
  });
}

function closeAllMenus() {
  document.querySelectorAll('.mn.open').forEach(m => m.classList.remove('open'));
}

function runAction(act) {
  if (act === 'pet-tour') invoke('trigger_companion_demo', { kind: 'tour' });
  else if (act === 'pet-peek') invoke('trigger_companion_demo', { kind: 'peek' });
  else if (act === 'chime-test') invoke('play_alarm_sound');
  else if (act === 'skin-toggle') {
    UI.skinOpen = !UI.skinOpen;
    syncVisibility();
    const b = document.querySelector('[data-act="skin-toggle"]');
    if (b) b.textContent = UI.skinOpen ? 'Close' : 'Choose';
  } else if (act === 'snd-edit') {
    UI.sndEdit = !UI.sndEdit;
    syncVisibility();
    const b = document.querySelector('[data-act="snd-edit"]');
    if (b) b.textContent = UI.sndEdit ? 'Done' : 'Edit';
  } else if (act === 'prayer-edit') {
    UI.prayerEdit = !UI.prayerEdit;
    syncVisibility();
    const b = document.querySelector('[data-act="prayer-edit"]');
    if (b) b.textContent = UI.prayerEdit ? 'Done' : 'Edit';
  }
  else if (act === 'tiles-toggle') { UI.tilesEdit = !UI.tilesEdit; refreshTilePicker(); }
  else if (act === 'prayer-preview') { try { localStorage.setItem('inex.prayer.preview', String(Date.now())); } catch (_) {} }
  else if (act === 'prayer-reset-masjid') { resetMasjidToCalculated(); }
  else if (act === 'prayer-detect') {
    commit('prayer.city', '');
    try { localStorage.removeItem('inex.prayer.loc'); } catch (_) {}
    try { localStorage.removeItem('inex.loc'); } catch (_) {}
    try { localStorage.setItem('inex.prayer.refreshLoc', String(Date.now())); } catch (_) {}
    resetMasjidToCalculated();
  }
  else if (act === 'prayer-refresh') {
    try { localStorage.setItem('inex.prayer.refreshLoc', String(Date.now())); } catch (_) {}
    resetMasjidToCalculated();
  }
}

function importSettings() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    f.text().then((txt) => {
      try {
        const data = JSON.parse(txt);
        const base = JSON.parse(JSON.stringify(DEFAULTS));
        const merge = (b, e) => {
          Object.keys(e || {}).forEach((k) => {
            if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && e[k] && typeof e[k] === 'object') merge(b[k], e[k]);
            else if (k in b) b[k] = e[k];
          });
        };
        merge(base, data);
        S = ensureDefaults(base);
        save(S);
        renderAll();
      } catch (_) { alert('That file is not a valid Inex Island settings file.'); }
    });
  };
  inp.click();
}

// ---------- setup event handlers ----------
function initEvents() {
  const win = document.getElementById('win');
  if (!win) return;

  document.getElementById('titlebar')?.addEventListener('mousedown', (e) => {
    if (e.target.closest('#btn-close, button, .x, input')) return;
    invoke('drag_settings');
  });

  document.getElementById('btn-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    invoke('close_settings');
  });

  win.addEventListener('click', (e) => {
    const t = e.target;
    let el;

    // Dropdown option
    if ((el = t.closest('.mi'))) {
      const menu = el.closest('.mn');
      const pw = el.closest('.pw');
      if (menu && pw && pw.classList.contains('mk')) {
        // Market ticker dropdown: a preset saves its symbol, "Custom" just shows the text box
        const mpath = pw.dataset.path;
        const isCustom = el.dataset.val === '__custom';
        UI.mkCustom[mpath] = isCustom;
        if (!isCustom) commit(mpath, el.dataset.val);
        closeAllMenus();
        menu.querySelectorAll('.mi').forEach(m => m.classList.remove('on'));
        el.classList.add('on');
        const trigger = pw.querySelector('.pop');
        if (trigger) trigger.childNodes[0].nodeValue = el.textContent.trim() + ' ';
        const parentFlex = pw.parentElement;
        if (parentFlex) {
          let inp = parentFlex.querySelector('input');
          if (isCustom && !inp) {
            inp = document.createElement('input');
            inp.className = 'tx';
            inp.type = 'text';
            inp.dataset.path = mpath;
            inp.placeholder = 'e.g. BTC-USD';
            inp.style.width = '120px';
            parentFlex.insertBefore(inp, pw);
          } else if (!isCustom && inp) {
            inp.remove();
          }
        }
        return;
      }
      if (menu && pw) {
        menu.querySelectorAll('.mi').forEach(m => m.classList.remove('on'));
        el.classList.add('on');
        const trigger = pw.querySelector('.pop');
        if (trigger) trigger.childNodes[0].nodeValue = el.textContent.trim() + ' ';
        const path = pw.dataset.path;
        if (path) commit(path, el.dataset.val);
      }
      closeAllMenus();
      return;
    }

    // Dropdown trigger
    if ((el = t.closest('.pop'))) {
      const mm = el.nextElementSibling;
      const wasOpen = mm?.classList.contains('open');
      closeAllMenus();
      if (!wasOpen && mm) {
        // open upward when there is not enough room below (last rows of a page)
        mm.classList.remove('up');
        mm.classList.add('open');
        const sc = el.closest('.mn2') || document.getElementById('win');
        const lim = (sc ? sc.getBoundingClientRect().bottom : window.innerHeight) - 8;
        const r = mm.getBoundingClientRect();
        if (r.bottom > lim) {
          const roomAbove = el.getBoundingClientRect().top - (sc ? sc.getBoundingClientRect().top : 0) - 8;
          if (roomAbove > lim - el.getBoundingClientRect().bottom) mm.classList.add('up');
        }
      }
      return;
    }

    closeAllMenus();

    // Alarm controls
    if ((el = t.closest('[data-al]'))) {
      alarmAction(el.dataset.al, el.dataset.id);
      return;
    }

    // Action buttons (tour, preview, test ...)
    if ((el = t.closest('[data-act]'))) {
      runAction(el.dataset.act);
      return;
    }

    // Switch
    if ((el = t.closest('.sw'))) {
      el.classList.toggle('on');
      const path = el.dataset.path;
      const on = el.classList.contains('on');
      if (path) {
        commit(path, on);
        if (path === 'general.launchAtLogin') invoke('set_autostart', { on });
        if (path === 'general.screenTimeEnabled') {
          invoke('set_screen_time_enabled', { on });
          const stBadge = document.getElementById('st-tracking-state');
          if (stBadge) {
            stBadge.textContent = on ? 'Tracking' : 'Off';
            stBadge.style.color = on ? 'var(--mint, #20c997)' : 'var(--faint, #8e8e93)';
          }
          const dayHeader = document.getElementById('st-day-header');
          if (dayHeader) {
            dayHeader.textContent = on ? 'Today' : 'Today (Tracking Off)';
          }
          renderScreenTimeData();
        }
        syncVisibility();
      }
      return;
    }

    // Segmented control
    if ((el = t.closest('.seg b'))) {
      const parent = el.closest('.seg');
      parent.querySelectorAll('b').forEach(b => b.classList.remove('on'));
      el.classList.add('on');
      const path = parent.dataset.path;
      if (path) {
        commit(path, el.dataset.val);
        if (path === 'general.settingsTheme') applyTheme(el.dataset.val);
      }
      return;
    }

    // Companion eye style
    if ((el = t.closest('.sk'))) {
      el.closest('.skg').querySelectorAll('.sk').forEach(s => s.classList.remove('on'));
      el.classList.add('on');
      commit('companion.skin', el.dataset.val);
      const nm = document.getElementById('skin-name');
      if (nm) nm.textContent = skinName();
      // stays open after picking; closes only via the Close button or when leaving the page
      return;
    }

    // Quick action tiles toggle
    if ((el = t.closest('[data-act="tiles-toggle"]'))) {
      UI.tilesEdit = !UI.tilesEdit;
      refreshTilePicker();
      return;
    }

    // Quick action tile remove
    if ((el = t.closest('[data-tile-remove]'))) {
      const id = el.dataset.tileRemove;
      let list = Array.isArray(S.menu?.actionTiles) ? [...S.menu.actionTiles] : [...DEFAULT_ACTION_TILES];
      if (list.includes(id) && list.length > 1) {
        list = list.filter((x) => x !== id);
        commit('menu.actionTiles', list);
        refreshTilePicker();
      }
      return;
    }

    // Quick action tile add
    if ((el = t.closest('[data-tile-add]'))) {
      const id = el.dataset.tileAdd;
      let list = Array.isArray(S.menu?.actionTiles) ? [...S.menu.actionTiles] : [...DEFAULT_ACTION_TILES];
      if (!list.includes(id) && list.length < MAX_ACTION_TILES) {
        list.push(id);
        commit('menu.actionTiles', list);
        refreshTilePicker();
      }
      return;
    }

    // Notch Style tile
    if ((el = t.closest('.tl'))) {
      el.closest('.tg').querySelectorAll('.tl').forEach(tile => tile.classList.remove('on'));
      el.classList.add('on');
      commit('notch.style', el.dataset.val);
      return;
    }

    // Classic vs Control deck
    if ((el = t.closest('.opt'))) {
      el.closest('.og').querySelectorAll('.opt').forEach(opt => opt.classList.remove('on'));
      el.classList.add('on');
      commit('appearance.menuLayout', el.dataset.val);
      syncVisibility();
      return;
    }

    if ((el = t.closest('.nv'))) {
      go(el.dataset.id);
      return;
    }

    if (t.closest('#btn-reset')) {
      if (confirm('Reset all settings to defaults?')) {
        S = ensureDefaults(JSON.parse(JSON.stringify(DEFAULTS)));
        save(S);
        invoke('set_autostart', { on: !!DEFAULTS.general.launchAtLogin });
        renderAll();
      }
      return;
    }

    if (t.closest('#btn-export')) {
      const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `inex-island-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      return;
    }

    if (t.closest('#btn-import')) { importSettings(); return; }

    if ((el = t.closest('[data-url]'))) {
      invoke('open_url', { url: el.dataset.url });
      return;
    }

    if (t.id === 'btn-check-update' || t.closest('#btn-check-update')) {
      const b = t.closest('#btn-check-update') || t;
      if (b.dataset.updating === 'true') return;
      if (b.dataset.hasUpdate === 'true') {
        b.dataset.updating = 'true';
        b.textContent = 'Installing update...';
        invoke('apply_update').then((ok) => {
          if (ok) {
            b.textContent = 'Restarting...';
          } else {
            b.textContent = 'Update failed';
            setTimeout(() => { b.textContent = 'Check for updates'; b.dataset.updating = 'false'; b.dataset.hasUpdate = 'false'; }, 3000);
          }
        }).catch(() => {
          b.textContent = 'Update error';
          setTimeout(() => { b.textContent = 'Check for updates'; b.dataset.updating = 'false'; b.dataset.hasUpdate = 'false'; }, 3000);
        });
        return;
      }

      b.textContent = 'Checking...';
      b.disabled = true;
      invoke('check_update').then((res) => {
        b.disabled = false;
        const ver = res?.latest_version || res?.version;
        if (res?.available && ver) {
          b.dataset.hasUpdate = 'true';
          b.textContent = `Update to v${ver}`;
          b.style.fontWeight = '600';
        } else {
          b.dataset.hasUpdate = 'false';
          b.textContent = 'You are on the latest version';
          setTimeout(() => {
            b.textContent = 'Check for updates';
          }, 3500);
        }
      }).catch(() => {
        b.disabled = false;
        b.textContent = 'Unable to check';
        setTimeout(() => {
          b.textContent = 'Check for updates';
        }, 3000);
      });
      return;
    }
  });

  // Sliders + colour picker (live)
  win.addEventListener('input', (e) => {
    const r = e.target;
    if (r.type === 'range') {
      const span = r.nextElementSibling;
      if (span) span.textContent = `${r.value}${r.dataset.u || ''}`;
      const path = r.closest('.sl')?.dataset.path;
      if (path) commit(path, parseInt(r.value, 10));
    } else if (r.id === 'notchColorPicker') {
      commit('appearance.notchColor', r.value);
    }
  });

  // Text fields (City, device name, tickers, masjid times) save when you press Enter or leave the field
  win.addEventListener('change', (e) => {
    const r = e.target;
    if (!r.classList || !r.classList.contains('tx')) return;
    const path = r.dataset.path;
    if (!path) return;
    let v = r.value.trim();
    if (path.startsWith('deckMenu.market')) v = v.toUpperCase();
    if (path === 'weather.city') { commitWeatherCity(r, v); return; }
    commit(path, v);
    if (path === 'prayer.city') {
      try { localStorage.setItem('inex.prayer.refreshLoc', String(Date.now())); } catch (_) {}
      resetMasjidToCalculated();
    }
  });
  win.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList?.contains('tx')) e.target.blur();
  });

  // the island (other window) edits alarms too
  window.addEventListener('storage', (e) => { if (e.key === 'inex.alarms.v1' || e.key === null) renderAlarmBox(); });
}

// ---------- startup ----------
try {
  invoke('get_app_version').then(v => {
    if (v) {
      const av = document.getElementById('about-ver-text');
      if (av) av.textContent = `Version ${v}`;
    }
  });
} catch (_) {}

try {
  window.__TAURI__?.event?.listen('settings-opened', () => {
    S = ensureDefaults(load());
    UI.skinOpen = false;
    UI.sndEdit = false;
    UI.prayerEdit = false;
    renderAll();
    if (S.prayer?.enabled && !getSavedLocation()) {
      resolvePrayerLocation().then((loc) => {
        if (loc?.city) updatePrayerCityUI(loc.city);
      });
    }
  });
} catch (_) {}

renderAll();
initEvents();
setInterval(refreshPreviews, 15000);
if (S.prayer?.enabled && !getSavedLocation()) {
  resolvePrayerLocation().then((loc) => {
    if (loc?.city) updatePrayerCityUI(loc.city);
  });
}
