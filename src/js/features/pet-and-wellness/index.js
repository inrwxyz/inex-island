// Notch Companion (pet) + Smart Health Reminders Feature
import { $, island } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';
import { reportIslandSize } from '../../core/views.js';
import { hudCanShow, popupIsBusy, hudIslandSize, hudRestoreSize, showDeviceHud } from '../bluetooth/index.js';
import { updateClocks } from '../clock/index.js';
import { refreshMedia } from '../media/index.js';
import { subscribe as onSettings } from '../../../shared.js';

const C0 = { enabled: false, skin: 'eyes', monogram: false, tracking: true, peekMinMin: 25, peekMaxMin: 60, activityPeekMin: 45 };
const W0 = { enabled: false, water: true, waterEvery: 45, eye: true, eyeEvery: 20, stretch: true, stretchEvery: 60, idleReset: 30 };

function cc() {
  const SET = loadSettings();
  const c = Object.assign({}, C0, SET.companion || {});
  c.pinned = false;
  if (c.enabled && SET.notch && SET.notch.compactContent === 'pet') {
    c.pinned = true;
  }
  return c;
}

function wc() {
  const SET = loadSettings();
  return Object.assign({}, W0, SET.wellness || {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOOK = { eyes: [3, 3.4], orbs: [2.6, 2.6], slits: [2.2, 2.8], visor: [3.6, 1.2] };
const SKINS = ['eyes', 'orbs', 'slits', 'visor', 'cat', 'dots'];

function eyesSVG(kind) {
  const eye = (cx, cls) => {
    let body;
    let pupil;
    if (kind === 'orbs') {
      body = `<circle class="eye-body" cx="${cx}" cy="10" r="7.4"/>`;
      pupil = `<circle class="pupil-core" cx="${cx}" cy="10.2" r="3.3"/><circle class="pupil-shine" cx="${cx + 1.2}" cy="8.8" r="1"/>`;
    } else if (kind === 'slits') {
      body = `<ellipse class="eye-body" cx="${cx}" cy="10" rx="6.6" ry="7.6"/>`;
      pupil = `<rect class="pupil-core" x="${cx - 1.2}" y="4.8" width="2.4" height="10.4" rx="1.2"/>`;
    } else if (kind === 'visor') {
      body = `<rect class="eye-body" x="${cx - 7.5}" y="6" width="15" height="8" rx="4"/>`;
      pupil = `<rect class="pupil-core" x="${cx - 2.6}" y="8" width="5.2" height="4" rx="2"/>`;
    } else {
      body = `<rect class="eye-body" x="${cx - 6}" y="2.5" width="12" height="15" rx="6"/>`;
      pupil = `<rect class="pupil-core" x="${cx - 2.4}" y="6.5" width="4.8" height="7" rx="2.4"/>`;
    }
    return `<g class="eye ${cls}"><ellipse class="eye-glow" cx="${cx}" cy="10" rx="9" ry="9.5"/>` +
      `<g class="eye-lid">${body}<g class="pupil">${pupil}</g></g></g>`;
  };
  return `<svg class="pet-svg" viewBox="0 0 40 20" aria-hidden="true">${eye(11, 'eye-l')}${eye(29, 'eye-r')}</svg>`;
}

const CAT_HEAD = [
  '..##........##..',
  '..###......###..',
  '..############..',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '..############..',
  '...##########...'
];

function pixelRects(rows) {
  let out = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === '#') {
        const s = x;
        while (x < row.length && row[x] === '#') x++;
        out += `<rect x="${s}" y="${y}" width="${x - s}" height="1"/>`;
      } else x++;
    }
  });
  return out;
}

