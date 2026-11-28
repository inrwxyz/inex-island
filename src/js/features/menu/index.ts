// Control Center Menu, View Navigation, Tile Slots & Mic Controls
import { appState } from '../../core/state.js';
import { loadSettings } from '../../core/settings.js';
import { bus } from '../../core/bus.js';
import { invokeTauri } from '../../core/tauri.js';
import {
  reportIslandSize,
  triggerCloseEase,
  cancelCloseEase,
  updateCompactStateClasses,
  isMenuView,
  ISLAND_WIN_W
} from '../../core/views.js';
import { deckWidgetsReset, wgStop } from '../widgets/index.js';
import { deckPrayerReset } from '../prayer/index.js';
import {
  closeDeckSub,
  suspendInactiveFeatures,
  syncMicQuickUi,
  isDeckLayout,
  renderQuickActionTiles
} from '../controls/index.js';
import { closeDeckTrayPane, updateTrayUI, openTrayView, escHtml } from '../tray/index.js';
import { closeClipboardView } from '../clipboard/index.js';
import { syncDropRail, updateDropTile, dropTileClick } from '../file-transfer/index.js';
import { syncMediaTick, renderMediaProgress } from '../media/index.js';
import { eqKick } from '../equalizer/index.js';
import { syncDeckWeatherUI, getActiveWeatherIcon, weather, wxdCloseDeck } from '../weather/index.js';
import { refreshBtCaption, compactIslandSize } from '../bluetooth/index.js';
import { setVolumeUI, syncMediaAppVolume } from '../volume/index.js';
import { updateClocks, initClock } from '../clock/index.js';
import type { IslandSize } from '../../../types/models.js';

export { triggerCloseEase, cancelCloseEase, updateCompactStateClasses } from '../../core/views.js';

const MEDIA_H = 166;
const MEDIA_H_VOL = 218;

interface SlotDef {
  el: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
  click?: () => void;
}

type ZoomStyle = CSSStyleDeclaration & { zoom?: number | string };

export const slotRunning = new Set<string>();
export const SLOT_DEFS: Record<string, SlotDef> = {
  wifi: {
    el: 'tile-wifi',
    start: async () => {
      await invokeTauri('wifi_backend', { on: true });
      if (typeof window.refreshRadios === 'function') window.refreshRadios();
      if (typeof window.refreshWifiNow === 'function') window.refreshWifiNow();
    },
    stop: async () => {
      await invokeTauri('wifi_backend', { on: false });
      const cap = document.getElementById('wifi-cap');
      if (cap) cap.textContent = '';
    }
  },
  bt: {
    el: 'tile-bt',
    start: async () => {
      await invokeTauri('bt_backend', { on: true });
      if (typeof window.refreshRadios === 'function') window.refreshRadios();
      refreshBtCaption();
    },
    stop: async () => {
      await invokeTauri('bt_backend', { on: false });
      const cap = document.getElementById('bt-cap');
      if (cap) cap.textContent = '';
    }
  },
  drop: {
    el: 'tile-drop',
    start: () => {},
    stop: () => {},
    click: () => {
      dropTileClick();
    }
  },
  tray: {
    el: 'tile-tray',
    start: () => {
      updateTrayUI();
    },
    stop: () => {},
    click: () => {
      openTrayView();
    }
  }
};

export const FIXED_TILE_ORDER = ['wifi', 'bt', 'drop', 'tray'] as const;

export function applySlots(): void {
  FIXED_TILE_ORDER.forEach((id, i) => {
    const def = SLOT_DEFS[id];
    const tile = document.getElementById(def.el);
    if (!tile) return;
    tile.classList.remove('hidden');
    tile.style.order = String(i + 1);
    if (!slotRunning.has(id)) {
      slotRunning.add(id);
      def.start();
    }
  });
}

export let micMutedState: boolean | null | undefined = null;

export function renderMic(m: boolean | null | undefined): void {
  micMutedState = m;
  const none = m === null || m === undefined;
  const mt = document.getElementById('deck-tile-mic');
  if (mt) {
    mt.classList.toggle('muted', m === true);
    mt.classList.toggle('active', m === false);
    const ms = document.getElementById('deck-mic-sub');
    if (ms) ms.textContent = none ? 'No mic' : m ? 'Muted' : 'On';
  }
  syncMicQuickUi(m ?? null);
}

