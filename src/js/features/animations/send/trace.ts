// File Send / Share Animation 2: Edge Trace
import { island } from '../../../core/dom.js';
import {
  nextToken, isToken, registerCleanup, buildIslandTracePath, createSvgEl,
  getNotchStyle, getNotchCornerRadius, islandIsHidden
} from '../engine.js';
import type { AnimationModule } from '../registry.js';

let _resizeObs: ResizeObserver | null = null;
let _transHandler: (() => void) | null = null;
let _lastPct = 0;
let _lastDir = 'send';
let _activeTok = 0;

function removeTraceOverlay(): void {
  if (_resizeObs) {
    try { _resizeObs.disconnect(); } catch { /* ignore */ }
    _resizeObs = null;
  }
  if (_transHandler && island) {
    island.removeEventListener('transitionend', _transHandler);
    _transHandler = null;
  }
  island?.classList.remove('anim-edge-trace', 'anim-trace-done');
  document.getElementById('anim-edge-svg')?.remove();
}

function mountOrUpdateSvg(pct: number, dir: string): void {
  if (!island) return;
  const w = Math.max(80, island.offsetWidth || 226);
  const h = Math.max(26, island.offsetHeight || 31);
  const style = getNotchStyle();
  const r = getNotchCornerRadius(w, h);
  const geo = buildIslandTracePath(w, h, style, r);
  const gradId = dir === 'recv' ? 'anim-tg-recv' : 'anim-tg-send';

  let svg = document.getElementById('anim-edge-svg') as SVGSVGElement | null;
  if (!svg) {
    svg = createSvgEl('svg', {
      id: 'anim-edge-svg',
      class: 'anim-edge-svg',
      'aria-hidden': 'true'
    });
    const defs = createSvgEl('defs');
    defs.innerHTML =
      `<linearGradient id="anim-tg-send" x1="0" y1="0" x2="1" y2="0">` +
        `<stop offset="0" stop-color="#ff9f0a"/>` +
        `<stop offset="0.5" stop-color="#ff375f"/>` +
        `<stop offset="1" stop-color="#bf5af2"/>` +
      `</linearGradient>` +
      `<linearGradient id="anim-tg-recv" x1="0" y1="0" x2="1" y2="0">` +
        `<stop offset="0" stop-color="#64d2ff"/>` +
        `<stop offset="0.5" stop-color="#0a84ff"/>` +
        `<stop offset="1" stop-color="#30d158"/>` +
      `</linearGradient>`;
    const track = createSvgEl('path', {
      id: 'anim-trace-track',
      class: 'anim-trace-track',
      pathLength: '100',
      fill: 'none'
    });
    const fg = createSvgEl('path', {
      id: 'anim-trace-fg',
      class: 'anim-trace-fg',
      pathLength: '100',
      fill: 'none',
      'stroke-dasharray': '100',
      'stroke-dashoffset': '100'
    });
    const pulse = createSvgEl('path', {
      id: 'anim-trace-pulse',
      class: 'anim-trace-pulse',
      pathLength: '100',
      fill: 'none',
      'stroke-dasharray': '18 82'
    });
    svg.append(defs, track, fg, pulse);
    island.appendChild(svg);
  }

  svg.setAttribute('width', String(geo.vbW));
  svg.setAttribute('height', String(geo.vbH));
  svg.setAttribute('viewBox', `0 0 ${geo.vbW} ${geo.vbH}`);
  svg.style.left = `${-geo.padX}px`;
  svg.style.top = `${-geo.padY}px`;

  const track = svg.querySelector('#anim-trace-track');
  const fg = svg.querySelector<SVGPathElement>('#anim-trace-fg');
  const pulse = svg.querySelector('#anim-trace-pulse');
  if (track) track.setAttribute('d', geo.d);
  if (fg) {
    fg.setAttribute('d', geo.d);
    fg.setAttribute('stroke', `url(#${gradId})`);
    fg.style.strokeDashoffset = String(Math.max(0, 100 - Math.max(0, Math.min(100, pct))));
  }
  if (pulse) {
    pulse.setAttribute('d', geo.d);
    pulse.setAttribute('stroke', `url(#${gradId})`);
  }
}

export const sendTrace: AnimationModule = {
  id: 'trace',
  category: 'send',
  label: 'Edge Trace',
  desc: 'Glowing perimeter line synced with Curved, Floating, or Bezel notch contour',

  onStart(meta: Record<string, unknown> = {}): void {
    if (!island || islandIsHidden()) return;
    _activeTok = nextToken('send');
    _lastPct = Number(meta.pct) || 0;
    _lastDir = (meta.dir as string) || 'send';
    registerCleanup('send', removeTraceOverlay);

    island.classList.add('anim-edge-trace');
    island.classList.remove('anim-trace-done');
    mountOrUpdateSvg(_lastPct, _lastDir);

    _transHandler = () => {
      if (isToken('send', _activeTok)) mountOrUpdateSvg(_lastPct, _lastDir);
    };
    island.addEventListener('transitionend', _transHandler);

    if (typeof window.ResizeObserver === 'function') {
      _resizeObs = new window.ResizeObserver(() => {
        if (!isToken('send', _activeTok)) return;
        mountOrUpdateSvg(_lastPct, _lastDir);
      });
      _resizeObs.observe(island);
    }
  },

  onProgress(pct = 0, dir?: string): void {
    if (!island || !document.getElementById('anim-edge-svg')) return;
    _lastPct = Math.max(0, Math.min(100, Number(pct) || 0));
    if (dir) _lastDir = dir;
    const fg = document.getElementById('anim-trace-fg') as SVGPathElement | null;
    if (fg) fg.style.strokeDashoffset = String(100 - _lastPct);
  },

  onFinish(ok = true): void {
    if (!island) { removeTraceOverlay(); return; }
    if (!ok) {
      removeTraceOverlay();
      return;
    }
    _lastPct = 100;
    const fg = document.getElementById('anim-trace-fg') as SVGPathElement | null;
    if (fg) {
      fg.style.strokeDashoffset = '0';
      fg.setAttribute('stroke', '#30d158');
    }
    island.classList.add('anim-trace-done');
    const tok = _activeTok;
    setTimeout(() => {
      if (isToken('send', tok)) removeTraceOverlay();
    }, 1150);
  }
};
