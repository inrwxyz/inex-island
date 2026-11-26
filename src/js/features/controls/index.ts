// Control Deck & Classic Menu Tiles, Radios, Quick Action Buttons, and In-Place Subviews
import { appState } from '../../core/state.js';
import { loadSettings } from '../../core/settings.js';
import { bus } from '../../core/bus.js';
import { invokeTauri } from '../../core/tauri.js';
import { goCompact, switchView, reportIslandSize, ISLAND_WIN_W } from '../../core/views.js';
import { syncDeckBtTileIcon, refreshBtCaption, loadBtList } from '../bluetooth/index.js';
import { loadWifiList } from '../wifi/index.js';
import { suspendFocusTimer, renderCalendarGrid, focusNotepad } from '../timer/index.js';
import { openAlarmView } from '../alarm/index.js';
import { openClipboardView, closeClipboardView } from '../clipboard/index.js';
import { openDropView, openDeckDrop, syncDropRail, refreshDropUI, openP2PView, openQsView, currentOffer, inTransfer, getDropMode, toggleInexDrop } from '../file-transfer/index.js';
import { openTrayView, openDeckTrayView, closeDeckTrayPane, deckTrayPaneOpen, updateTrayUI } from '../tray/index.js';
import { initVolume } from '../volume/index.js';
import { initBrightness } from '../brightness/index.js';

export interface DeckSubTarget {
  id: string;
  parent: ParentNode | null;
  next: ChildNode | null;
  moved?: Array<{ el: HTMLElement; parent: ParentNode | null; next: ChildNode | null }>;
  actions?: Element | null;
  actionsParent?: ParentNode | null;
  actionsNext?: ChildNode | null;
}

export interface AudioDevice {
  id: string;
  name: string;
  is_default?: boolean;
}

export let awakeState = false;
let _suspendingAwake = false;
export let currentDeckSubTarget: DeckSubTarget | null = null;
let lastAudioOrigin = 'view-media';

const MEDIA_H = 166;
const MEDIA_H_VOL = 218;

export function isDeckLayout(): boolean {
  const SET = loadSettings();
  return !SET.appearance || SET.appearance.menuLayout === 'deck';
}

export function isBtViewOpen(): boolean {
  return appState.currentView === 'view-bt' || !!(currentDeckSubTarget && currentDeckSubTarget.id === 'view-bt');
}

export function isWifiViewOpen(): boolean {
  return appState.currentView === 'view-wifi' || !!(currentDeckSubTarget && currentDeckSubTarget.id === 'view-wifi');
}

export function applyPresence(kind: 'wifi' | 'bt', present: boolean): void {
  const key = kind === 'wifi' ? 'wifiPresent' : 'btPresent';
  if (appState[key] === present) return;
  appState[key] = present;
  const label = kind === 'wifi' ? 'Wi-Fi' : 'Bluetooth';
  const tiles = kind === 'wifi' ? ['tile-wifi', 'deck-tile-wifi'] : ['tile-bt', 'deck-tile-bt'];
  tiles.forEach((id) => {
    const t = document.getElementById(id);
    if (!t) return;
    t.classList.toggle('unavailable', !present);
    t.setAttribute('aria-disabled', String(!present));
    t.title = present ? '' : `No ${label} adapter found`;
    if (!present) t.classList.remove('active');
  });
  const tog = document.getElementById(kind === 'wifi' ? 'wifi-master-toggle' : 'bt-master-toggle') as HTMLInputElement | null;
  if (tog) {
    tog.disabled = !present;
    if (!present) tog.checked = false;
  }
  if (!present) {
    if (kind === 'wifi') appState.wifiRadio = false;
    else appState.btRadio = false;
    (kind === 'wifi' ? ['wifi-sub', 'deck-wifi-sub'] : ['bt-sub', 'deck-bt-sub']).forEach((id) => {
      const e = document.getElementById(id);
      if (e) e.textContent = 'No adapter';
    });
    const cap = document.getElementById(kind === 'wifi' ? 'wifi-cap' : 'bt-cap');
    if (cap) cap.textContent = '';
    if (kind === 'bt') syncDeckBtTileIcon(null);
    const open = kind === 'wifi' ? isWifiViewOpen() : isBtViewOpen();
    if (open) {
      if (currentDeckSubTarget) closeDeckSub();
      else if (typeof window.openControlMenu === 'function') window.openControlMenu();
    }
  } else {
    if (typeof window.refreshRadios === 'function') {
      window.refreshRadios().catch((err) => console.warn('refreshRadios failed:', err));
    }
    if (kind === 'bt') void refreshBtCaption();
    if (kind === 'wifi' && typeof window.refreshWifiNow === 'function') void window.refreshWifiNow();
  }
}