export async function refreshMic(): Promise<void> {
  const m = await invokeTauri<boolean | null>('get_mic_muted');
  renderMic(m);
}

export async function toggleMic(): Promise<void> {
  await invokeTauri('set_mic_muted', { muted: micMutedState !== true });
  refreshMic();
}

export function switchView(viewId: string, stateClass: string, winWidth: number, winHeight: number): void {
  const island = document.getElementById('island');
  if (!island) return;
  const SET = loadSettings();
  appState.keepOpen = false;
  deckWidgetsReset();
  deckPrayerReset();
  closeDeckSub();
  closeDeckTrayPane();

  if (appState.currentView === 'view-bt' && viewId !== 'view-bt') {
    appState.btBusy = false;
    invokeTauri('bt_discovery', { on: false });
  }
  if (appState.currentView === 'view-clipboard' && viewId !== 'view-clipboard') {
    closeClipboardView();
  }

  document.querySelectorAll('.view').forEach((v) => {
    v.classList.remove('active');
  });

  const target = document.getElementById(viewId);
  if (target) target.classList.add('active');

  const wasCompact = island.classList.contains('state-compact');
  if (stateClass === 'state-compact' && !wasCompact) {
    triggerCloseEase(700);
  } else {
    cancelCloseEase();
  }

  island.style.left = '0px';

  island.classList.remove(
    'state-compact', 'state-drop', 'state-control', 'state-control-deck',
    'state-tray', 'state-tray-deck', 'state-sub', 'state-media', 'state-calendar'
  );
  island.classList.add(stateClass);
  island.classList.toggle('audio-view', viewId === 'view-audio');
  appState.currentView = viewId;

  const scale = (SET.appearance && SET.appearance.scale) ? SET.appearance.scale : 125;
  const notchZoom = scale / 100;
  (island.style as ZoomStyle).zoom = String(isMenuView(viewId) ? 1.10 : notchZoom);
  syncDropRail(viewId);
  updateCompactStateClasses();
  if (typeof window.syncLoadTimer === 'function') window.syncLoadTimer();
  syncMediaTick();
  eqKick();
  bus.emit('view:change', viewId);

  if (viewId === 'view-compact') {
    wxdCloseDeck();
    if (!appState.transferring && !appState.incomingOpen) {
      invokeTauri('wifi_backend', { on: false }).catch(() => {});
    }
  }

  const isFloating = SET.notch && SET.notch.style === 'floating';
  let effH = winHeight;
  if (isFloating) {
    if (viewId === 'view-compact') {
      effH = 48;
    } else {
      effH = winHeight + 12;
    }
  }

  let win: IslandSize = { width: winWidth, height: effH };
  if (viewId === 'view-compact') win = compactIslandSize(win);

  reportIslandSize(win);
  suspendInactiveFeatures();
}

export function applyDeckMenuConfig(): void {
  const SET = loadSettings();
  const cfg = (SET.deckMenu && typeof SET.deckMenu === 'object') ? SET.deckMenu : ({} as Partial<typeof SET.deckMenu>);
  const statsMode = cfg.statsMode || 'sys';
  const showStatsCard = statsMode !== 'none';
  const map: Record<string, boolean> = {
    clock: true,
    weather: !SET.weather || SET.weather.enabled !== false,
    stats: showStatsCard,
  };
  Object.keys(map).forEach((k) => {
    const el = document.querySelector(`#view-control-deck [data-deck="${k}"]`);
    if (el) el.classList.toggle('hidden', !map[k]);
  });
  const batEl = document.getElementById('deck-stat-bat');
  if (batEl && appState.stats) {
    batEl.classList.toggle('hidden', !((appState.stats.battery_pct ?? -1) >= 0));
  }
  const topBat = document.getElementById('deck-battery');
  if (topBat && appState.stats) {
    topBat.classList.toggle('hidden', !((appState.stats.battery_pct ?? -1) >= 0));
  }
  const mxLeft = document.querySelector('#view-control-deck .mx-left');
  if (mxLeft) {
    const hasVisibleChild = [...mxLeft.children].some((c) => !c.classList.contains('hidden'));
    mxLeft.classList.toggle('hidden', !hasVisibleChild);
  }
  const switcher = document.querySelector('.mx-view-switcher');
  if (switcher) {
    const enabled = cfg.widgetsEnabled !== false;
    switcher.classList.toggle('hidden', !enabled);
    if (!enabled) deckWidgetsReset();
  }
}