function catSVG() {
  const eyeBox = (x) => `<g class="cat-eye"><rect x="${x}" y="4" width="3" height="2" fill="#fff"/><rect class="cat-pupil" x="${x + 1}" y="4" width="1" height="1" fill="#1a1020"/></g>`;
  const happy = (x) => `<rect x="${x}" y="5" width="1" height="1"/><rect x="${x + 1}" y="4" width="1" height="1"/><rect x="${x + 2}" y="5" width="1" height="1"/>`;
  return '<svg class="pet-svg" viewBox="0 0 16 10" shape-rendering="crispEdges" aria-hidden="true">' +
    `<g class="cat-ear-l" fill="#f5b25a">${pixelRects(CAT_HEAD.slice(0, 2).map((r) => r.slice(0, 8).padEnd(16, '.')))}</g>` +
    `<g class="cat-ear-r" fill="#f5b25a">${pixelRects(CAT_HEAD.slice(0, 2).map((r) => '........' + r.slice(8)))}</g>` +
    `<g class="cat-head" fill="#f5b25a">${pixelRects(CAT_HEAD.slice(2))}</g>`.replace(/y="(\d+)"/g, (m, y) => `y="${+y + 2}"`) +
    `<g fill="#ff8fa3"><rect x="3" y="1" width="1" height="1"/><rect x="12" y="1" width="1" height="1"/><rect x="7" y="6" width="2" height="1"/></g>` +
    `<g class="cat-eyes">${eyeBox(3)}${eyeBox(10)}</g>` +
    `<g class="cat-happy" fill="#1a1020">${happy(3)}${happy(10)}</g>` +
    '<g fill="#1a1020"><rect x="6" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/></g>' +
    '</svg>';
}

function dotsSVG(mono) {
  return mono
    ? '<svg class="pet-svg" viewBox="0 0 30 12" aria-hidden="true"><g class="mono"><circle class="mono-ring" cx="15" cy="6" r="5"/><path class="mono-i" d="M15 3.4v5.2"/></g></svg>'
    : '<svg class="pet-svg" viewBox="0 0 30 12" aria-hidden="true"><g class="dots"><circle class="dot d1" cx="6" cy="6" r="2.3"/><circle class="dot d2" cx="15" cy="6" r="2.3"/><circle class="dot d3" cx="24" cy="6" r="2.3"/></g></svg>';
}

let box = null;
let inner = null;
let svgEl = null;
let pupils = [];
let renderedKey = '';
const MOODS = ['m-happy', 'm-wink', 'm-sleepy'];

const T = { x: 0, y: 0, tx: 0, ty: 0, raf: 0, last: 0 };
let lastCat = '';
let rectC = null;

function mount(where) {
  const host = $('c-center-trigger');
  if (!host || !box) return;
  box.classList.toggle('at-inline', where === 'center');
  box.classList.toggle('at-center', where !== 'center');
  if (box.parentNode !== host) {
    host.appendChild(box);
    rectC = null;
  }
}

function applyLook(x, y) {
  if (!box || !svgEl) return;
  const skin = box.dataset.skin;
  if (LOOK[skin]) {
    const lk = LOOK[skin];
    const tf = 'translate3d(' + (x * lk[0]).toFixed(2) + 'px,' + (y * lk[1]).toFixed(2) + 'px,0)';
    for (let i = 0; i < pupils.length; i++) pupils[i].style.transform = tf;
    svgEl.style.transform = 'translate3d(' + (x * 1.6).toFixed(2) + 'px,' + (y * 0.9).toFixed(2) + 'px,0)';
  } else if (skin === 'cat') {
    const px = Math.max(0, Math.min(2, Math.round(x + 1)));
    const py = y > 0.25 ? 1 : 0;
    const k = px + ',' + py;
    if (k === lastCat) return;
    lastCat = k;
    for (let i = 0; i < pupils.length; i++) pupils[i].style.transform = 'translate(' + px + 'px,' + py + 'px)';
  } else if (skin === 'dots') {
    svgEl.style.transform = 'translate3d(' + (x * 3).toFixed(2) + 'px,' + (y * 1.6).toFixed(2) + 'px,0)';
  }
}

function renderSkin() {
  const c = cc();
  const skin = SKINS.indexOf(c.skin) >= 0 ? c.skin : 'eyes';
  const key = skin + (c.monogram ? 'm' : '');
  if (key === renderedKey) return;
  renderedKey = key;
  box.dataset.skin = skin;
  inner.innerHTML = skin === 'cat' ? catSVG() : skin === 'dots' ? dotsSVG(c.monogram) : eyesSVG(skin);
  svgEl = inner.firstElementChild;
  pupils = Array.prototype.slice.call(inner.querySelectorAll('.pupil, .cat-pupil'));
  lastCat = '';
  rectC = null;
  applyLook(T.x, T.y);
}