export function applyRadio(kind: 'wifi' | 'bt', on: boolean): void {
  if (kind === 'wifi' ? appState.wifiPresent === false : appState.btPresent === false) return;
  if (kind === 'wifi') {
    appState.wifiRadio = on;
    document.getElementById('tile-wifi')?.classList.toggle('active', on);
    const wifiSub = document.getElementById('wifi-sub');
    if (wifiSub && !on) wifiSub.textContent = 'Off';
    const tog = document.getElementById('wifi-master-toggle') as HTMLInputElement | null;
    if (tog) tog.checked = on;
    const deckTile = document.getElementById('deck-tile-wifi');
    const deckSub = document.getElementById('deck-wifi-sub');
    if (deckTile) deckTile.classList.toggle('active', on);
    if (deckSub) {
      if (!on) deckSub.textContent = 'Off';
      else if (appState.stats && appState.stats.wifi_name && appState.stats.wifi_name !== 'Not connected') {
        deckSub.textContent = String(appState.stats.wifi_name);
      } else {
        deckSub.textContent = 'On';
      }
    }
  } else {
    appState.btRadio = on;
    document.getElementById('tile-bt')?.classList.toggle('active', on);
    const btSub = document.getElementById('bt-sub');
    if (btSub) btSub.textContent = on ? 'On' : 'Off';
    const tog = document.getElementById('bt-master-toggle') as HTMLInputElement | null;
    if (tog) tog.checked = on;
    const deckTile = document.getElementById('deck-tile-bt');
    const deckSub = document.getElementById('deck-bt-sub');
    if (deckTile) deckTile.classList.toggle('active', on);
    if (deckSub && !on) deckSub.textContent = 'Off';
    else if (deckSub && on && deckSub.textContent === 'Off') deckSub.textContent = 'On';
  }
}

export async function toggleRadio(kind: 'wifi' | 'bt', on: boolean): Promise<void> {
  if (kind === 'wifi' ? appState.wifiPresent === false : appState.btPresent === false) return;
  applyRadio(kind, on);
  try {
    await invokeTauri('set_radio_state', { kind, on });
  } catch (err) {
    console.warn('radio toggle failed', err);
  }
  const real = await invokeTauri<boolean>('get_radio_state', { kind });
  if (typeof real === 'boolean') applyRadio(kind, real);
  if (kind === 'wifi' && appState.currentView === 'view-wifi') setTimeout(loadWifiList, on ? 2000 : 0);
}

export const ACTION_TILE_ICONS: Record<string, string> = {
  mic: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line class="q-mic-slash" x1="3" y1="3" x2="21" y2="21"/></svg>',
  awake: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  snip: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  timer: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><line x1="9" y1="2" x2="15" y2="2"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83 2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  alarm: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  calc: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M8 18h.01M12 18h.01"/></svg>',
  restart: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  notepad: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8z"/><path d="M15 3v5h5"/><path d="M8 13h8M8 17h5"/></svg>',
  drop: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M12 2v10M8 8l4-4 4 4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>'
};

export const ACTION_TILE_TITLES: Record<string, string> = {
  awake: 'Keep screen awake: off',
  mic: 'Microphone mute',
  snip: 'Screenshot Snip',
  calendar: 'Monthly Calendar',
  timer: 'Focus Timer',
  clipboard: 'Clipboard History',
  lock: 'Lock PC',
  settings: 'Open Settings',
  alarm: 'Alarm',
  calc: 'Calculator',
  restart: 'Restart Inex Island',
  notepad: 'Quick Notes',
  drop: 'Inex Drop'
};

