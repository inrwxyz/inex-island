// Unified File Receive Animation: Radar Drop + Continuous Downward File Drops
// 1) Two sonar rings radiate cleanly from OUTSIDE the island (Floating pill or Curved/Bezel shape)
// 2) Fixed-size expanded Accept/Decline card opens on compact island
// 3) On Accept (or active receive start), files drop continuously downward and fade softly until transfer finishes/cancels
import { island } from '../../../core/dom.js';
import { appState } from '../../../core/state.js';
import { bus } from '../../../core/bus.js';
import { reportIslandSize, ISLAND_WIN_W } from '../../../core/views.js';
import {
  nextToken, isToken, registerCleanup, spawnFxNode, removeChannelNodes,
  islandIsHidden, prefersReducedMotion, islandCenterMetrics, getNotchStyle
} from '../engine.js';

const FILE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';

let _radarTok = 0;
let _cardTimer = null;
let _streamTimer = null;
let _streamActive = false;
let _streamIsDemo = false;

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function stopStream() {
  _streamActive = false;
  _streamIsDemo = false;
  clearInterval(_streamTimer);
  _streamTimer = null;
}

function removeRadarCard(restoreHit = false) {
  clearTimeout(_cardTimer);
  _cardTimer = null;
  const wasOpen = !!(island?.classList.contains('anim-radar-card-open') || document.getElementById('anim-radar-card'));
  document.getElementById('anim-radar-card')?.remove();
  island?.classList.remove('anim-radar-card-open');
  if (restoreHit && wasOpen && !island?.classList.contains('bt-hud-active') && !island?.classList.contains('hud-pre')) {
    const isFloat = getNotchStyle() === 'floating';
    reportIslandSize({ width: ISLAND_WIN_W, height: isFloat ? 48 : 36 });
  }
}