const playT = {};
function play(cls, ms) {
  if (!inner) return;
  clearTimeout(playT[cls]);
  inner.classList.remove(cls);
  void inner.offsetWidth;
  inner.classList.add(cls);
  playT[cls] = setTimeout(() => inner.classList.remove(cls), ms);
}

let moodT = 0;
function setMood(name, ms) {
  if (!box) return;
  clearTimeout(moodT);
  MOODS.forEach((m) => box.classList.remove(m));
  if (name) box.classList.add('m-' + name);
  if (name && ms) moodT = setTimeout(() => box.classList.remove('m-' + name), ms);
}

const clicks = [];
export function onPoke(e) {
  if (e) e.stopPropagation();
  const now = performance.now();
  clicks.push(now);
  while (clicks.length && now - clicks[0] > 1200) clicks.shift();
  if (clicks.length >= 4) {
    clicks.length = 0;
    play('r-spin', 800);
    setMood('happy', 900);
    return;
  }
  const r = Math.floor(Math.random() * 3);
  if (r === 0) {
    play('r-purr', 900);
    setMood('happy', 900);
  } else if (r === 1) {
    setMood('wink', 700);
  } else {
    play('r-giggle', 700);
    setMood('happy', 700);
  }
}

function build() {
  box = document.createElement('div');
  box.id = 'pet-box';
  box.className = 'pet-box hidden at-center';
  box.setAttribute('aria-hidden', 'true');
  inner = document.createElement('div');
  inner.className = 'pet-inner';
  box.appendChild(inner);
  box.addEventListener('click', onPoke);
  box.addEventListener('mouseenter', () => box.classList.add('is-hover'));
  box.addEventListener('mouseleave', () => box.classList.remove('is-hover'));
  mount('peek');
}

let rectAt = 0;
let tracking = false;
let probeT = 0;
const lastMouse = { x: 0, y: 0 };
let mouseSeen = false;

window.addEventListener('mousemove', (e) => {
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;
  mouseSeen = true;
}, { passive: true });
window.addEventListener('resize', () => {
  rectC = null;
});

function step(t) {
  const dt = Math.min(0.05, (t - T.last) / 1000);
  T.last = t;
  const a = 1 - Math.exp(-dt / 0.07);
  T.x += (T.tx - T.x) * a;
  T.y += (T.ty - T.y) * a;
  if (Math.abs(T.tx - T.x) < 0.003 && Math.abs(T.ty - T.y) < 0.003) {
    T.x = T.tx;
    T.y = T.ty;
    T.raf = 0;
    applyLook(T.x, T.y);
    return;
  }
  applyLook(T.x, T.y);
  T.raf = requestAnimationFrame(step);
}

function kick() {
  if (T.raf && performance.now() - T.last < 300) return;
  if (T.raf) cancelAnimationFrame(T.raf);
  T.last = performance.now();
  T.raf = requestAnimationFrame(step);
}

function aim(px, py) {
  const now = performance.now();
  if (!rectC || now - rectAt > 600) {
    rectC = box?.getBoundingClientRect();
    rectAt = now;
  }
  if (!rectC) return;
  const ox = rectC.left + rectC.width / 2;
  const oy = rectC.top + rectC.height / 2;
  const dx = px - ox;
  const dy = py - oy;
  const dist = Math.hypot(dx, dy);
  const theta = Math.atan2(dy, dx);
  const k = Math.tanh(dist / 70);
  const tx = Math.cos(theta) * k;
  const ty = Math.sin(theta) * k;
  if (Math.abs(tx - T.tx) < 0.012 && Math.abs(ty - T.ty) < 0.012) return;
  T.tx = tx;
  T.ty = ty;
  kick();
}