export function syncMicQuickUi(m: boolean | null | undefined): void {
  const none = m === null || m === undefined;
  const title = none ? 'Microphone: no mic' : m ? 'Microphone: muted (click to unmute)' : 'Microphone: on (click to mute)';
  const el = document.getElementById('act-mic');
  if (!el) return;
  el.classList.toggle('muted', m === true);
  el.title = title;
}

export async function toggleKeepAwake(): Promise<void> {
  const want = !awakeState;
  const on = await invokeTauri<boolean>('set_keep_awake', { on: want });
  awakeState = on === true;
  syncAwakeUi();
}

export function syncAwakeUi(): void {
  const title = awakeState ? 'Keep screen awake: ON' : 'Keep screen awake: off';
  ['act-awake', 'deck-awake-btn'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active', awakeState);
    el.title = title;
  });
}

export const DEFAULT_ACTION_TILES = ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings'];
export const DECK_ACTIVE_TILES = ['notepad', 'clipboard', 'timer', 'calendar', 'snip'];

export function getActiveQuickTiles(): string[] {
  const SET = loadSettings();
  if (isDeckLayout()) return DECK_ACTIVE_TILES.concat('awake');
  const cfg = SET.menu && Array.isArray(SET.menu.actionTiles) && SET.menu.actionTiles.length ? SET.menu.actionTiles : DEFAULT_ACTION_TILES;
  return cfg.slice(0, 7);
}

export function suspendInactiveFeatures(): void {
  const active = getActiveQuickTiles();
  if (awakeState === true && !active.includes('awake') && !_suspendingAwake) {
    _suspendingAwake = true;
    awakeState = false;
    syncAwakeUi();
    Promise.resolve(invokeTauri('set_keep_awake', { on: false }))
      .catch((err) => console.warn('set_keep_awake error:', err))
      .finally(() => { _suspendingAwake = false; });
  }

  if (appState.timerRunning === true && !active.includes('timer')) {
    suspendFocusTimer();
  }
}

export function renderQuickActionTiles(): void {
  const row = document.getElementById('quick-icons-row');
  if (!row) return;
  const SET = loadSettings();
  const list = (SET.menu && Array.isArray(SET.menu.actionTiles) && SET.menu.actionTiles.length)
    ? SET.menu.actionTiles
    : DEFAULT_ACTION_TILES;

  row.innerHTML = '';
  list.slice(0, 7).forEach((id) => {
    const ico = ACTION_TILE_ICONS[id];
    const title = ACTION_TILE_TITLES[id] || id;
    if (!ico) return;

    const btn = document.createElement('button');
    btn.className = 'q-icon-btn';
    btn.id = `act-${id}`;
    btn.title = title;
    btn.innerHTML = ico;

    if (id === 'awake') {
      btn.classList.toggle('active', awakeState);
      btn.title = awakeState ? 'Keep screen awake: ON' : 'Keep screen awake: off';
      btn.addEventListener('click', () => {
        void toggleKeepAwake();
      });
    } else if (id === 'mic') {
      btn.addEventListener('click', () => {
        if (typeof window.toggleMic === 'function') void window.toggleMic();
      });
    } else if (id === 'snip') {
      btn.addEventListener('click', () => {
        goCompact();
        invokeTauri('take_snip');
      });
    } else if (id === 'calendar') {
      btn.addEventListener('click', () => {
        switchView('view-calendar', 'state-sub', 316, 225);
        renderCalendarGrid();
      });
    } else if (id === 'timer') {
      btn.classList.toggle('active', !!appState.timerRunning);
      btn.addEventListener('click', () => {
        switchView('view-timer', 'state-sub', 316, 200);
      });
    } else if (id === 'alarm') {
      btn.addEventListener('click', () => {
        switchView('view-alarm', 'state-sub', 316, 238);
        openAlarmView();
      });
    } else if (id === 'clipboard') {
      btn.addEventListener('click', () => {
        switchView('view-clipboard', 'state-sub', ISLAND_WIN_W, 260);
        openClipboardView();
      });
    } else if (id === 'lock') {
      btn.addEventListener('click', () => invokeTauri('lock_screen'));
    } else if (id === 'settings') {
      btn.addEventListener('click', () => invokeTauri('open_settings'));
    } else if (id === 'restart') {
      btn.addEventListener('click', () => invokeTauri('restart_app'));
    } else if (id === 'notepad') {
      btn.addEventListener('click', () => {
        switchView('view-notepad', 'state-sub', 316, 240);
        focusNotepad();
      });
    } else if (id === 'drop') {
      btn.addEventListener('click', () => {
        openDropView();
      });
    } else {
      btn.addEventListener('click', () => {
        invokeTauri('launch_quick_action', { id });
      });
    }

    row.appendChild(btn);
  });
  syncMicQuickUi((window as unknown as { micMutedState?: boolean | null }).micMutedState ?? null);
  suspendInactiveFeatures();
}

