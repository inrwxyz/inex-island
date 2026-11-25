import { S, getPath } from './state.js';
import { SKINS } from './constants.js';
import { ic, card } from './ui.js';

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

// w = real notch width in px; scalable previews follow the UI scale, status popups stay fixed
function pill(inner, cls, w, scalable, extra) {
  const st = getPath(S, 'notch.style', 'curved');
  const width = w ? `;width:${scalable ? `calc(${w}px*var(--sc))` : `${w}px`}` : '';
  return `<div class="pill ${st} ${cls || ''}" style="${pillStyle()}${width}${extra ? ';' + extra : ''}">${inner}</div>`;
}

function stage(inner, extraCls) {
  const sc = (getPath(S, 'appearance.scale', 125) / 110).toFixed(3);
  return `<div class="pv${extraCls ? ' ' + extraCls : ''}" style="--sc:${sc}">${inner}</div>`;
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

export { clockText, pillStyle, pill, stage, hud, lockCard };

const WIDGET_SAMPLE = { cpu: 'CPU 23%', ram: 'RAM 41%', gpu: 'GPU 18%', disk: 'Disk 63%', battery: '82%', net: '↓1.2 ↑0.3' };

const PV = {
  notch() {
    const compOn = !!(getPath(S, 'animations.enabled', false) && getPath(S, 'companion.enabled', false));
    let c = getPath(S, 'notch.compactContent', 'clock');
    if (c === 'pet' && !compOn) c = 'clock';
    const chip = { weather: ic('sun') + '28°', cpu: ic('activity') + '23%', ram: ic('cpu') + '41%', battery: ic('battery-3') + '82%' };
    let inner = clockText();
    if (c === 'pet') inner = skinGlyph();
    else if (chip[c]) inner = `<span class="chip">${chip[c]}</span>`;
    const f = FONT_CSS[getPath(S, 'appearance.fontStyle', 'mono')] || 'Inter';
    return stage(pill(inner, '', 156, true, `font-family:${f},system-ui,sans-serif`));
  },
  type() {
    const f = FONT_CSS[getPath(S, 'appearance.fontStyle', 'mono')] || 'Inter';
    const sc = getPath(S, 'appearance.scale', 125) / 110;
    return stage(pill(`Inex Island ${clockText()}`, '', 0, true, `font-family:${f},system-ui,sans-serif;font-size:${(12 * sc).toFixed(1)}px`));
  },
  music() {
    const on = getPath(S, 'notch.musicMode', true), cm = getPath(S, 'notch.compactMode', true);
    const glow = getPath(S, 'notch.compactGlow', true) ? ' glow' : '';
    const eqCls = getPath(S, 'notch.eqStyle', 'bottom') === 'center' ? 'eq eq-center' : 'eq';
    if (!(on && cm)) return stage(pill(clockText(), '', 156, true));
    return stage(pill(`<span class="art${glow}"></span><span>${clockText()}</span><span class="${eqCls}"><i></i><i></i><i></i><i></i><i></i></span>`, 'sp', 192, true));
  },
  hover() {
    const on = getPath(S, 'widgets.enabled', true);
    if (!on) return stage(pill(clockText(), '', 156, true));
    const f = getPath(S, 'weather.unit', 'C') === 'F';
    const wxOn = getPath(S, 'weather.enabled', true);
    const side = (k) => {
      if (k === 'weather') return wxOn ? (f ? '82°F' : '28°C') : '';
      return WIDGET_SAMPLE[k] || '';
    };
    const l = side(getPath(S, 'widgets.left', 'weather'));
    const r = side(getPath(S, 'widgets.right', 'ram'));
    const dot = getPath(S, 'overlays.privacyDot', true) ? '<span class="pd"></span>' : '';
    return stage(pill(`<span class="side-l"><span class="dim">${l}</span>${dot}</span><span>${clockText()}</span><span class="dim">${r}</span>`, 'sp', 256, true));
  },
  pet() {
    const on = !!(getPath(S, 'animations.enabled', false) && getPath(S, 'companion.enabled', false));
    return stage(pill(on ? skinGlyph() : clockText(), '', 156, true));
  },
  animStage() {
    return stage(pill(clockText(), '', 156, true));
  },
  notifStage() {
    return stage(pill(clockText(), '', 156, true));
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
    return stage(items.join(''), items.length > 1 ? 'pv-popups' : '');
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

export function pv(key) {
  return `<div data-pv="${key}" style="display:contents">${PV[key]()}</div>`;
}

export function refreshPreviews() {
  document.querySelectorAll('[data-pv]').forEach((el) => {
    if (el.dataset.pvBusy === '1') return;
    if (el.firstElementChild?.matches(':hover')) return;
    el.innerHTML = PV[el.dataset.pv]?.() || '';
  });
}

// section = label + live preview + card of rows
export function sec(title, key, rows) {
  return `<div class="lb">${title}</div>${key ? pv(key) : ''}${card(rows)}`;
}

// Menu layout picker: true-to-scale miniatures (blueprints) of the two real menus, same proportions as the island.
export function menuBlueprint(kind) {
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
    g += r(16, 14, 62, 16, 3, FG) + r(86, 18, 54, 8, 3, DIM);
    g += c(334, 22, 6, '#fbbf24') + r(346, 17, 30, 10, 3, DIM);
    g += r(387, 8, 56, 28, 14, CHIP) + r(391, 11, 24, 22, 11, LINE);
    [465, 497, 530, 562, 595].forEach((x) => { g += c(x, 22, 9, CHIP); });
    g += r(14, 45, 250, 125, 18, CARD) + r(26, 57, 226, 28, 10, CHIP) + c(40, 71, 5, MID) + r(52, 67, 60, 8, 3, DIM);
    [96, 120, 144].forEach((y) => { g += c(38, y + 4, 6, CHIP) + r(52, y, 70, 8, 3, FG); });
    g += r(14, 178, 250, 70, 18, CARD) + ring(52, 213, 17, 0.06) + ring(172, 213, 19, 0.54) + r(139, 192, 1, 42, 0.5, LINE);
    g += r(80, 206, 30, 8, 3, FG) + r(206, 205, 30, 8, 3, FG) + r(206, 218, 38, 6, 3, DIM);
    g += tile(276, 45, 163, 45, true) + tile(448, 45, 163, 45, true) + tile(276, 98, 163, 45, true) + tile(448, 98, 163, 45, false);
    g += slider(276, 152, 335, 28) + slider(276, 186, 335, 28);
    [276, 345, 414, 483, 551].forEach((x) => { g += r(x, 222, 60, 28, 14, CARD) + r(x + 25, 231, 10, 10, 2.5, 'none', `stroke="${MID}" stroke-width="1.8"`); });
    return `<svg viewBox="0 0 625 263" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${g}</svg>`;
  }
  let g = `<path d="M0 0H390V332A28 28 0 0 1 362 360H28A28 28 0 0 1 0 332Z" fill="${BG}"/>`;
  g += r(18, 13, 40, 10, 3, MID) + r(178, 12, 46, 11, 3, FG) + r(332, 13, 40, 10, 3, MID);
  g += tile(19, 42, 170, 64, true) + tile(201, 42, 170, 64, true) + tile(19, 121, 170, 64, true) + tile(201, 121, 170, 64, false);
  [40, 92, 144, 195, 247, 298, 349].forEach((x) => { g += c(x, 219, 22, CARD) + r(x - 5, 214, 10, 10, 2.5, 'none', `stroke="${MID}" stroke-width="1.8"`); });
  g += slider(19, 252, 352, 38) + slider(19, 300, 352, 38);
  return `<svg viewBox="0 0 390 360" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${g}</svg>`;
}