export function openControlMenu(): void {
  suspendInactiveFeatures();
  const wantDeck = isDeckLayout();
  if (wantDeck) {
    applyDeckMenuConfig();
    invokeTauri('wifi_backend', { on: true }).catch((err) => console.warn('wifi_backend err:', err));
    invokeTauri('bt_backend', { on: true }).catch((err) => console.warn('bt_backend err:', err));
    switchView('view-control-deck', 'state-control-deck', ISLAND_WIN_W, 218);
    if (typeof window.refreshRadios === 'function') window.refreshRadios().catch((err) => console.warn('refreshRadios err:', err));
    if (typeof window.refreshLoad === 'function') window.refreshLoad().catch((err) => console.warn('refreshLoad err:', err));
    if (typeof window.syncDeckStatsUI === 'function') window.syncDeckStatsUI();
    syncDeckWeatherUI();
    updateTrayUI();
    updateDropTile();
    renderMediaProgress();
  } else {
    invokeTauri('wifi_backend', { on: true }).catch((err) => console.warn('wifi_backend err:', err));
    invokeTauri('bt_backend', { on: true }).catch((err) => console.warn('bt_backend err:', err));
    renderQuickActionTiles();
    switchView('view-control', 'state-control', 316, 292);
  }
  refreshBtCaption();
  if (typeof window.refreshWifiNow === 'function') void window.refreshWifiNow();
  refreshMic();
}

export function openMedia(): void {
  const island = document.getElementById('island');
  switchView('view-media', 'state-media', 316, appState.volOpen ? MEDIA_H_VOL : MEDIA_H);
  if (island) island.classList.toggle('vol-open', appState.volOpen);
  renderMediaProgress();
  syncMediaAppVolume();
  invokeTauri<number | null>('get_system_volume').then((v) => {
    if (typeof v === 'number') setVolumeUI(v);
  });
}

export function goCompact(): void {
  const island = document.getElementById('island');
  if (island) island.classList.remove('vol-open');
  appState.volOpen = false;
  const picker = document.getElementById('tray-peer-picker');
  if (picker) picker.classList.add('hidden');
  wgStop();
  deckWidgetsReset();
  wxdCloseDeck();
  suspendInactiveFeatures();
  if (!appState.transferring && !appState.incomingOpen) {
    invokeTauri('wifi_backend', { on: false }).catch(() => {});
  }
  switchView('view-compact', 'state-compact', ISLAND_WIN_W, 36);
}

let _cycleIdx = 0;
let _cycleTimer: ReturnType<typeof setInterval> | null = null;

export const COMPACT_STAT_ICONS = {
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 12 6 12 9 5 14 19 17 12 22 12"/></svg>',
  ram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="3"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="16" y1="11" x2="16" y2="13"/></svg>',
  battery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="2" y="7" width="16" height="10" rx="2.5"/><rect x="4.5" y="9.5" width="9.5" height="5" rx="1" fill="currentColor" stroke="none"/><path d="M20.5 10.5v3" stroke-linecap="round" stroke-width="2.2"/></svg>',
  charging: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  weather: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg>'
};

export function renderCompactChip(iconSvg: string, text: string, cls?: string): string {
  const c = cls ? ` ${cls}` : '';
  return `<span class="c-stat-chip${c}">${iconSvg}<span>${escHtml(text)}</span></span>`;
}

export interface CompactCenterResult {
  html: boolean;
  val: string;
}