export function shortAudioLabel(rawName: string | undefined): string {
  const s = (rawName || '').trim();
  if (!s) return 'This PC';
  const m = s.match(/^([^(]+)\(([^)]+)\)/);
  if (m) {
    const kind = m[1].trim();
    const detail = m[2].trim();
    const low = kind.toLowerCase();
    if (low.includes('headphone') || low.includes('headset') || low.includes('earphone') || low.includes('buds')) {
      return detail && !/realtek|high definition|usb|bluetooth/i.test(detail) ? detail : kind;
    }
    return kind;
  }
  return s;
}

export async function refreshActiveAudioName(): Promise<string> {
  try {
    const devices = await invokeTauri<AudioDevice[]>('get_audio_devices');
    if (!Array.isArray(devices) || !devices.length) return '';
    const active = devices.find((d) => d.is_default) || devices[0];
    const next = shortAudioLabel(active?.name);
    if (next && next !== appState.activeAudioName) {
      appState.activeAudioName = next;
      bus.emit('audio:device-updated', next);
    }
    return next;
  } catch {
    return '';
  }
}

export function openAudioView(): void {
  lastAudioOrigin = (appState.currentView === 'view-media') ? 'view-media' : 'view-control';
  switchView('view-audio', 'state-sub', 316, 166);
  void loadAudioDeviceList(false);
}

let _lastAudioSig = '';

export async function loadAudioDeviceList(spin: boolean): Promise<void> {
  const listEl = document.getElementById('audio-device-list');
  const refBtn = document.getElementById('btn-refresh-audio');
  if (!listEl) return;
  if (spin && refBtn) refBtn.classList.add('spin');
  const hasRows = !!listEl.querySelector('.list-row-item');
  if (!hasRows) {
    listEl.innerHTML = '<div class="empty-hint">Scanning audio outputs\u2026</div>';
  }

  try {
    const devices = await invokeTauri<AudioDevice[]>('get_audio_devices');
    if (spin && refBtn) setTimeout(() => refBtn.classList.remove('spin'), 400);

    if (!Array.isArray(devices) || devices.length === 0) {
      _lastAudioSig = '';
      listEl.innerHTML = '<div class="empty-hint">No audio outputs detected</div>';
      return;
    }

    const activeDev = devices.find((d) => d.is_default) || devices[0];
    const activeShort = shortAudioLabel(activeDev?.name);
    if (activeShort && activeShort !== appState.activeAudioName) {
      appState.activeAudioName = activeShort;
      bus.emit('audio:device-updated', activeShort);
    }

    const sig = devices.map((d) => `${d.id}|${d.name}|${d.is_default ? '1' : '0'}`).join('\n');
    if (hasRows && sig === _lastAudioSig) return;
    _lastAudioSig = sig;

    const frag = document.createDocumentFragment();
    devices.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'list-row-item' + (d.is_default ? ' on active-audio' : '');

      const lower = d.name.toLowerCase();
      let icoSvg = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      if (lower.includes('headphone') || lower.includes('buds') || lower.includes('airpod') || lower.includes('headset') || lower.includes('earphone')) {
        icoSvg = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
      }

      const ico = document.createElement('span');
      ico.className = 'dev-ico';
      ico.innerHTML = icoSvg;

      const text = document.createElement('div');
      text.className = 'row-text';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = d.name;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = d.is_default ? 'Active Output' : 'Tap to switch';
      text.append(name, sub);

      const statusBadge = document.createElement('div');
      statusBadge.className = 'audio-check-badge';
      statusBadge.innerHTML = d.is_default
        ? '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.5" fill="none"><polyline points="20 6 9 17 4 12"/></svg>'
        : '';

      row.append(ico, text, statusBadge);

      row.addEventListener('click', async () => {
        if (d.is_default) return;
        sub.textContent = 'Switching\u2026';
        await invokeTauri('set_default_audio_device', { id: d.id });
        setTimeout(() => {
          if (appState.currentView === 'view-audio') void loadAudioDeviceList(false);
        }, 200);
      });

      frag.appendChild(row);
    });
    listEl.replaceChildren(frag);
  } catch {
    if (spin && refBtn) refBtn.classList.remove('spin');
    if (!hasRows) listEl.innerHTML = '<div class="empty-hint">Failed to load audio devices</div>';
  }
}

