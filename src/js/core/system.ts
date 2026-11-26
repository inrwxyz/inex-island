// Hardware Polling, System Stats & Tauri Events Core Module
import { appState } from './state.js';
import { bus } from './bus.js';
import { invokeTauri } from './tauri.js';
import { loadSettings } from './settings.js';
import { island } from './dom.js';
import {
  isDeckLayout,
  applyPresence,
  applyRadio,
  loadAudioDeviceList,
  refreshActiveAudioName
} from '../features/controls/index.js';
import { setVolumeUI } from '../features/volume/index.js';
import {
  slotRunning,
  openControlMenu,
  openMedia,
  goCompact,
  renderMic
} from '../features/menu/index.js';
import { btBatteryFor, BUDS_SVG, DEV_ICONS } from '../features/bluetooth/index.js';
import { updateClocks } from '../features/clock/index.js';
import { renderWidgets } from '../features/weather/index.js';
import { batteryOverlays } from '../features/battery/index.js';
import { refreshMedia, loadMediaArt } from '../features/media/index.js';
import { endWifiScan, loadWifiList } from '../features/wifi/index.js';
import { openTrayView } from '../features/tray/index.js';
import {
  openDeckDrop,
  openQsView,
  openP2PView,
  currentOffer
} from '../features/file-transfer/index.js';
import { snoozeClockAlarm } from '../features/alarm/index.js';
import { dismissTimerAlarm } from '../features/timer/index.js';
import type { SystemStats } from '../../types/models.js';

interface BtDeviceInfo {
  name: string;
  connected?: boolean;
  kind?: string;
}

export async function refreshRadios(): Promise<void> {
  const deckOn = isDeckLayout();
  const askWifi = slotRunning.has('wifi') || deckOn;
  const askBt = slotRunning.has('bt') || deckOn;

  const [wifiHere, btHere] = await Promise.all([
    askWifi ? invokeTauri<boolean>('get_radio_present', { kind: 'wifi' }) : null,
    askBt ? invokeTauri<boolean>('get_radio_present', { kind: 'bt' }) : null
  ]);
  if (typeof wifiHere === 'boolean') applyPresence('wifi', wifiHere);
  if (typeof btHere === 'boolean') applyPresence('bt', btHere);

  const [wifiOn, btOn] = await Promise.all([
    askWifi && appState.wifiPresent ? invokeTauri<boolean>('get_radio_state', { kind: 'wifi' }) : null,
    askBt && appState.btPresent ? invokeTauri<boolean>('get_radio_state', { kind: 'bt' }) : null
  ]);
  if (typeof wifiOn === 'boolean') applyRadio('wifi', wifiOn);
  if (typeof btOn === 'boolean') applyRadio('bt', btOn);
}

export const DECK_GAUGE_ARC = 80.1;

export function setDeckStatMeter(
  wrapId: string,
  valId: string,
  barId: string,
  pct: number | undefined,
  critAt: number,
  warnAt: number,
  lowIsBad: boolean,
  subId?: string,
  subText?: string
): void {
  const wrap = document.getElementById(wrapId);
  const val = document.getElementById(valId);
  const bar = document.getElementById(barId);
  if (!wrap || !val) return;
  const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  val.textContent = `${n}%`;
  if (bar) bar.style.strokeDasharray = `${(n / 100 * DECK_GAUGE_ARC).toFixed(1)} 106.8`;
  if (subId) {
    const sub = document.getElementById(subId);
    if (sub && sub.textContent !== (subText || '')) sub.textContent = subText || '';
  }

  const isCrit = lowIsBad ? n <= critAt : n >= critAt;
  const isWarn = !isCrit && (lowIsBad ? n <= warnAt : n >= warnAt);
  wrap.classList.toggle('crit', isCrit);
  wrap.classList.toggle('warn', isWarn);
}

