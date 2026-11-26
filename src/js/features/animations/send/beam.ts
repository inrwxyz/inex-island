// File Send / Share Animation 1: Launch Beam
import { island } from '../../../core/dom.js';
import {
  nextToken, registerCleanup, spawnFxNode, removeChannelNodes,
  islandIsHidden, prefersReducedMotion, islandCenterMetrics
} from '../engine.js';
import type { AnimationModule } from '../registry.js';

const FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
const PC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';

function ensureBeamDom(): HTMLElement | null {
  const host = document.getElementById('c-transfer-anim');
  if (!host) return null;
  let beam = document.getElementById('anim-beam-ui');
  if (!beam) {
    beam = document.createElement('div');
    beam.id = 'anim-beam-ui';
    beam.className = 'anim-beam-ui';
    beam.innerHTML =
      `<span class="anim-b-disc is-src">${FILE_SVG}</span>` +
      `<span class="anim-b-track">` +
        `<i id="anim-b-fill" class="anim-b-fill"></i>` +
        `<i class="anim-b-sheen"></i>` +
      `</span>` +
      `<span class="anim-b-disc is-dst">${PC_SVG}</span>` +
      `<span id="anim-b-pct" class="anim-b-pct">0%</span>`;
    host.appendChild(beam);
  }
  return beam;
}

function clearBeamDom(): void {
  island?.classList.remove('anim-send-beam', 'anim-beam-done');
  document.getElementById('anim-beam-ui')?.remove();
  removeChannelNodes('send');
}

export const sendBeam: AnimationModule = {
  id: 'beam',
  category: 'send',
  label: 'Launch Beam',
  desc: 'Status HUD gradient progress beam with completion burst',

  onStart(meta: Record<string, unknown> = {}): void {
    if (!island || islandIsHidden()) return;
    nextToken('send');
    registerCleanup('send', clearBeamDom);

    island.classList.add('anim-send-beam');
    island.classList.remove('anim-beam-done');
    ensureBeamDom();
    this.onProgress?.(Number(meta.pct) || 0);
  },

  onProgress(pct = 0): void {
    if (!island) return;
    const fill = document.getElementById('anim-b-fill');
    const pctEl = document.getElementById('anim-b-pct');
    const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (fill) fill.style.transform = `scaleX(${(v / 100).toFixed(3)})`;
    if (pctEl) pctEl.textContent = `${v}%`;
  },

  onFinish(ok = true): void {
    if (!island) { clearBeamDom(); return; }
    island.classList.remove('anim-send-beam');
    if (ok && !islandIsHidden() && !prefersReducedMotion()) {
      island.classList.add('anim-beam-done');
      const m = islandCenterMetrics();
      const colors = ['#0a84ff', '#bf5af2', '#ff375f', '#30d158'];
      const sx = m.left + m.width - 14;
      const sy = m.top + m.height * 0.5;
      for (let i = 0; i < 8; i++) {
        const q = spawnFxNode('anim-confetti-dot', '', {
          left: `${Math.round(sx)}px`,
          top: `${Math.round(sy)}px`,
          background: colors[i % colors.length]
        }, 'send');
        q.style.willChange = 'transform, opacity';
        q.animate(
          [
            { transform: 'translate3d(0, 0, 0)', opacity: 1 },
            { transform: `translate3d(${16 + i * 7}px, ${(i % 2 ? 1 : -1) * (8 + i * 3) + 18}px, 0)`, opacity: 0 }
          ],
          { duration: 760, easing: 'ease-out', fill: 'forwards' }
        ).onfinish = () => q.remove();
      }
      setTimeout(() => clearBeamDom(), 900);
    } else {
      clearBeamDom();
    }
  }
};