export function mountP2PBarItems(slot: HTMLElement): void {
  if (!currentDeckSubTarget) return;
  const wrap = document.createElement('div');
  wrap.className = 'deck-p2p-actions';
  currentDeckSubTarget.moved = [];
  ['p2p-expiry-timer', 'btn-exit-room', 'p2p-status-pill'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || !currentDeckSubTarget?.moved) return;
    currentDeckSubTarget.moved.push({ el, parent: el.parentNode, next: el.nextSibling });
    wrap.appendChild(el);
  });
  slot.appendChild(wrap);
}

const DECK_QUICK_VIEW: Record<string, string> = { 'view-notepad': 'notepad', 'view-clipboard': 'clipboard', 'view-timer': 'timer', 'view-calendar': 'calendar' };
function syncDeckQuickActive(viewId: string | null): void {
  const act = viewId ? DECK_QUICK_VIEW[viewId] : null;
  document.querySelectorAll('#deck-quick-row .mx-q').forEach((b) => {
    b.classList.toggle('active', !!act && (b as HTMLElement).dataset.action === act);
  });
}

export function closeDeckSub(): void {
  syncDeckQuickActive(null);
  if (!currentDeckSubTarget) return;
  const el = document.getElementById(currentDeckSubTarget.id);
  if (currentDeckSubTarget.moved) {
    for (let i = currentDeckSubTarget.moved.length - 1; i >= 0; i--) {
      const m = currentDeckSubTarget.moved[i];
      if (m.parent) m.parent.insertBefore(m.el, m.next);
    }
  }
  if (currentDeckSubTarget.actions && currentDeckSubTarget.actionsParent) {
    currentDeckSubTarget.actionsParent.insertBefore(currentDeckSubTarget.actions, currentDeckSubTarget.actionsNext || null);
  }
  const actionsSlot = document.getElementById('deck-sub-actions');
  if (actionsSlot) actionsSlot.innerHTML = '';
  document.getElementById('deck-sub-mount')?.classList.remove('no-scroll');
  if (el && currentDeckSubTarget.parent) {
    el.classList.remove('active', 'in-deck-sub');
    currentDeckSubTarget.parent.insertBefore(el, currentDeckSubTarget.next);
  }
  if (currentDeckSubTarget.id === 'view-bt') {
    invokeTauri('bt_discovery', { on: false });
  }
  if (currentDeckSubTarget.id === 'view-clipboard') {
    closeClipboardView();
  }
  currentDeckSubTarget = null;
  appState.deckSubId = null;
  const island = document.getElementById('island');
  if (island) island.classList.remove('has-rail');
  document.getElementById('deck-right-sub')?.classList.add('hidden');
  document.getElementById('deck-right-home')?.classList.remove('hidden');
}

