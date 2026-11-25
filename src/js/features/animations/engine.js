// Shared Animation Engine: play tokens, stage FX overlay, reduced-motion checks, and notch-contour geometry
import { island } from '../../core/dom.js';
import { loadSettings } from '../../core/settings.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const _tokens = { tray: 0, receive: 0, send: 0 };
const _cleanups = { tray: null, receive: null, send: null };

export function prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

export function islandIsHidden() {
  return !!(island && island.classList.contains('smart-hidden'));
}

export function nextToken(channel = 'send') {
  cleanupChannel(channel);
  _tokens[channel] = (_tokens[channel] || 0) + 1;
  return _tokens[channel];
}

export function isToken(channel, tok) {
  return (_tokens[channel] || 0) === tok;
}

export function registerCleanup(channel, fn) {
  _cleanups[channel] = fn;
}

export function cleanupChannel(channel) {
  _tokens[channel] = (_tokens[channel] || 0) + 1;
  const fn = _cleanups[channel];
  _cleanups[channel] = null;
  if (typeof fn === 'function') {
    try { fn(); } catch { /* ignore cleanup error */ }
  }
}

export function cleanupAllAnimations() {
  cleanupChannel('tray');
  cleanupChannel('receive');
  cleanupChannel('send');
}

export function ensureStage() {
  let stage = document.getElementById('inex-anim-stage');
  if (!stage) {
    stage = document.createElement('div');
    stage.id = 'inex-anim-stage';
    stage.className = 'anim-stage';
    stage.setAttribute('aria-hidden', 'true');
    document.body.appendChild(stage);
  }
  return stage;
}

export function spawnFxNode(cls, html, styles, channel) {
  const stage = ensureStage();
  const el = document.createElement('div');
  el.className = `anim-fx ${cls || ''}`;
  if (channel) el.dataset.animCh = channel;
  if (html) el.innerHTML = html;
  if (styles) Object.assign(el.style, styles);
  stage.appendChild(el);
  return el;
}

export function removeChannelNodes(channel) {
  const stage = document.getElementById('inex-anim-stage');
  if (!stage) return;
  stage.querySelectorAll(`[data-anim-ch="${channel}"]`).forEach((n) => n.remove());
}

export function getNotchStyle() {
  const s = loadSettings();
  const attr = island?.getAttribute('data-style');
  return attr || s?.notch?.style || 'curved';
}

export function getNotchCornerRadius(w, h) {
  const style = getNotchStyle();
  if (style === 'floating') return Math.min(19, h / 2);
  if (island) {
    const cssR = parseFloat(window.getComputedStyle(island).borderBottomLeftRadius);
    if (Number.isFinite(cssR) && cssR > 0) {
      return Math.max(4, Math.min(cssR, w / 2 - 2, h / 2 - 1));
    }
  }
  const s = loadSettings();
  const rawR = Number(s?.appearance?.cornerRadius);
  const cfgR = Number.isFinite(rawR) ? rawR : 13;
  return Math.max(4, Math.min(cfgR, w / 2 - 2, h / 2 - 1));
}

export function islandCenterMetrics() {
  if (!island) return { left: 410, top: 0, width: 220, height: 36, cx: 410, style: 'curved', r: 13 };
  const rect = island.getBoundingClientRect();
  // Use visual viewport bounds (rect) so overlays on zoom-1 stage match zoomed #island dimensions
  const w = Math.max(60, rect.width || island.offsetWidth || 220);
  const h = Math.max(24, rect.height || island.offsetHeight || 36);
  const style = getNotchStyle();
  return {
    left: rect.left,
    top: rect.top,
    width: w,
    height: h,
    cx: rect.left + w / 2,
    style,
    r: getNotchCornerRadius(w, h)
  };
}

/**
 * Builds an SVG contour path synced cleanly to the two status pill styles:
 * - 'floating': full closed rounded pill loop
 * - 'attached' / 'curved' (bezel status mode): top-open U-contour matching the attached bottom edge
 */
export function buildIslandTracePath(w, h, style, rRaw) {
  const r = Math.max(4, Math.min(rRaw || 13, w / 2 - 2, h / 2 - 1));
  if (style === 'floating') {
    const padX = 3;
    const padY = 3;
    const x0 = padX;
    const y0 = padY;
    const x1 = padX + w;
    const y1 = padY + h;
    const mx = (x0 + x1) / 2;
    return {
      padX,
      padY,
      vbW: w + padX * 2,
      vbH: h + padY * 2,
      d: [
        `M ${mx},${y0}`,
        `H ${x1 - r}`,
        `A ${r} ${r} 0 0 1 ${x1},${y0 + r}`,
        `V ${y1 - r}`,
        `A ${r} ${r} 0 0 1 ${x1 - r},${y1}`,
        `H ${x0 + r}`,
        `A ${r} ${r} 0 0 1 ${x0},${y1 - r}`,
        `V ${y0 + r}`,
        `A ${r} ${r} 0 0 1 ${x0 + r},${y0}`,
        `Z`
      ].join(' ')
    };
  }

  // Bezel status notch (used by both Bezel and Curved notch styles on status pills)
  const padX = 2;
  const x0 = padX;
  const x1 = padX + w;
  const yBot = h + 0.5;
  return {
    padX,
    padY: 1,
    vbW: w + padX * 2,
    vbH: h + 5,
    d: `M ${x0},0.5 V ${yBot - r} Q ${x0},${yBot} ${x0 + r},${yBot} H ${x1 - r} Q ${x1},${yBot} ${x1},${yBot - r} V 0.5`
  };
}

export function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

export function getAnimConfig() {
  const s = loadSettings();
  return s?.animations || {
    enabled: false,
    tray: { enabled: false, id: 'bounce' },
    receive: { enabled: false, id: 'radar' },
    send: { enabled: false, id: 'beam' }
  };
}