const BUSY_CLASSES = ['bt-hud-active', 'alarm-active', 'biometric-active', 'bio-hud', 'hud-pre', 'hud-out', 'hud-back',
  'wellness-hud-active', 'media-active', 'transferring', 'has-toast', 'incoming-open', 'smart-hidden'];
const COVER_CLASSES = ['bt-hud-active', 'alarm-active', 'biometric-active', 'wellness-hud-active', 'transferring', 'has-toast', 'incoming-open', 'smart-hidden'];

function hudBusy() {
  if (!hudCanShow() || appState.alarmActive || popupIsBusy() || appState.isFs) return true;
  for (let i = 0; i < BUSY_CLASSES.length; i++) {
    if (island?.classList.contains(BUSY_CLASSES[i])) return true;
  }
  return false;
}

function petVisible() {
  if (!box || box.classList.contains('hidden') || !island?.classList.contains('state-compact')) return false;
  for (let i = 0; i < COVER_CLASSES.length; i++) {
    if (island.classList.contains(COVER_CLASSES[i])) return false;
  }
  return box.offsetWidth > 0;
}

let probeSrc = 'rust';
let probeFails = 0;
let lastIdle = 0;

async function readCursor() {
  if (probeSrc === 'rust') {
    try {
      const r = await invokeTauri('pet_probe');
      if (Array.isArray(r) && r.length >= 2 && isFinite(r[0]) && isFinite(r[1])) {
        probeFails = 0;
        lastIdle = r[2] | 0;
        return [r[0], r[1]];
      }
    } catch (err) {
      console.warn('pet_probe error:', err);
    }
    if (++probeFails >= 3) probeSrc = 'api';
    return null;
  }
  try {
    const w = window.__TAURI__?.window;
    const win = w?.getCurrentWindow ? w.getCurrentWindow() : w?.getCurrent?.();
    if (!w || !win || !w.cursorPosition) return null;
    const res = await Promise.all([w.cursorPosition(), win.outerPosition(), win.scaleFactor()]);
    const sf = res[2] || 1;
    return [(res[0].x - res[1].x) / sf, (res[0].y - res[1].y) / sf];
  } catch {
    return null;
  }
}

let _cachedCC = null;
let _cachedCCAt = 0;
function getCachedCC() {
  const now = performance.now();
  if (!_cachedCC || now - _cachedCCAt > 1000) {
    _cachedCC = cc();
    _cachedCCAt = now;
  }
  return _cachedCC;
}

let _lastProbeX = 0;
let _lastProbeY = 0;

async function probeLoop() {
  if (!tracking) return;
  const c = getCachedCC();
  if (!c.tracking) {
    stopTracking(true);
    return;
  }
  let moved = false;
  if (!document.hidden && petVisible()) {
    const cur = await readCursor();
    if (!tracking) return;
    if (cur) {
      if (Math.abs(cur[0] - _lastProbeX) > 1 || Math.abs(cur[1] - _lastProbeY) > 1) {
        _lastProbeX = cur[0];
        _lastProbeY = cur[1];
        moved = true;
      }
      aim(cur[0], cur[1]);
    } else if (mouseSeen) {
      aim(lastMouse.x, lastMouse.y);
    }
  }
  if (tracking) {
    clearTimeout(probeT);
    // Adaptive delay: 90ms when active, 160ms when still/idle (saves 60% CPU)
    const delay = moved ? 90 : 160;
    probeT = setTimeout(probeLoop, delay);
  }
}

function startTracking() {
  if (tracking || !getCachedCC().tracking) return;
  tracking = true;
  clearTimeout(probeT);
  probeLoop();
}

function stopTracking(recenter) {
  tracking = false;
  clearTimeout(probeT);
  if (recenter) {
    T.tx = 0;
    T.ty = 0;
    kick();
  }
}

let peekT = 0;
let peeking = false;
let peekRun = 0;

export function endPeek() {
  peeking = false;
  peekRun++;
  stopTracking(true);
  island?.classList.remove('pet-peeking');
  setTimeout(() => {
    if (!peeking && !island?.classList.contains('pet-pinned') && box) {
      box.classList.add('hidden');
      island.classList.remove('has-pet');
      setMood(null);
    }
  }, 650);
  schedulePeek();
}