export function openDeckSub(viewId: string, title?: string, from?: string): void {
  if ((viewId === 'view-bt' && appState.btPresent === false) || (viewId === 'view-wifi' && appState.wifiPresent === false)) return;
  bus.emit('prayer:close');
  bus.emit('weather:close-deck');
  closeDeckTrayPane();
  closeDeckSub();
  const src = document.getElementById(viewId);
  const mount = document.getElementById('deck-sub-mount');
  const actionsSlot = document.getElementById('deck-sub-actions');
  if (!src || !mount) return;
  currentDeckSubTarget = { id: viewId, parent: src.parentNode, next: src.nextSibling };
  appState.deckSubId = viewId;
  mount.appendChild(src);
  mount.classList.toggle('no-scroll', viewId === 'view-inexdrop' || viewId === 'view-p2p' || viewId === 'view-timer');
  src.classList.add('active', 'in-deck-sub');
  syncDeckQuickActive(viewId);
  const titleEl = document.getElementById('deck-sub-title');
  if (titleEl) titleEl.textContent = title || '';

  if (actionsSlot) {
    actionsSlot.innerHTML = '';
    const headerRight = src.querySelector('.bt-header-right, .panel-top-right, .qs-header-right, .cal-nav-bar, .top-tool-btn');
    if (headerRight) {
      currentDeckSubTarget.actions = headerRight;
      currentDeckSubTarget.actionsParent = headerRight.parentNode;
      currentDeckSubTarget.actionsNext = headerRight.nextSibling;
      actionsSlot.appendChild(headerRight);
    }
    if (viewId === 'view-p2p') mountP2PBarItems(actionsSlot);
  }

  document.getElementById('deck-right-home')?.classList.add('hidden');
  const subPanel = document.getElementById('deck-right-sub');
  if (subPanel) {
    subPanel.classList.remove('from-bottom');
    subPanel.classList.remove('hidden');
    if (from === 'bottom') {
      const host = subPanel.parentElement;
      if (host) {
        host.classList.add('mx-clip');
        void subPanel.offsetWidth;
        subPanel.classList.add('from-bottom');
        setTimeout(() => host.classList.remove('mx-clip'), 420);
      }
    }
  }

  if (viewId === 'view-wifi') {
    invokeTauri('wifi_backend', { on: true }).catch((err) => console.warn('Tauri invoke error:', err));
    void loadWifiList();
  }
  if (viewId === 'view-bt') {
    invokeTauri('bt_backend', { on: true }).catch((err) => console.warn('Tauri invoke error:', err));
    invokeTauri('bt_discovery', { on: true }).catch((err) => console.warn('Tauri invoke error:', err));
    void loadBtList();
  }
  if (viewId === 'view-tray') updateTrayUI();
  if (viewId === 'view-calendar') renderCalendarGrid();
  if (viewId === 'view-notepad') focusNotepad();
  if (viewId === 'view-clipboard') openClipboardView();
  if (viewId === 'view-alarm') openAlarmView();
  if (viewId === 'view-inexdrop') void refreshDropUI();
  if (viewId === 'view-p2p') invokeTauri('focus_island').catch(() => {});
  syncDropRail(viewId);
}

// Inex Drop (Quick Share / P2P) inside the deck menu's right-hand panel; the side rail swaps between the two.
function openDeckDropPanel(mode?: string): void {
  if (appState.currentView !== 'view-control-deck' && typeof window.openControlMenu === 'function') window.openControlMenu();
  if (mode === 'p2p') openDeckSub('view-p2p', 'P2P');
  else openDeckSub('view-inexdrop', 'Inex Drop');
}