export function formatCompactCenterHtml(timeStr: string): CompactCenterResult {
  const SET = loadSettings();
  const mode = (SET.notch && SET.notch.compactContent) || 'clock';
  if (mode === 'clock' || mode === 'pet') return { html: false, val: timeStr };
  const stats = appState.stats;
  const pick = (k: string): CompactCenterResult | null => {
    if (k === 'weather') {
      if (!(SET.weather && SET.weather.enabled !== false && typeof weather !== 'undefined')) return null;
      const ico = getActiveWeatherIcon() || COMPACT_STAT_ICONS.weather;
      const wCls = (weather.isDay === false) ? 'is-night' : 'is-weather';
      return { html: true, val: renderCompactChip(ico, weather.text || '--', wCls) };
    }
    if (k === 'cpu') {
      if (!stats) return null;
      const cpu = stats.cpu_pct ?? 0;
      const cls = cpu >= 85 ? 'is-cpu is-crit' : cpu >= 65 ? 'is-cpu is-warn' : 'is-cpu';
      return { html: true, val: renderCompactChip(COMPACT_STAT_ICONS.cpu, `${cpu}%`, cls) };
    }
    if (k === 'ram') {
      if (!stats) return null;
      const ram = stats.ram_pct ?? 0;
      const cls = ram >= 85 ? 'is-ram is-crit' : ram >= 70 ? 'is-ram is-warn' : 'is-ram';
      return { html: true, val: renderCompactChip(COMPACT_STAT_ICONS.ram, `${ram}%`, cls) };
    }
    if (k === 'battery') {
      if (!(stats && (stats.battery_pct ?? -1) >= 0)) return null;
      const bat = stats.battery_pct ?? 0;
      const charging = Boolean(stats.charging);
      const cls = !charging ? (bat <= 15 ? 'is-bat is-crit' : bat <= 30 ? 'is-bat is-warn' : 'is-bat') : 'is-bat';
      const ico = charging ? COMPACT_STAT_ICONS.charging : COMPACT_STAT_ICONS.battery;
      return { html: true, val: renderCompactChip(ico, `${bat}%`, cls) };
    }
    return { html: false, val: timeStr };
  };
  if (mode === 'cycle') {
    const order = ['clock', 'weather', 'cpu', 'ram', 'battery'].filter((k) => !!pick(k));
    if (!order.length) return { html: false, val: timeStr };
    return pick(order[_cycleIdx % order.length]) || { html: false, val: timeStr };
  }
  return pick(mode) || { html: false, val: timeStr };
}

export function syncCompactCycleTimer(): void {
  const SET = loadSettings();
  const want = Boolean(SET.notch && SET.notch.compactContent === 'cycle' && !document.hidden);
  if (want && !_cycleTimer) {
    _cycleTimer = setInterval(() => {
      _cycleIdx = (_cycleIdx + 1) % 60;
      updateClocks();
    }, 5000);
  } else if (!want && _cycleTimer) {
    clearInterval(_cycleTimer);
    _cycleTimer = null;
  }
}

interface ViewSwitchOpts {
  viewId?: string;
  view?: string;
  stateClass?: string;
  state?: string;
  width?: number;
  w?: number;
  height?: number;
  h?: number;
}

export function initMenu(): void {
  window.switchView = switchView;
  window.openControlMenu = openControlMenu;
  window.openMedia = openMedia;
  window.goCompact = goCompact;
  window.toggleMic = toggleMic;
  window.renderMic = renderMic;
  window.refreshMic = refreshMic;
  window.applyDeckMenuConfig = applyDeckMenuConfig;
  window.applySlots = applySlots;
  window.syncCompactCycleTimer = syncCompactCycleTimer;
  window.formatCompactCenterHtml = formatCompactCenterHtml as unknown as (...args: unknown[]) => string;
  window.triggerCloseEase = triggerCloseEase;
  window.cancelCloseEase = cancelCloseEase;
  window.updateCompactStateClasses = updateCompactStateClasses;

  initClock();

  bus.on<ViewSwitchOpts>('view:switch', (opts) => {
    const v = opts?.viewId || opts?.view || 'view-compact';
    const s = opts?.stateClass || opts?.state || 'state-compact';
    const w = opts?.width || opts?.w || ISLAND_WIN_W;
    const h = opts?.height || opts?.h || 36;
    switchView(v, s, w, h);
  });
  bus.on('menu:open-control', () => openControlMenu());
  bus.on('media:open', () => openMedia());
  bus.on('view:go-compact', () => goCompact());

  document.getElementById('deck-tile-mic')?.addEventListener('click', () => toggleMic());

  refreshMic();
}