export async function startPeek(why) {
  const c = cc();
  if (why !== 'manual' && (!c.enabled || c.pinned)) return;
  if (peeking || c.pinned) return;
  if (hudBusy() && why !== 'manual') {
    clearTimeout(peekT);
    peekT = setTimeout(() => startPeek(why), 30000);
    return;
  }
  const run = ++peekRun;
  peeking = true;
  mount('peek');
  renderSkin();
  setMood(null);
  box?.classList.remove('hidden');
  island?.classList.add('has-pet', 'pet-peeking');
  const alive = () => run === peekRun && peeking && (why === 'manual' || !hudBusy());
  await sleep(560);
  if (!alive()) return endPeek();
  startTracking();
  await sleep(why === 'manual' ? 3500 : (6000 + Math.random() * 4000));
  if (!alive()) return endPeek();
  stopTracking(true);
  const bye = Math.random();
  if (bye < 0.34) {
    play('r-wave', 900);
    setMood('happy', 900);
    await sleep(900);
  } else if (bye < 0.67) {
    setMood('wink', 700);
    await sleep(800);
  } else {
    setMood('sleepy', 800);
    await sleep(800);
  }
  if (run === peekRun) endPeek();
}

export function schedulePeek() {
  clearTimeout(peekT);
  const c = cc();
  if (!c.enabled || c.pinned) return;
  const lo = Math.max(1, +c.peekMinMin || 25);
  const hi = Math.max(lo, +c.peekMaxMin || 60);
  peekT = setTimeout(() => startPeek('random'), (lo + Math.random() * (hi - lo)) * 60000);
}

export function applyCompanion() {
  if (!box) return;
  const c = cc();
  clearTimeout(peekT);
  if (!c.enabled) {
    peekRun++;
    peeking = false;
    stopTracking(false);
    island?.classList.remove('has-pet', 'pet-peeking', 'pet-pinned', 'pet-center');
    box.classList.add('hidden');
    updateClocks();
    return;
  }
  renderSkin();
  if (c.pinned) {
    peekRun++;
    peeking = false;
    island?.classList.remove('pet-peeking');
    island?.classList.add('pet-pinned', 'has-pet', 'pet-center');
    mount('center');
    box.classList.remove('hidden');
    startTracking();
  } else {
    island?.classList.remove('pet-pinned', 'pet-center');
    mount('peek');
    if (!peeking) {
      box.classList.add('hidden');
      island?.classList.remove('has-pet');
      stopTracking(false);
    }
    schedulePeek();
  }
}

// Activity Tick
const TICK_S = 15;
const acc = { water: 0, eye: 0, stretch: 0 };
let streakSec = 0;
let activityPeeked = false;
let lastReminderAt = 0;

async function tick() {
  if (!cc().enabled && !wc().enabled) return;
  let idleMs = 0;
  try {
    const r = await invokeTauri('pet_probe');
    if (Array.isArray(r)) idleMs = r[2] | 0;
  } catch (err) {
    console.warn('pet_probe tick error:', err);
  }
  lastIdle = idleMs;
  const idle = idleMs / 1000;
  const w = wc();
  const c = cc();
  const active = idle < 60;

  if (active) {
    acc.water += TICK_S;
    acc.eye += TICK_S;
    acc.stretch += TICK_S;
    streakSec += TICK_S;
  }
  if (idle >= (+w.idleReset || 30)) acc.eye = 0;
  if (idle >= 300) {
    acc.stretch = 0;
    streakSec = 0;
    activityPeeked = false;
  }

  if (box && c.enabled) {
    box.classList.toggle('idle-sleepy', idle >= 90);
    if (!c.pinned && !activityPeeked && streakSec >= (+c.activityPeekMin || 45) * 60) {
      activityPeeked = true;
      startPeek('activity');
    }
  }

  if (!w.enabled || !active || performance.now() - lastReminderAt < 180000) return;
  const due = ['eye', 'water', 'stretch'].find((k) => w[k] && acc[k] >= Math.max(1, +w[k + 'Every'] || 30) * 60);
  if (due && showHud(due)) {
    acc[due] = 0;
    lastReminderAt = performance.now();
  }
}