export function initControls(): void {
  initVolume();
  initBrightness();
  renderQuickActionTiles();

  window.closeDeckSub = closeDeckSub;
  window.openDeckSub = openDeckSub;

  bus.on<{ kind: 'wifi' | 'bt'; on: boolean }>('radio:toggle', ({ kind, on }) => toggleRadio(kind, on));
  bus.on<{ viewId: string; title?: string; from?: string }>('deck:open-sub', ({ viewId, title, from }) => openDeckSub(viewId, title, from));
  bus.on<string>('deck:open-drop', (mode) => openDeckDropPanel(mode));
  bus.on<number>('rail:navigate', (idx) => {
    if (appState.currentView === 'view-control-deck') openDeckDropPanel(idx === 0 ? 'qs' : 'p2p');
    else if (idx === 0) openQsView();
    else openP2PView();
  });

  document.getElementById('tile-p2p')?.addEventListener('click', () => {
    openP2PView();
  });
  document.getElementById('tile-tray')?.addEventListener('click', openTrayView);

  document.querySelectorAll('.back-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof window.openControlMenu === 'function') window.openControlMenu();
    });
  });

  document.getElementById('wifi-master-toggle')?.addEventListener('change', (e) => {
    void toggleRadio('wifi', (e.target as HTMLInputElement).checked);
  });
  document.getElementById('bt-master-toggle')?.addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    await toggleRadio('bt', checked);
    if (appState.currentView === 'view-bt') setTimeout(loadBtList, checked ? 1500 : 0);
  });

  document.getElementById('m-vol-toggle')?.addEventListener('click', () => {
    appState.volOpen = !appState.volOpen;
    const island = document.getElementById('island');
    if (island) island.classList.toggle('vol-open', appState.volOpen);
    document.getElementById('m-vol-toggle')?.classList.toggle('muted-ico', !appState.volOpen);
    reportIslandSize({ width: ISLAND_WIN_W, height: appState.volOpen ? MEDIA_H_VOL : MEDIA_H });
  });
  document.getElementById('m-bt-btn')?.addEventListener('click', () => openAudioView());

  document.getElementById('deck-sub-back')?.addEventListener('click', () => {
    const sp = document.getElementById('deck-right-sub');
    if (sp && sp.classList.contains('from-bottom') && !sp.classList.contains('sinking')) {
      const host = sp.parentElement;
      if (host) {
        host.classList.add('mx-clip');
        sp.classList.add('sinking');
        setTimeout(() => {
          sp.classList.remove('sinking');
          host.classList.remove('mx-clip');
          closeDeckSub();
        }, 210);
      } else {
        closeDeckSub();
      }
    } else {
      closeDeckSub();
    }
  });

  document.getElementById('deck-tile-wifi')?.addEventListener('click', (e) => {
    if (appState.wifiPresent === false) return;
    if ((e.target as Element | null)?.closest('.mx-tile-chev')) openDeckSub('view-wifi', 'Wi-Fi');
    else void toggleRadio('wifi', !appState.wifiRadio);
  });
  document.getElementById('deck-tile-wifi')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openDeckSub('view-wifi', 'Wi-Fi');
  });

  document.getElementById('deck-tile-bt')?.addEventListener('click', (e) => {
    if (appState.btPresent === false) return;
    if ((e.target as Element | null)?.closest('.mx-tile-chev')) openDeckSub('view-bt', 'Bluetooth');
    else void toggleRadio('bt', !appState.btRadio);
  });
  document.getElementById('deck-tile-bt')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openDeckSub('view-bt', 'Bluetooth');
  });

  document.getElementById('deck-tile-drop')?.addEventListener('click', (e) => {
    if ((e.target as Element | null)?.closest('.mx-tile-chev')) {
      openDeckDrop();
    } else if (currentOffer || inTransfer) {
      openDeckDrop(getDropMode() || 'qs');
    } else if (getDropMode() === 'p2p') {
      openDeckDrop('p2p');
    } else {
      void toggleInexDrop();
    }
  });
  document.getElementById('deck-tile-drop')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openDeckDrop();
  });

  document.getElementById('deck-tray-btn')?.addEventListener('click', () => {
    if (deckTrayPaneOpen()) closeDeckTrayPane();
    else openDeckTrayView(false);
  });

  document.getElementById('deck-awake-btn')?.addEventListener('click', () => {
    void toggleKeepAwake();
  });
  document.getElementById('deck-lock-btn')?.addEventListener('click', () => {
    invokeTauri('lock_screen');
  });
  document.getElementById('deck-settings-btn')?.addEventListener('click', () => {
    invokeTauri('open_settings');
  });

  document.querySelectorAll('#deck-quick-row .mx-q').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = (btn as HTMLElement).dataset.action;
      if (act === 'notepad') openDeckSub('view-notepad', 'Quick Notes', 'bottom');
      else if (act === 'clipboard') openDeckSub('view-clipboard', 'Clipboard', 'bottom');
      else if (act === 'timer') openDeckSub('view-timer', 'Focus Timer', 'bottom');
      else if (act === 'snip') {
        goCompact();
        invokeTauri('take_snip');
      } else if (act === 'calendar') openDeckSub('view-calendar', 'Calendar', 'bottom');
    });
  });

  document.getElementById('audio-back-btn')?.addEventListener('click', () => {
    if (lastAudioOrigin === 'view-media' && appState.mediaPlaying) {
      if (typeof window.openMedia === 'function') window.openMedia();
    } else {
      if (typeof window.openControlMenu === 'function') window.openControlMenu();
    }
  });

  document.getElementById('btn-refresh-audio')?.addEventListener('click', () => loadAudioDeviceList(true));
  document.getElementById('btn-more-audio')?.addEventListener('click', () => invokeTauri('open_sound_settings'));
}