export async function syncDeckStatsUI(): Promise<void> {
  const s = appState.stats as (SystemStats & {
    charging?: boolean;
    cpu_temp?: number;
    wifi_name?: string;
    wifi_signal?: number;
    is_fullscreen?: boolean;
  }) | undefined;
  if (!s) return;
  const SET = loadSettings();

  const batTop = document.getElementById('deck-battery');
  if (batTop) {
    const batPct = s.battery_pct ?? -1;
    const hasBat = batPct >= 0;
    const showBat = hasBat && (SET.deckMenu?.showBattery !== false);
    batTop.classList.toggle('hidden', !showBat);
    if (showBat) {
      const pctEl = document.getElementById('deck-bat-pct');
      if (pctEl) pctEl.textContent = `${batPct}%`;
      const lvl = (Math.max(0.08, Math.min(1, batPct / 100)) * 13.4).toFixed(1);
      const lvlEl = document.getElementById('deck-bat-level');
      if (lvlEl) lvlEl.setAttribute('width', String(lvl));
      const bolt = document.getElementById('deck-bat-bolt');
      if (bolt) bolt.classList.toggle('hidden', !s.charging);
      batTop.classList.toggle('charging', !!s.charging);
      batTop.classList.toggle('low', batPct <= 20 && !s.charging);
    }
  }

  const mode = (SET.deckMenu?.statsMode || 'sys') as string;
  const deckStatsCard = document.getElementById('deck-stats');
  if (mode === 'none') {
    if (deckStatsCard) deckStatsCard.classList.add('hidden');
    return;
  }
  const cpuStat = document.getElementById('deck-stat-cpu');
  const ramStat = document.getElementById('deck-stat-ram');
  const extraStat = document.getElementById('deck-stat-extra');
  const btCard = document.getElementById('deck-stat-bt');

  if (mode === 'bt') {
    let btDev: BtDeviceInfo | null = null;
    let btDevPct = -1;
    try {
      const devices = await invokeTauri<BtDeviceInfo[]>('get_bt_devices');
      if (Array.isArray(devices)) {
        btDev = devices.find((d) => d.connected) || null;
      }
      if (btDev) {
        const bl = await invokeTauri<unknown[]>('get_bt_batteries');
        if (Array.isArray(bl) && bl.length) appState.btBatt = bl;
        const p = btBatteryFor(btDev.name);
        if (p !== null && p !== undefined) btDevPct = p;
        if (btDevPct >= 0) {
          appState._deckBtTries = 0;
        }
      }
    } catch (err) {
      console.warn('[system] bt stats error:', err);
    }

    if (btDev) {
      if (deckStatsCard) deckStatsCard.classList.remove('hidden');
      if (cpuStat) cpuStat.classList.add('hidden');
      if (ramStat) ramStat.classList.add('hidden');
      if (extraStat) extraStat.classList.add('hidden');
      if (btCard) {
        btCard.classList.remove('hidden');
        const nameEl = document.getElementById('deck-bt-dev-name');
        if (nameEl) nameEl.textContent = btDev.name;
        const tagEl = document.getElementById('deck-bt-dev-tag');
        if (tagEl) tagEl.textContent = 'Connected';
        const icoEl = document.getElementById('deck-bt-dev-ico');
        if (icoEl) {
          const kind = btDev.kind || 'bt';
          const isBuds = (kind === 'headphones' || !kind || kind === 'bt') && /airpod|buds|earbud|earphone|airdope|tws|pods|wf-/i.test(btDev.name || '');
          const icons = DEV_ICONS as Record<string, string> | undefined;
          icoEl.innerHTML = isBuds && typeof BUDS_SVG !== 'undefined'
            ? BUDS_SVG.replace(/budg/g, 'budg-card')
            : (icons && icons[kind]
              ? icons[kind]
              : (icons?.bt ? icons.bt : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>'));
          icoEl.className = 'mx-bt-ico';
        }
        const pctEl = document.getElementById('deck-bt-dev-pct');
        const ringEl = document.getElementById('deck-bt-dev-ring');
        if (pctEl) pctEl.textContent = btDevPct >= 0 ? `${btDevPct}%` : 'Connected';
        if (ringEl) {
          if (btDevPct >= 0) {
            const circ = 66;
            const offset = circ * (1 - Math.max(0, Math.min(100, btDevPct)) / 100);
            ringEl.style.strokeDashoffset = String(offset);
            ringEl.style.stroke = btDevPct <= 15 ? '#ff453a' : btDevPct <= 30 ? '#ff9f0a' : '#30d158';
            if (ringEl.parentElement) ringEl.parentElement.classList.remove('hidden');
          } else {
            if (ringEl.parentElement) ringEl.parentElement.classList.add('hidden');
          }
        }
      }
      return;
    }

    if (deckStatsCard) deckStatsCard.classList.add('hidden');
    return;
  }

  if (deckStatsCard) deckStatsCard.classList.remove('hidden');
  if (btCard) btCard.classList.add('hidden');

  if (mode === 'battery' && (s.battery_pct ?? -1) >= 0) {
    if (cpuStat) cpuStat.classList.add('hidden');
    if (ramStat) ramStat.classList.add('hidden');
    if (extraStat) {
      extraStat.classList.remove('hidden');
      const lbl = document.getElementById('deck-extra-lbl');
      if (lbl) lbl.textContent = s.charging ? 'CHG' : 'BAT';
      setDeckStatMeter('deck-stat-extra', 'deck-extra-val', 'deck-extra-bar', s.battery_pct, 15, 30, true, 'deck-extra-sub', s.charging ? 'Charging' : 'On battery');
    }
    return;
  }

  if (mode === 'disk') {
    if (cpuStat) cpuStat.classList.add('hidden');
    if (ramStat) ramStat.classList.add('hidden');
    if (extraStat) {
      extraStat.classList.remove('hidden');
      const lbl = document.getElementById('deck-extra-lbl');
      if (lbl) lbl.textContent = 'DISK';
      setDeckStatMeter('deck-stat-extra', 'deck-extra-val', 'deck-extra-bar', s.disk_pct, 90, 75, false, 'deck-extra-sub', 'C: used');
    }
    return;
  }

  if (cpuStat) cpuStat.classList.remove('hidden');
  if (ramStat) ramStat.classList.remove('hidden');
  if (extraStat) extraStat.classList.add('hidden');
  const cpuTemp = s.cpu_temp ?? 0;
  const ramUsed = s.ram_used_gb ?? 0;
  setDeckStatMeter('deck-stat-cpu', 'deck-cpu-val', 'deck-cpu-bar', s.cpu_pct, 85, 65, false, 'deck-cpu-sub', cpuTemp > 0 ? `${Math.round(cpuTemp)}\u00B0C` : '');
  setDeckStatMeter('deck-stat-ram', 'deck-ram-val', 'deck-ram-bar', s.ram_pct, 85, 70, false, 'deck-ram-sub', ramUsed > 0 ? `${ramUsed.toFixed(1)} GB` : '');
}

export function syncSmartHidden(nextFs?: boolean): void {
  if (typeof nextFs === 'boolean') appState.isFs = nextFs;
  const SET = loadSettings();
  const busyPopup = !!(
    currentOffer ||
    appState.transferring ||
    appState.prompting ||
    appState.lockerPrompting ||
    island?.classList.contains('anim-radar-card-open') ||
    island?.classList.contains('bt-hud-active') ||
    island?.classList.contains('biometric-active')
  );
  const shouldHide = !!(
    SET.notch?.mode === 'smart' &&
    appState.isFs &&
    appState.currentView === 'view-compact' &&
    !busyPopup
  );
  const wasHidden = !!island?.classList.contains('smart-hidden');
  island?.classList.toggle('smart-hidden', shouldHide);
  if (wasHidden !== shouldHide) {
    bus.emit('smart:visibility-change', shouldHide);
  }
}

export async function refreshStats(): Promise<void> {
  const stats = await invokeTauri<SystemStats & { wifi_name?: string; is_fullscreen?: boolean }>('get_sys_stats');
  if (stats) {
    appState.stats = stats;
    updateClocks();
    renderWidgets();
    batteryOverlays(stats);
    const deckWifiSub = document.getElementById('deck-wifi-sub');
    if (deckWifiSub && appState.wifiRadio) {
      deckWifiSub.textContent = (stats.wifi_name && stats.wifi_name !== 'Not connected') ? stats.wifi_name : 'On';
    }
    if (slotRunning.has('wifi')) {
      const cap = document.getElementById('wifi-cap');
      if (cap) {
        cap.textContent = appState.wifiRadio && stats.wifi_name && stats.wifi_name !== 'Not connected' ? stats.wifi_name : '';
      }
      const sub = document.getElementById('wifi-sub');
      if (sub && appState.wifiRadio && stats.wifi_name) sub.textContent = stats.wifi_name;
    }

    syncSmartHidden(!!stats.is_fullscreen);
  }
}

export async function pollSystemAndMedia(): Promise<void> {
  await refreshMedia();
  await refreshRadios();
  await refreshStats();
}

let loadTimer: ReturnType<typeof setInterval> | null = null;
let loadBusy = false;

export function loadWanted(): boolean {
  if (document.hidden) return false;
  const SET = loadSettings();
  if (appState.currentView === 'view-control-deck') return SET.deckMenu?.showStats !== false;
  if (appState.currentView !== 'view-compact') return false;
  const compactNeedsLoad = ['cpu', 'ram', 'cycle'].includes(SET.notch?.compactContent);
  if (compactNeedsLoad) return true;
  if (SET.widgets && SET.widgets.enabled === false) return false;
  const wL = SET.widgets ? SET.widgets.left : null;
  const wR = SET.widgets ? SET.widgets.right : null;
  return ['ram', 'cpu', 'gpu', 'disk', 'net'].some((k) => wL === k || wR === k);
}

export async function refreshLoad(): Promise<void> {
  const load = await invokeTauri<Partial<SystemStats>>('get_sys_load');
  if (!load) return;
  const SET = loadSettings();
  appState.stats = Object.assign(appState.stats || {}, load);
  if (SET.widgets?.left === 'net' || SET.widgets?.right === 'net') {
    try {
      const n = await invokeTauri<unknown[]>('get_net_speed');
      if (Array.isArray(n)) appState.net = n;
    } catch (err) {
      console.warn('[system] net speed error:', err);
    }
  }
  updateClocks();
  renderWidgets();
  syncDeckStatsUI();
}

export async function loadTick(): Promise<void> {
  if (loadBusy) return;
  loadBusy = true;
  try {
    await refreshLoad();
  } finally {
    loadBusy = false;
  }
}

export function syncLoadTimer(): void {
  const want = loadWanted();
  if (want && !loadTimer) {
    loadTick();
    loadTimer = setInterval(loadTick, 3500);
  } else if (!want && loadTimer) {
    clearInterval(loadTimer);
    loadTimer = null;
  }
}

export async function refreshWifiNow(): Promise<void> {
  const st = await invokeTauri<{ name?: string; signal?: number }>('get_wifi_status');
  if (!st) return;
  if (appState.stats) {
    appState.stats.wifi_name = st.name;
    appState.stats.wifi_signal = st.signal;
  }
  const cap = document.getElementById('wifi-cap');
  if (cap) {
    cap.textContent = appState.wifiRadio && st.name && st.name !== 'Not connected' ? st.name : '';
  }
  const sub = document.getElementById('wifi-sub');
  if (sub && appState.wifiRadio && st.name) sub.textContent = st.name;
  if (appState.currentView === 'view-wifi') loadWifiList(true);
}

export function onTauriEvent<T = unknown>(name: string, fn: (ev: TauriEvent<T>) => void): void {
  const tryListen = (): void => {
    if (window.__TAURI__?.event && typeof window.__TAURI__.event.listen === 'function') {
      const r = window.__TAURI__.event.listen<T>(name, fn);
      if (r && typeof r.catch === 'function') r.catch((e: unknown) => console.warn('event listen failed:', name, e));
    } else {
      setTimeout(tryListen, 80);
    }
  };
  tryListen();
}

let mediaEvT: ReturnType<typeof setTimeout> | undefined;
let mediaTlT: ReturnType<typeof setTimeout> | undefined;
let radioEvT: ReturnType<typeof setTimeout> | undefined;
let wifiEvT: ReturnType<typeof setTimeout> | undefined;
let volDrag = false;
let _leaveT: ReturnType<typeof setTimeout> | undefined;
let _pointerOutside = false;

export function initSystemPolling(): void {
  window.refreshRadios = refreshRadios;
  window.setDeckStatMeter = setDeckStatMeter as Window['setDeckStatMeter'];
  window.syncDeckStatsUI = syncDeckStatsUI;
  window.refreshStats = refreshStats;
  window.pollSystemAndMedia = pollSystemAndMedia;
  window.loadWanted = loadWanted;
  window.refreshLoad = refreshLoad;
  window.loadTick = loadTick;
  window.syncLoadTimer = syncLoadTimer;
  window.refreshWifiNow = refreshWifiNow;

  document.addEventListener('visibilitychange', syncLoadTimer);

  onTauriEvent('media-changed', () => {
    clearTimeout(mediaEvT);
    mediaEvT = setTimeout(async () => {
      await refreshMedia();
      if (appState.mediaPlaying && !appState.loadedArtUrl) {
        loadMediaArt();
      }
    }, 100);
  });

  onTauriEvent('media-timeline-changed', () => {
    clearTimeout(mediaTlT);
    mediaTlT = setTimeout(refreshMedia, 300);
  });

  ['slider-vol', 'm-vol-slider'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('pointerdown', () => { volDrag = true; });
  });
  window.addEventListener('pointerup', () => { volDrag = false; });

  onTauriEvent<{ level?: number }>('volume-changed', (e) => {
    const l = e?.payload?.level;
    if (!volDrag && typeof l === 'number') setVolumeUI(l);
  });

  onTauriEvent<{ muted?: boolean }>('mic-muted-changed', (e) => renderMic(e?.payload ? e.payload.muted : null));

  onTauriEvent('audio-device-changed', () => {
    if (appState.currentView === 'view-audio') loadAudioDeviceList(false);
    else refreshActiveAudioName();
  });

  onTauriEvent('radio-changed', () => {
    clearTimeout(radioEvT);
    radioEvT = setTimeout(refreshRadios, 200);
  });

  onTauriEvent<{ is_fullscreen?: boolean }>('fullscreen-changed', (e) => {
    syncSmartHidden(!!(e?.payload?.is_fullscreen));
  });

  bus.on('smart:sync', () => syncSmartHidden());
  bus.on('view:change', () => syncSmartHidden());

  onTauriEvent<{ battery_pct?: number; charging?: boolean }>('power-changed', (e) => {
    if (e?.payload) {
      if (!appState.stats) appState.stats = {};
      appState.stats.battery_pct = e.payload.battery_pct;
      appState.stats.charging = e.payload.charging;
      batteryOverlays(appState.stats);
    }
  });

  bus.on('wifi:refresh-request', () => refreshWifiNow());

  onTauriEvent('wifi-changed', () => {
    clearTimeout(wifiEvT);
    wifiEvT = setTimeout(() => {
      endWifiScan();
      refreshWifiNow();
    }, 300);
  });

  onTauriEvent('settings-changed', (e) => {
    try {
      if (e?.payload) {
        const raw = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload);
        localStorage.setItem('inex.settings.v1', raw);
      }
    } catch (err) {
      console.warn('[system] settings-changed err:', err);
    }
    if (typeof window.scheduleApplySettings === 'function') {
      window.scheduleApplySettings();
    }
  });

  const compactBarEl = document.querySelector('.compact-bar');
  if (compactBarEl) {
    compactBarEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('#c-media-btn, #c-eq, #c-tray-btn, #c-peer-badge, #c-incoming-alert, #c-transfer-cancel-btn, #btn-hud-accept, #btn-hud-decline, #c-alarm-box, #btn-alarm-snooze, #btn-alarm-dismiss')) {
        return;
      }
      if (island?.classList.contains('alarm-active')) {
        openControlMenu();
        return;
      }
      if (typeof currentOffer !== 'undefined' && currentOffer) {
        if (isDeckLayout()) {
          openDeckDrop('qs');
        } else {
          openQsView();
        }
        return;
      }
      openControlMenu();
    });
  }

  document.getElementById('c-center-trigger')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('#c-incoming-alert')) return;
    if (island?.classList.contains('alarm-active')) {
      openControlMenu();
      return;
    }
    if (typeof currentOffer !== 'undefined' && currentOffer) {
      if (isDeckLayout()) {
        openDeckDrop('qs');
      } else {
        openQsView();
      }
      return;
    }
    openControlMenu();
  });

  document.getElementById('c-alarm-box')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('#btn-alarm-snooze, #btn-alarm-dismiss')) return;
    e.stopPropagation();
    openControlMenu();
  });

  document.getElementById('btn-alarm-snooze')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const opts = appState.alarmOpts as { onSnooze?: () => void } | null;
    if (opts && typeof opts.onSnooze === 'function') {
      opts.onSnooze();
      return;
    }
    snoozeClockAlarm();
    dismissTimerAlarm();
  });

  document.getElementById('btn-alarm-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissTimerAlarm();
  });

  document.getElementById('c-media-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMedia();
  });

  document.getElementById('c-eq')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMedia();
  });

  document.getElementById('c-tray-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openTrayView();
  });

  document.getElementById('c-peer-badge')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openP2PView();
  });

  if (island) {
    island.addEventListener('mouseenter', () => {
      _pointerOutside = false;
      clearTimeout(_leaveT);
    });
    island.addEventListener('mouseleave', () => {
      if (appState.keepOpen) return;
      clearTimeout(_leaveT);
      _leaveT = setTimeout(() => {
        if (appState.keepOpen || (island?.matches(':hover') && !_pointerOutside)) return;
        if (appState.currentView !== 'view-compact') {
          goCompact();
        }
      }, 220);
    });
  }

  onTauriEvent('island_pointer', (ev) => {
    const inside = !!(ev?.payload);
    _pointerOutside = !inside;
    if (!inside && island) island.dispatchEvent(new window.MouseEvent('mouseleave'));
  });

  pollSystemAndMedia();
  syncLoadTimer();
}