export const receiveRadar = {
  id: 'radar',
  category: 'receive',
  label: 'Radar Drop',
  desc: 'Outer notch radar rings, Accept/Decline card, then continuous downward file drops until complete',

  isStreaming() {
    return _streamActive;
  },

  onIncoming(meta = {}) {
    if (!island || islandIsHidden()) return;
    stopStream();
    const tok = nextToken('receive');
    _radarTok = tok;

    registerCleanup('receive', () => {
      stopStream();
      removeRadarCard(true);
      removeChannelNodes('receive');
    });

    if (!prefersReducedMotion()) {
      const m = islandCenterMetrics();
      const isFloat = m.style === 'floating';
      const padX = 5;
      const padY = 4;
      const rw = Math.round(m.width + padX * 2);
      const rh = Math.round(m.height + padY + (isFloat ? padY : 0));
      const rx = Math.round(m.left - padX);
      const ry = isFloat ? Math.max(1, Math.round(m.top - padY)) : 0;

      for (let i = 0; i < 2; i++) {
        const r = spawnFxNode(`anim-radar-ring ${isFloat ? 'is-floating' : 'is-bezel'}`, '', {
          left: `${rx}px`,
          top: `${ry}px`,
          width: `${rw}px`,
          height: `${rh}px`
        }, 'receive');
        r.style.willChange = 'transform, opacity';
        r.animate(
          isFloat
            ? [
                { transform: 'scale(1, 1)', opacity: 0.8 },
                { transform: 'scale(1.22, 1.32)', opacity: 0 }
              ]
            : [
                { transform: 'scale(1, 1)', opacity: 0.8 },
                { transform: 'scale(1.24, 1.62)', opacity: 0 }
              ],
          { duration: 1180, delay: i * 330, easing: 'cubic-bezier(0.2, 0.6, 0.3, 1)', fill: 'both' }
        ).onfinish = () => r.remove();
      }
    }

    const showCard = () => {
      if (!isToken('receive', tok) || !island) return;
      bus.emit('hud:hide', true);
      const bar = island.querySelector('#view-compact .compact-bar');
      if (!bar) return;

      removeRadarCard(false);
      island.classList.add('anim-radar-card-open');
      reportIslandSize({ width: 320, height: 124 });

      const fName = esc(meta.fileName || 'Report.pdf');
      const sizeStr = esc(meta.sizeText || '14.2 MB');
      const senderStr = esc(meta.sender || 'Nearby device');

      const card = document.createElement('div');
      card.id = 'anim-radar-card';
      card.className = 'anim-radar-card';
      card.innerHTML =
        `<div class="anim-rc-top">` +
          `<span class="anim-rc-ico">${FILE_ICON_SVG}</span>` +
          `<div class="anim-rc-meta"><b>${fName}</b><span>${sizeStr} \u00B7 from ${senderStr}</span></div>` +
        `</div>` +
        `<div class="anim-rc-actions">` +
          `<button id="anim-rc-decline" class="anim-rc-btn decline" type="button">Decline</button>` +
          `<button id="anim-rc-accept" class="anim-rc-btn accept" type="button">Accept</button>` +
        `</div>`;
      bar.appendChild(card);

      let acted = false;
      const stopEvt = (e) => { e.stopPropagation(); };
      card.addEventListener('mousedown', stopEvt);
      card.addEventListener('click', stopEvt);

      const decBtn = card.querySelector('#anim-rc-decline');
      decBtn?.addEventListener('mousedown', stopEvt);
      decBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (acted) return;
        acted = true;
        decBtn.classList.add('is-pressed');
        removeRadarCard(true);
        if (typeof meta.onDecline === 'function') meta.onDecline();
      });

      const accBtn = card.querySelector('#anim-rc-accept');
      accBtn?.addEventListener('mousedown', stopEvt);
      accBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (acted) return;
        acted = true;
        accBtn.classList.add('is-pressed');
        removeRadarCard(true);
        if (typeof meta.onAccept === 'function') meta.onAccept();
      });
    };

    if (prefersReducedMotion()) {
      showCard();
    } else {
      _cardTimer = setTimeout(showCard, 620);
    }
  },

  onOfferClosed() {
    clearTimeout(_cardTimer);
    _cardTimer = null;
    removeRadarCard(true);
    // Keep any active transfer drop stream alive until transfer:finish!
    if (!_streamActive && !appState.transferring) {
      removeChannelNodes('receive');
    }
  },

  onAccepted(meta = {}) {
    if (!island || islandIsHidden() || prefersReducedMotion()) return;
    stopStream();
    removeRadarCard(false);
    const tok = nextToken('receive');
    _radarTok = tok;
    _streamActive = true;
    _streamIsDemo = !!meta.demo;

    registerCleanup('receive', () => {
      stopStream();
      removeRadarCard(true);
      removeChannelNodes('receive');
    });

    const offsets = [0, -18, 18];
    let dropIdx = 0;

    const dropOne = (label) => {
      if (!_streamActive || !isToken('receive', tok)) return;
      if (!_streamIsDemo && !appState.transferring && dropIdx > 0) {
        stopStream();
        return;
      }
      const m = islandCenterMetrics();
      const ox = offsets[dropIdx % offsets.length];
      dropIdx++;

      const doc = spawnFxNode(
        'anim-fly-doc',
        `<span>${esc(label || 'FILE').slice(0, 4).toUpperCase()}</span>`,
        {
          left: `${Math.round(m.cx + ox)}px`,
          top: `${Math.round(m.top + Math.max(8, m.height - 6))}px`
        },
        'receive'
      );
      doc.style.willChange = 'transform, opacity';

      doc.animate(
        [
          { transform: 'translate3d(-22px, -6px, 0) scale(0.55)', opacity: 0 },
          { transform: 'translate3d(-22px, 16px, 0) scale(0.88)', opacity: 0.92, offset: 0.2 },
          { transform: 'translate3d(-22px, 68px, 0) scale(0.76)', opacity: 0.48, offset: 0.68 },
          { transform: 'translate3d(-22px, 118px, 0) scale(0.58)', opacity: 0 }
        ],
        { duration: 960, easing: 'cubic-bezier(0.22, 0.72, 0.36, 1)', fill: 'forwards' }
      ).onfinish = () => doc.remove();
    };

    const fBase = String(meta.fileName || '');
    const extLabel = fBase.includes('.') ? fBase.split('.').pop() : 'FILE';
    dropOne(extLabel);

    _streamTimer = setInterval(() => {
      if (!_streamActive || !isToken('receive', tok)) {
        stopStream();
        return;
      }
      dropOne(extLabel);
    }, 640);
  },

  onFinish() {
    const tok = _radarTok;
    stopStream();
    removeRadarCard(true);
    setTimeout(() => {
      if (isToken('receive', tok)) removeChannelNodes('receive');
    }, 220);
  }
};
