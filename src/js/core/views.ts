// Core view switching and island window dimension management
import { island } from './dom.js';
import { appState } from './state.js';
import { bus } from './bus.js';
import { invokeTauri } from './tauri.js';
import { loadSettings } from './settings.js';
import type { IslandSize } from '../../types/models.js';

export const ISLAND_WIN_W = 548;
export const MEDIA_H = 166;
export const MEDIA_H_VOL = 218;
const HIT_SIDE_PAD = 40;

let _lastHitW = 0;
let _lastHitH = 0;
let _hitReq: IslandSize | null = null;
let _menuCloseT: ReturnType<typeof setTimeout> | undefined;
let _wasCompactBusy = false;

function realHitWidth(nominalW: number): number {
  if (!island) return nominalW;
  try {
    const w = parseFloat(getComputedStyle(island).width);
    if (w > 40) return Math.min(nominalW, Math.ceil(w) + HIT_SIDE_PAD);
  } catch (err) {
    console.warn('[views] Error computing hit width:', err);
  }
  return nominalW;
}

export function isMenuView(viewId: string | null | undefined): boolean {
  return !!viewId && viewId !== 'view-compact' && viewId !== 'view-media' && viewId !== 'view-audio' && viewId !== 'view-timer-live';
}

export function reportIslandSize(size: IslandSize | null | undefined): Promise<void> {
  if (!size) return Promise.resolve();
  appState.islandSize = { width: size.width, height: size.height };
  _hitReq = { width: size.width, height: size.height };
  const SET = loadSettings();
  const isMenu = isMenuView(appState.currentView);
  const k = isMenu ? 1.10 : (((SET.appearance && SET.appearance.scale) ? SET.appearance.scale : 125) / 100);
  const w = size.height <= 112 ? realHitWidth(size.width) : size.width;
  const hw = Math.round(w * k);
  const hh = Math.round(size.height * k);
  if (hw === _lastHitW && hh === _lastHitH) return Promise.resolve();
  _lastHitW = hw;
  _lastHitH = hh;
  return invokeTauri('set_island_hit', { width: hw, height: hh })
    .then(() => undefined)
    .catch((err) => {
      console.warn('[views] Tauri set_island_hit error:', err);
    });
}

export function triggerCloseEase(ms = 700): void {
  if (!island) return;
  clearTimeout(_menuCloseT);
  island.classList.add('menu-closing');
  _menuCloseT = setTimeout(() => {
    if (island) island.classList.remove('menu-closing');
  }, ms);
}

export function cancelCloseEase(): void {
  if (!island) return;
  clearTimeout(_menuCloseT);
  island.classList.remove('menu-closing');
}

export function updateCompactStateClasses(): void {
  if (!island) return;
  const isPrompt = !!(appState.prompting || appState.lockerPrompting);
  const isBusy = !!(appState.transferring || isPrompt || appState.toast);
  const hasBadges = (appState.trayFiles?.length || 0) > 0 || (appState.peers?.length || 0) > 0;
  if (_wasCompactBusy && !isBusy && island.classList.contains('state-compact') &&
      !island.classList.contains('bt-hud-active') && !island.classList.contains('alarm-active') &&
      !island.classList.contains('biometric-active')) {
    triggerCloseEase(650);
  } else if (!_wasCompactBusy && isBusy) {
    cancelCloseEase();
  }
  _wasCompactBusy = isBusy;
  island.classList.toggle('has-toast', !!appState.toast);
  island.classList.toggle('has-badges', hasBadges && !appState.mediaPlaying && !isBusy);
  island.classList.toggle('media-active', !!appState.mediaPlaying && !isBusy);
}

export function goCompact(): void {
  if (!island) return;
  island.classList.remove('vol-open');
  appState.volOpen = false;
  const trayPeerPicker = document.getElementById('tray-peer-picker');
  if (trayPeerPicker) trayPeerPicker.classList.add('hidden');
  bus.emit('view:go-compact');
}

export function switchView(id: string, state: string, w: number, h: number): void {
  if (typeof window.switchView === 'function') {
    window.switchView(id, state, w, h);
  }
}

if (typeof window.ResizeObserver === 'function' && island) {
  new window.ResizeObserver(() => {
    if (_hitReq && _hitReq.height <= 112) reportIslandSize(_hitReq);
  }).observe(island);
}