// Wellness HUD
const WL = {
  water: {
    title: 'Time for a sip!',
    sub: 'Stay hydrated \uD83D\uDCA7',
    svg: '<svg class="wl-svg" viewBox="0 0 24 24" aria-hidden="true"><ellipse class="rip r1" cx="12" cy="20" rx="5" ry="1.6"/><ellipse class="rip r2" cx="12" cy="20" rx="5" ry="1.6"/><path class="drop" d="M12 2.8c-3 3.9-5.2 6.4-5.2 9.2a5.2 5.2 0 0 0 10.4 0c0-2.8-2.2-5.3-5.2-9.2z"/></svg>'
  },
  eye: {
    title: 'Rest your eyes',
    sub: 'Look 20 ft away for 20 s \uD83D\uDC40',
    svg: '<svg class="wl-svg" viewBox="0 0 24 24" aria-hidden="true"><path class="eye-out" d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><g class="eye-iris"><circle cx="12" cy="12" r="3.4"/><circle class="gl" cx="13.2" cy="10.8" r="1"/></g></svg>'
  },
  stretch: {
    title: 'Time to stretch \uD83E\uDDD8\u200D\u2642\uFE0F',
    sub: 'Stand up, roll your shoulders',
    svg: '<svg class="wl-svg" viewBox="0 0 24 24" aria-hidden="true"><g class="st-fig"><circle class="st-head" cx="12" cy="5" r="2.2"/><path class="st-body" d="M12 8.5v6.5M12 15l-3 5.5M12 15l3 5.5"/><g class="st-arms"><path d="M12 10.5 6.5 5.5M12 10.5l5.5-5"/></g></g></svg>'
  }
};
const WL_CLASSES = ['hud-water-active', 'hud-eye-active', 'hud-stretch-active'];
let wlHud = null;
const wlT = { open: 0, auto: 0, out: 0, end: 0 };
let wlOpen = false;

function buildHud() {
  const bar = document.querySelector('#view-compact .compact-bar');
  if (!bar) return;
  wlHud = document.createElement('div');
  wlHud.id = 'c-wellness-hud';
  wlHud.className = 'c-wellness-hud hidden';
  wlHud.innerHTML = '<span class="wl-ico" id="wl-ico"></span><span class="wl-text"><span class="wl-title" id="wl-title"></span><span class="wl-sub" id="wl-sub"></span></span>';
  wlHud.addEventListener('click', () => hideHud(false));
  bar.appendChild(wlHud);
}

export function hideHud(instant) {
  if (!wlHud || !wlOpen) return;
  clearTimeout(wlT.open);
  clearTimeout(wlT.auto);
  clearTimeout(wlT.out);
  clearTimeout(wlT.end);
  const finish = () => {
    wlOpen = false;
    wlHud?.classList.add('hidden');
    island?.classList.remove('wellness-hud-active');
    if (!instant) island?.classList.remove('hud-out', 'hud-back', 'hud-pre');
    WL_CLASSES.forEach((k) => island?.classList.remove(k));
    hudRestoreSize();
    bus.emit('center:render');
    updateClocks();
    refreshMedia();
    applyCompanion();
  };
  if (instant) {
    finish();
    return;
  }
  island?.classList.add('hud-out');
  wlT.out = setTimeout(() => {
    island?.classList.remove('wellness-hud-active', 'hud-out');
    WL_CLASSES.forEach((k) => island?.classList.remove(k));
    island?.classList.add('hud-back');
    wlT.end = setTimeout(finish, 600);
  }, 170);
}

