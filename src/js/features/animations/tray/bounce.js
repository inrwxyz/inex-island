// Tray Drop Animation: Soft Bounce (works in both Classic Tray and Control Deck Tray)
import { island } from '../../../core/dom.js';
import {
  nextToken, isToken, registerCleanup, spawnFxNode,
  removeChannelNodes, islandIsHidden, prefersReducedMotion
} from '../engine.js';

export const trayBounce = {
  id: 'bounce',
  category: 'tray',
  label: 'Soft Bounce',
  desc: 'File drops gently into tray, island squashes softly, tile pops in',

  play({ menuLayout = 'classic', addedPaths = [] } = {}) {
    if (!island || islandIsHidden() || prefersReducedMotion()) return;
    const tok = nextToken('tray');

    registerCleanup('tray', () => {
      removeChannelNodes('tray');
      island.getAnimations?.().forEach((a) => {
        if (a.id === 'anim-tray-bounce') a.cancel();
      });
    });

    const isDeck = menuLayout === 'deck' || island.classList.contains('state-tray-deck');
    const targetBox = isDeck
      ? (document.getElementById('mt-files') || document.getElementById('mt-tray'))
      : document.getElementById('tray-files-list');

    const m = island.getBoundingClientRect();
    const tRect = targetBox ? targetBox.getBoundingClientRect() : null;
    const startX = m.left + m.width / 2;
    const targetY = tRect && tRect.height > 8 ? (tRect.top + tRect.height / 2 - 14) : (m.top + 95);

    const dropFile = spawnFxNode(
      'anim-drop-doc',
      '<span class="anim-doc-tag">FILE</span>',
      { left: `${Math.round(startX)}px`, top: '-36px' },
      'tray'
    );
    dropFile.style.willChange = 'transform, opacity';

    const dist = Math.max(60, Math.round(targetY + 36));
    const fallAnim = dropFile.animate(
      [
        { transform: 'translate3d(-13px, 0, 0) rotate(-12deg) scale(0.9)', opacity: 0.95 },
        { transform: `translate3d(-13px, ${dist}px, 0) rotate(3deg) scale(0.96)`, opacity: 1 }
      ],
      { duration: 420, easing: 'cubic-bezier(0.55, 0, 1, 0.6)', fill: 'forwards' }
    );

    fallAnim.onfinish = () => {
      dropFile.remove();
      if (!isToken('tray', tok)) return;

      const sq = island.animate(
        [
          { transform: 'scale(1, 1)' },
          { transform: 'scale(1.025, 0.96)', offset: 0.25 },
          { transform: 'scale(0.99, 1.02)', offset: 0.55 },
          { transform: 'scale(1, 1)' }
        ],
        { id: 'anim-tray-bounce', duration: 540, easing: 'ease-out' }
      );
      sq.onfinish = () => { /* natural finish */ };

      const tileSel = isDeck ? '#mt-files .mt-file' : '#tray-files-list .tray-file-card';
      const cards = Array.from(document.querySelectorAll(tileSel));
      const popList = addedPaths.length
        ? cards.slice(-Math.min(4, addedPaths.length))
        : cards.slice(-1);

      popList.forEach((card, idx) => {
        card.style.willChange = 'transform, opacity';
        const popAnim = card.animate(
          [
            { transform: 'scale(0.3)', opacity: 0 },
            { transform: 'scale(1.15)', opacity: 1, offset: 0.6 },
            { transform: 'scale(0.96)', offset: 0.8 },
            { transform: 'scale(1)', opacity: 1 }
          ],
          { duration: 460, delay: idx * 45, easing: 'ease-out', fill: 'both' }
        );
        popAnim.onfinish = () => { card.style.willChange = 'auto'; };
      });
    };
  }
};
