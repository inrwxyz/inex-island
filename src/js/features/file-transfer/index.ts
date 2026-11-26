// Inex Drop & File Transfer Module (Quick Share + P2P WebRTC Direct Sharing + Side Rail)
export * from './rail.js';
export * from './quick-share.js';
export * from './p2p.js';

import { initQuickShare } from './quick-share.js';
import { initP2P } from './p2p.js';
import { initDropRail } from './rail.js';

export function initFileTransfer(): void {
  initQuickShare();
  initP2P();
  initDropRail();
}