export function showHud(kind, force = false) {
  if (!wlHud || !WL[kind] || wlOpen) return false;
  if (!force && hudBusy()) return false;
  const d = WL[kind];
  const ico = $('wl-ico');
  const title = $('wl-title');
  const sub = $('wl-sub');
  if (ico) ico.innerHTML = d.svg;
  if (title) title.textContent = d.title;
  if (sub) sub.textContent = d.sub;
  wlHud.classList.remove('hidden');
  void wlHud.offsetWidth;
  wlOpen = true;
  stopTracking(false);
  if (peeking) {
    peekRun++;
    peeking = false;
    island?.classList.remove('pet-peeking');
  }
  clearTimeout(wlT.open);
  clearTimeout(wlT.auto);
  clearTimeout(wlT.out);
  clearTimeout(wlT.end);
  reportIslandSize(hudIslandSize());
  island?.classList.add('hud-pre');
  wlT.open = setTimeout(() => {
    island?.classList.remove('hud-pre');
    island?.classList.add('wellness-hud-active', 'hud-' + kind + '-active');
  }, 110);
  wlT.auto = setTimeout(() => hideHud(false), 5000 + 110);
  return true;
}

let demoRunning = false;
export async function runDemo() {
  if (demoRunning) return;
  demoRunning = true;
  try {
    startPeek('manual');
    await sleep(5000);
    onPoke();
    await sleep(2000);
    endPeek();
    await sleep(1000);

    showHud('water', true);
    await sleep(5500);

    showHud('eye', true);
    await sleep(5500);

    showHud('stretch', true);
    await sleep(5500);

    bus.emit('biometric:morph', { kind: 'scan', label: 'Face ID • Unlocked' });
    await sleep(5200);

    const HEADPHONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
    showDeviceHud({
      iconHTML: HEADPHONE_SVG,
      name: 'AirPods Pro',
      tag: 'Connected • 98%',
      pct: 98,
      battery: false,
      ms: 5000
    });
    await sleep(5500);

    const BOLT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:20px;height:20px;"><path d="M11 21h-1l1-7H7.5c-.5 0-.8-.4-.6-.8L13 3h1l-1 7h3.5c.5 0 .8.4.6.8L11 21z"/></svg>';
    showDeviceHud({
      iconHTML: BOLT_SVG,
      battery: true,
      plain: true,
      accent: 'green',
      name: 'Charging',
      tag: '85% • Fast Power',
      pct: 85,
      ms: 5000
    });
    await sleep(5500);

    bus.emit('toast:show', { kind: 'done', text: 'Quick Share • File Received', ms: 5000 });
    await sleep(5500);
  } catch (err) {
    console.warn('Demo error:', err);
  } finally {
    demoRunning = false;
    try {
      hudRestoreSize();
      bus.emit('center:render');
      updateClocks();
      refreshMedia();
    } catch (err) {
      console.warn('Demo cleanup error:', err);
    }
  }
}

export function initCompanionAndWellness() {
  if (!island || !$('c-center-trigger') || !$('c-right-box')) return;
  build();
  buildHud();

  const trig = $('c-center-trigger');
  if (trig) {
    trig.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        runDemo();
      }
    });
  }

  new window.MutationObserver(() => {
    if (!wlOpen) return;
    const cl = island.classList;
    if (cl.contains('bt-hud-active') || cl.contains('alarm-active') || cl.contains('biometric-active') || cl.contains('transferring') || cl.contains('has-toast') || cl.contains('incoming-open') || !cl.contains('state-compact')) {
      hideHud(true);
    }
  }).observe(island, { attributes: true, attributeFilter: ['class'] });

  onSettings(() => {
    _cachedCC = null;
    renderedKey = '';
    applyCompanion();
    if (!wc().enabled && wlOpen) hideHud(true);
  });

  applyCompanion();
  setInterval(tick, TICK_S * 1000);

  listenTauri('companion-demo', (k) => {
    const key = k || 'tour';
    if (key === 'tour') runDemo();
    else if (key === 'peek') startPeek('manual');
    else if (key === 'poke') onPoke();
    else if (key === 'water' || key === 'eye' || key === 'stretch') showHud(key, true);
  });

  window.InexCompanion = {
    demo: () => runDemo(),
    peekNow: () => startPeek('manual'),
    poke: () => onPoke(),
    hud: (k) => showHud(k || 'water', true),
    state: () => ({ acc: Object.assign({}, acc), idleMs: lastIdle, peeking, tracking })
  };
}
