// Bluetooth & Device HUD Feature: manages paired/nearby devices, PIN prompts, and Dynamic Island HUD popups
import { $, island } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';
import { reportIslandSize, cancelCloseEase, ISLAND_WIN_W } from '../../core/views.js';
import { rowAction } from '../wifi/index.js';
import type { IslandSize } from '../../../types/models.js';

export interface BtDevice {
  name: string;
  kind?: string;
  connected?: boolean;
  id?: string;
}

export interface BtPromptPayload {
  name: string;
  kind?: 'display_pin' | 'confirm_pin' | string;
  pin?: string;
}

export interface DeviceHudOptions {
  iconHTML: string;
  plain?: boolean;
  accent?: string;
  name?: string;
  tag?: string;
  actions?: boolean;
  pct?: number | null;
  battery?: boolean;
  ms?: number;
}

const DEV_SVG = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const DEV_ICONS: Record<string, string> = {
  headphones: DEV_SVG('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'),
  speaker: DEV_SVG('<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" y1="6" x2="12.01" y2="6"/>'),
  mouse: DEV_SVG('<rect x="6" y="3" width="12" height="18" rx="6"/><line x1="12" y1="7" x2="12" y2="11"/>'),
  keyboard: DEV_SVG('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  phone: DEV_SVG('<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
  computer: DEV_SVG('<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/>'),
  watch: DEV_SVG('<rect x="7" y="6" width="10" height="12" rx="3"/><path d="M9 6l1-4h4l1 4M9 18l1 4h4l1-4"/>'),
  gamepad: DEV_SVG('<line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/>'),
  bt: DEV_SVG('<polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>')
};

export const BUDS_SVG = `<svg viewBox="0 0 40 40" fill="none">
  <defs><linearGradient id="budg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#aeb4be"/></linearGradient></defs>
  <g fill="url(#budg)">
    <rect x="13.4" y="14" width="4.8" height="21" rx="2.4"/><circle cx="12.5" cy="13" r="7.5"/>
    <rect x="21.8" y="14" width="4.8" height="21" rx="2.4"/><circle cx="27.5" cy="13" r="7.5"/>
  </g>
  <circle cx="11.2" cy="13" r="2.1" fill="#7c828c" opacity="0.55"/><circle cx="28.8" cy="13" r="2.1" fill="#7c828c" opacity="0.55"/>
</svg>`;
export const BOLT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.2 2 5 13.4h5.6L9.8 22 19 10.2h-5.7z"/></svg>';
export const LOW_BATT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="10" x2="6" y2="14" stroke="#ff453a" stroke-width="2.5"/></svg>';
export const BATT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="11" x2="12" y2="11"/></svg>';

export const DECK_BT_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>';

export function syncDeckBtTileIcon(dev: BtDevice | null | undefined): void {
  const ico = document.querySelector<HTMLElement>('#deck-tile-bt .mx-ico');
  if (!ico) return;
  let key = 'bt';
  let html = DECK_BT_GLYPH;
  if (dev && appState.btRadio) {
    const kind = dev.kind || 'bt';
    const isBuds = (kind === 'headphones' || kind === 'bt') && /airpod|buds|earbud|earphone|airdope|tws|pods|wf-/i.test(dev.name || '');
    if (isBuds && typeof BUDS_SVG !== 'undefined') { key = 'buds'; html = BUDS_SVG.replace(/budg/g, 'budg-tile'); }
    else if (kind !== 'bt' && DEV_ICONS[kind]) { key = kind; html = DEV_ICONS[kind]; }
  }
  if (ico.dataset.k !== key) {
    ico.dataset.k = key;
    ico.innerHTML = html;
    ico.classList.toggle('has-dev', key !== 'bt');
  }
  let pct: number | null = null;
  if (key !== 'bt' && dev) pct = btBatteryFor(dev.name);
  if (pct === null || pct === undefined || !(pct >= 0)) {
    ico.classList.remove('has-batt');
    ico.style.removeProperty('--p');
  } else {
    ico.classList.add('has-batt');
    ico.style.setProperty('--p', String(Math.max(0, Math.min(100, pct))));
    ico.style.setProperty('--bc', pct <= 15 ? '#ff453a' : pct <= 30 ? '#ff9f0a' : '#30d158');
  }
}

const mqBusyEls = new WeakSet<HTMLElement>();

export function mqFit(el: HTMLElement | null): void {
  if (!el || mqBusyEls.has(el)) return;
  mqBusyEls.add(el);
  const inner = el.querySelector(':scope > .mq-in');
  const text = inner ? inner.textContent : el.textContent;
  el.classList.remove('mq');
  if (inner) el.textContent = text;
  if (el.clientWidth > 0) {
    const over = el.scrollWidth - el.clientWidth;
    if (over > 2) {
      const s = document.createElement('span');
      s.className = 'mq-in';
      s.textContent = text;
      el.textContent = '';
      el.appendChild(s);
      el.style.setProperty('--mq-d', `-${over + 6}px`);
      el.style.setProperty('--mq-t', `${Math.max(4, (over + 6) / 20).toFixed(1)}s`);
      el.classList.add('mq');
    }
  }
  requestAnimationFrame(() => { mqBusyEls.delete(el); });
}

export function setBtCaption(devices: BtDevice[] | { devices?: BtDevice[] } | null | undefined): void {
  const SET = loadSettings();
  const list = Array.isArray(devices) ? devices : (devices && Array.isArray(devices.devices) ? devices.devices : []);
  const first = list.find((d) => d.connected);
  let txt = appState.btRadio && appState.btPresent !== false && first ? first.name : '';
  if (txt && first && SET.overlays?.btBattery) {
    const pct = btBatteryFor(first.name);
    if (pct !== null) txt += ` • ${pct}%`;
  }
  const btCap = document.getElementById('bt-cap');
  if (btCap) btCap.textContent = txt;
  syncDeckBtTileIcon(first);
  const deckBtSub = document.getElementById('deck-bt-sub');
  if (deckBtSub) {
    const _s = appState.btPresent === false ? 'No adapter' : appState.btRadio ? (first ? first.name : 'On') : 'Off';
    if (deckBtSub.textContent !== _s) {
      deckBtSub.textContent = _s;
      mqFit(deckBtSub);
    }
  }
}

export async function refreshBtCaption(): Promise<void> {
  const SET = loadSettings();
  const isDeck = !SET.appearance || SET.appearance.menuLayout === 'deck';
  const slotRunning = appState.slotRunning as Set<string> | undefined;
  if (!slotRunning?.has('bt') && !isDeck) return;
  if (appState.btPresent === false || !appState.btRadio) { setBtCaption([]); return; }
  setBtCaption(await invokeTauri<BtDevice[]>('get_bt_devices'));
}

export function battHtml(pct: number): string {
  const w = Math.max(1, Math.round(pct * 0.12));
  const cls = pct <= 20 ? 'low' : 'ok';
  return `<span class="batt ${cls}"><svg viewBox="0 0 18 10" width="16" height="9"><rect x="0.5" y="0.5" width="14" height="9" rx="2" fill="none" stroke="currentColor"/><rect x="15.5" y="3" width="2" height="4" rx="1" fill="currentColor"/><rect x="2" y="2" width="${w}" height="6" rx="1" fill="currentColor"/></svg></span>${pct}%`;
}

export function btBatteryFor(name: string): number | null {
  const list = (appState.btBatt as Array<{ name?: string; pct: number }> | undefined) || [];
  const n = (name || '').toLowerCase();
  const hit = list.find((b) => {
    const x = (b.name || '').toLowerCase();
    return x === n || x.includes(n) || n.includes(x);
  });
  return hit ? hit.pct : null;
}

export function showBtNote(text: string): void {
  const btList = $('bt-device-list');
  if (!btList) return;
  const note = document.createElement('div');
  note.className = 'wifi-hint';
  note.textContent = text;
  btList.prepend(note);
  setTimeout(() => note.remove(), 3500);
}

let selectedBtName: string | null = null;
let btAction: { name: string; on: boolean } | null = null;
let btScanning = false;
let btScanT: ReturnType<typeof setTimeout> | undefined;

function isBtOpen(): boolean {
  const deckMount = $('deck-sub-mount');
  const inDeck = deckMount && deckMount.querySelector('#view-bt.active');
  return appState.currentView === 'view-bt' || !!inDeck;
}

export function startBtScan(): void {
  if (!appState.btRadio) {
    void loadBtList();
    return;
  }
  btScanning = true;
  $('btn-refresh-bt')?.classList.add('spin');
  clearTimeout(btScanT);
  btScanT = setTimeout(() => {
    btScanning = false;
    $('btn-refresh-bt')?.classList.remove('spin');
  }, 5000);
  invokeTauri('bt_discovery', { on: true });
  void loadBtList(true);
}

export async function loadBtList(soft?: boolean): Promise<void> {
  const btList = $('bt-device-list');
  const btn = $('btn-refresh-bt');
  if (!btList) return;
  if (!appState.btRadio) {
    btList.innerHTML = '<div class="empty-hint">Bluetooth is off</div>';
    return;
  }
  if (appState.btBusy) return;
  if (!soft) {
    if (btn) btn.classList.add('spin');
    btList.innerHTML = '<div class="empty-hint">Scanning…</div>';
  }
  const devices = await invokeTauri<BtDevice[]>('get_bt_devices');
  if (!btScanning && btn) btn.classList.remove('spin');
  if (!isBtOpen() || appState.btBusy) return;
  if (btAction && Array.isArray(devices)) {
    const hit = devices.find((x) => x.name === btAction!.name);
    if (hit && hit.connected === btAction.on) {
      btAction = null;
      selectedBtName = null;
    }
  }
  btList.innerHTML = '';
  const subs: Array<{ d: BtDevice; sub: HTMLSpanElement }> = [];
  if (!devices || devices.length === 0) {
    btList.innerHTML = '<div class="empty-hint">No paired devices found.</div>';
  } else {
    bus.emit('bt:caption-update', devices);
    devices.forEach((d) => {
      const working = !!btAction && btAction.name === d.name;
      const isExpanded = selectedBtName === d.name || working;
      const row = document.createElement('div');
      row.className = 'list-row-item' + (d.connected ? ' on' : '') + (isExpanded ? ' expanded' : '');
      const ico = document.createElement('span');
      ico.className = 'dev-ico';
      ico.innerHTML = (d.kind && DEV_ICONS[d.kind]) || DEV_ICONS.bt;
      const text = document.createElement('div');
      text.className = 'row-text';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = d.name;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = d.connected ? 'Connected' : 'Paired';
      text.append(name, sub);
      row.append(ico, text, rowAction(!!d.connected));
      if (d.connected) subs.push({ d, sub });

      if (isExpanded) {
        const drawer = document.createElement('div');
        drawer.className = 'inline-action-drawer';
        drawer.addEventListener('click', (e) => e.stopPropagation());

        const btnRow = document.createElement('div');
        btnRow.className = 'drawer-row';

        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn' + (d.connected ? ' ghost' : '');
        connBtn.textContent = d.connected ? 'Disconnect' : 'Connect';
        if (working && btAction) {
          connBtn.disabled = true;
          connBtn.textContent = btAction.on ? 'Connecting…' : 'Disconnecting…';
        }

        connBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          connBtn.disabled = true;
          const want = !d.connected;
          connBtn.textContent = want ? 'Connecting…' : 'Disconnecting…';
          btAction = { name: d.name, on: want };
          let ok = false;
          try {
            ok = (await invokeTauri('connect_bt_device', { name: d.name, connect: want })) === true;
          } catch {
            ok = false;
          }
          if (!btAction || btAction.name !== d.name) return;
          btAction = null;
          if (!ok) {
            connBtn.disabled = false;
            connBtn.textContent = want ? 'Connect' : 'Disconnect';
            showBtNote(want ? `Could not connect to ${d.name}` : `Could not disconnect from ${d.name}`);
            return;
          }
          selectedBtName = null;
          void loadBtList(true);
        });

        const fBtn = document.createElement('button');
        fBtn.className = 'drawer-btn ghost';
        fBtn.textContent = 'Remove';
        fBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          fBtn.disabled = true;
          await invokeTauri('unpair_bt_device', { name: d.name });
          selectedBtName = null;
          void loadBtList(true);
        });

        btnRow.append(connBtn, fBtn);
        drawer.appendChild(btnRow);
        row.appendChild(drawer);
      }

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedBtName = selectedBtName === d.name ? null : d.name;
        void loadBtList(true);
      });

      btList.appendChild(row);
    });
  }

  const SET = loadSettings();
  if (subs.length && SET.overlays?.btBattery) {
    subs.forEach(async ({ d, sub }) => {
      let pct = btBatteryFor(d.name);
      if (pct == null) {
        try {
          pct = await invokeTauri<number | null>('get_bt_battery', { name: d.name });
        } catch {
          pct = null;
        }
      }
      if (typeof pct === 'number' && sub.parentNode) {
        sub.innerHTML = `Connected • ${battHtml(pct)}`;
      }
    });
  }
}

export async function renderBtNearby(): Promise<void> {
  const box = $('bt-nearby');
  if (!box || !isBtOpen() || appState.btBusy || appState.btPairing) return;
  const list = (await invokeTauri<BtDevice[]>('get_bt_nearby')) || [];
  if (!box.isConnected || appState.btBusy || appState.btPairing) return;
  box.innerHTML = '';
  if (!list.length) return;
  const head = document.createElement('div');
  head.className = 'wifi-hint';
  head.textContent = 'Nearby: click to pair';
  box.append(head);
  list.forEach((n) => {
    const row = document.createElement('div');
    row.className = 'list-row-item';
    const ico = document.createElement('span');
    ico.className = 'dev-ico';
    ico.innerHTML = (n.kind && DEV_ICONS[n.kind]) || DEV_ICONS.bt;
    const text = document.createElement('div');
    text.className = 'row-text';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = n.name;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = 'Click to pair';
    text.append(name, sub);
    row.append(ico, text, rowAction(false));
    row.addEventListener('click', () => startBtPair(n, row, sub));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void startBtPair(n, row, sub);
    });
    box.appendChild(row);
  });
}

const BT_PAIR_ERR: Record<string, string> = {
  wrong_pin: 'Wrong PIN, try again',
  rejected: 'Pairing was declined',
  timeout: 'The device did not answer in time',
  busy: 'Windows is already pairing another device'
};

export async function startBtPair(n: BtDevice, row: HTMLElement, sub: HTMLElement): Promise<void> {
  if (appState.btPairing) return;
  appState.btPairing = true;
  row.classList.add('busy');
  sub.textContent = 'Pairing…';
  const r = await invokeTauri<string>('bt_pair', { id: n.id, name: n.name });
  appState.btPairing = false;
  appState.btBusy = false;
  appState.keepOpen = false;
  if (!isBtOpen()) return;
  await loadBtList(true);
  if (r !== 'ok') showBtNote((r && BT_PAIR_ERR[r]) || 'Could not pair, try again');
}

export function showBtPrompt(p: BtPromptPayload | null | undefined): void {
  if (!p) return;
  if (!isBtOpen()) {
    if (p.kind !== 'display_pin') invokeTauri('bt_pair_answer', { accept: false });
    return;
  }
  appState.btBusy = true;
  appState.keepOpen = true;
  invokeTauri('focus_island');
  const btList = $('bt-device-list');
  if (!btList) return;
  btList.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'wifi-join';
  const title = document.createElement('div');
  title.className = 'wj-title';
  title.textContent = p.name;
  const msg = document.createElement('div');
  msg.className = 'wj-msg';
  box.append(title);

  const answer = (accept: boolean, pin?: string): Promise<unknown> =>
    invokeTauri('bt_pair_answer', { accept, pin: pin || null });
  const row = document.createElement('div');
  row.className = 'wj-row';

  if (p.kind === 'display_pin') {
    msg.textContent = 'Type this code on the device:';
    const code = document.createElement('div');
    code.className = 'wj-title';
    code.style.fontSize = '20px';
    code.style.letterSpacing = '4px';
    code.textContent = p.pin || '';
    box.append(msg, code);
  } else if (p.kind === 'confirm_pin') {
    msg.textContent = 'Does this code match the one on the device?';
    const code = document.createElement('div');
    code.className = 'wj-title';
    code.style.fontSize = '20px';
    code.style.letterSpacing = '4px';
    code.textContent = p.pin || '';
    const yes = document.createElement('button');
    yes.className = 'wj-btn';
    yes.textContent = 'Yes, pair';
    const no = document.createElement('button');
    no.className = 'wj-btn ghost';
    no.textContent = 'No';
    row.append(yes, no);
    yes.addEventListener('click', () => {
      yes.disabled = no.disabled = true;
      msg.textContent = 'Pairing…';
      void answer(true);
    });
    no.addEventListener('click', () => {
      yes.disabled = no.disabled = true;
      void answer(false);
    });
    box.append(msg, code, row);
  } else {
    msg.textContent = 'Enter the PIN of the device (often 0000):';
    const pin = document.createElement('input');
    pin.className = 'wj-input';
    pin.placeholder = 'PIN';
    pin.maxLength = 16;
    pin.autocomplete = 'off';
    const go = document.createElement('button');
    go.className = 'wj-btn';
    go.textContent = 'Pair';
    const cancel = document.createElement('button');
    cancel.className = 'wj-btn ghost';
    cancel.textContent = 'Cancel';
    row.append(pin, go, cancel);
    const submit = (): void => {
      if (!pin.value.trim()) return;
      go.disabled = cancel.disabled = true;
      msg.textContent = 'Pairing…';
      void answer(true, pin.value.trim());
    };
    go.addEventListener('click', submit);
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    cancel.addEventListener('click', () => {
      go.disabled = cancel.disabled = true;
      void answer(false);
    });
    box.append(msg, row);
    setTimeout(() => pin.focus(), 120);
  }
  btList.append(box);
}

export function openBtView(): void {
  if (appState.btPresent === false) return;
  bus.emit('view:switch', { viewId: 'view-bt', stateClass: 'state-sub', width: 316, height: 208 });
  invokeTauri('bt_discovery', { on: true });
  void loadBtList();
}

// ---- Dynamic Island Device HUD ----
let btHudTimer: ReturnType<typeof setTimeout> | undefined;
let btHudStartT: ReturnType<typeof setTimeout> | undefined;
let btHudBackT: ReturnType<typeof setTimeout> | undefined;
let btHudEndT: ReturnType<typeof setTimeout> | undefined;
export let btHudPrompt = false;

export function hudIsFloating(): boolean {
  const SET = loadSettings();
  return !!(SET.notch && SET.notch.style === 'floating');
}

export function hudCanShow(): boolean {
  return appState.currentView === 'view-compact';
}

export function hudIslandSize(): IslandSize {
  return { width: ISLAND_WIN_W, height: hudIsFloating() ? 64 : 54 };
}

function isRadarCardOpen(): boolean {
  return !!island?.classList.contains('anim-radar-card-open');
}

export function popupIsBusy(): boolean {
  return !!(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast || isRadarCardOpen());
}

let popupSizeOn = false;
let popupSizeT: ReturnType<typeof setTimeout> | undefined;

export function compactIslandSize(win: IslandSize): IslandSize {
  if (isRadarCardOpen()) return { width: 320, height: 124 };
  if (popupIsBusy() && !(island?.classList.contains('alarm-active') || island?.classList.contains('bt-hud-active')
      || island?.classList.contains('biometric-active') || island?.classList.contains('bio-hud'))) {
    popupSizeOn = true;
    return hudIslandSize();
  }
  return win;
}

export function hudRestoreSize(): void {
  if (!hudCanShow() || appState.alarmActive) return;
  if (isRadarCardOpen()) {
    reportIslandSize({ width: 320, height: 124 });
    return;
  }
  if (popupIsBusy()) {
    reportIslandSize(hudIslandSize());
    return;
  }
  reportIslandSize({ width: ISLAND_WIN_W, height: hudIsFloating() ? 48 : 36 });
}

export function syncPopupSize(busy: boolean): void {
  if (appState.currentView !== 'view-compact') return;
  if (isRadarCardOpen()) {
    clearTimeout(popupSizeT);
    reportIslandSize({ width: 320, height: 124 });
    return;
  }
  if (appState.alarmActive || island?.classList.contains('bt-hud-active') || island?.classList.contains('hud-pre')
      || island?.classList.contains('biometric-active') || island?.classList.contains('bio-hud')) return;
  clearTimeout(popupSizeT);
  if (busy) {
    popupSizeOn = true;
    reportIslandSize(hudIslandSize());
  } else if (popupSizeOn) {
    popupSizeT = setTimeout(() => {
      popupSizeOn = false;
      if (isRadarCardOpen() || island?.classList.contains('bio-hud') || island?.classList.contains('biometric-active')
          || island?.classList.contains('hud-pre') || island?.classList.contains('bt-hud-active')
          || island?.classList.contains('alarm-active') || appState.alarmActive) return;
      if (!popupIsBusy()) hudRestoreSize();
    }, 650);
  }
}

export function showDeviceHud(o: DeviceHudOptions): void {
  if (!hudCanShow() || appState.alarmActive) return;
  const hud = $('c-bt-hud');
  const ico = $('bt-hud-icon');
  const nameEl = $('bt-hud-name');
  const tagEl = $('bt-hud-tag');
  const battBox = $('bt-hud-batt-box');
  const ring = $('bt-hud-ring');
  const battTxt = $('bt-hud-batt-pct');
  if (!hud || !ico || !nameEl || !island) return;

  const alreadyOpen = island.classList.contains('bt-hud-active') && !island.classList.contains('hud-out') && !hud.classList.contains('hidden');
  clearTimeout(btHudTimer);
  clearTimeout(btHudStartT);
  clearTimeout(btHudBackT);
  clearTimeout(btHudEndT);
  btHudPrompt = !!o.actions;

  island.classList.remove('biometric-active', 'hud-out', 'hud-back', 'bio-hud');
  $('c-biometric-box')?.classList.add('hidden');

  ico.className = 'bt-hud-icon' + (o.plain ? ' plain' : '') + (o.accent ? ' ' + o.accent : '');
  ico.innerHTML = o.iconHTML;
  nameEl.textContent = o.name || 'Device';
  if (tagEl) tagEl.textContent = o.tag || 'Connected';
  const actBox = $('bt-hud-actions');
  if (actBox) actBox.classList.toggle('hidden', !o.actions);

  const pct = o.pct;
  const hasBatt = pct != null && pct >= 0 && pct <= 100;
  if (battBox) battBox.classList.toggle('hidden', !hasBatt);

  const battFill = $('bt-batt-fill');
  const battGlyph = $('bt-batt-glyph');
  const asBatt = !!o.battery && hasBatt && !!battFill && !!battGlyph;
  if (battBox) battBox.classList.toggle('as-batt', asBatt);
  if (asBatt && battGlyph && battFill && pct != null) {
    const charging = o.accent === 'green';
    const lowB = o.accent === 'red' || (pct <= 10 && !charging);
    const amberB = !lowB && (o.accent === 'amber' || (pct <= 20 && !charging));
    battGlyph.classList.toggle('charging', charging);
    battGlyph.classList.toggle('low', lowB);
    battFill.className = 'bt-batt-fill' + (lowB ? ' low' : amberB ? ' amber' : '');
    battFill.style.transition = 'none';
    battFill.style.width = '0%';
    void battFill.getBoundingClientRect();
    battFill.style.transition = '';
    setTimeout(() => { battFill.style.width = Math.max(pct, 6) + '%'; }, 60);
  }
  if (hasBatt && ring && battTxt && pct != null) {
    ring.classList.remove('low', 'amber');
    if (o.accent === 'red' || (pct <= 10 && o.accent !== 'green')) {
      ring.classList.add('low');
    } else if (o.accent === 'amber' || (pct <= 20 && o.accent !== 'green')) {
      ring.classList.add('amber');
    }
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = '66';
    void ring.getBoundingClientRect();
    ring.style.transition = '';
    battTxt.textContent = '0%';
    setTimeout(() => { ring.style.strokeDashoffset = String(66 * (1 - pct / 100)); }, 60);
    const t0 = performance.now() + 380;
    const tick = (t: number): void => {
      const k = Math.min(1, Math.max(0, (t - t0) / 900));
      battTxt.textContent = Math.round(pct * (1 - Math.pow(1 - k, 3))) + '%';
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const win = hudIslandSize();
  cancelCloseEase();
  if (alreadyOpen) {
    reportIslandSize(win);
    hud.classList.add('hidden');
    void hud.offsetWidth;
    hud.classList.remove('hidden');
  } else {
    hud.classList.remove('hidden');
    reportIslandSize(win);
    island.classList.add('hud-pre');
    btHudStartT = setTimeout(() => {
      island?.classList.remove('hud-pre');
      island?.classList.add('bt-hud-active');
    }, 110);
  }

  btHudTimer = setTimeout(() => hideDeviceHud(), o.ms || 3200);
}

export function hideDeviceHud(instant?: boolean): void {
  const hud = $('c-bt-hud');
  if (!hud || !island) return;
  clearTimeout(btHudTimer);
  clearTimeout(btHudStartT);
  clearTimeout(btHudBackT);
  clearTimeout(btHudEndT);
  btHudPrompt = false;
  const finish = (): void => {
    hud.classList.add('hidden');
    island?.classList.remove('bt-hud-active', 'hud-out', 'hud-back', 'hud-pre');
    hudRestoreSize();
    bus.emit('hud:closed');
  };
  if (instant || hud.classList.contains('hidden')) {
    if (!hud.classList.contains('hidden')) finish();
    return;
  }
  island.classList.add('hud-out');
  btHudBackT = setTimeout(() => {
    island?.classList.remove('bt-hud-active', 'hud-out');
    island?.classList.add('hud-back');
    hud.classList.add('hidden');
    btHudEndT = setTimeout(() => {
      island?.classList.remove('hud-back');
      hudRestoreSize();
      bus.emit('hud:closed');
    }, 450);
  }, 160);
}

export function showBtConnectHud(name: string | undefined, kind: string | undefined, battPct: number | null | undefined): void {
  invokeTauri('play_status_sound', { kind: 'bluetooth' }).catch(() => {});
  const isBuds = kind === 'headphones' && /airpod|buds|earbud|earphone|airdope|tws|pods|wf-/i.test(name || '');
  showDeviceHud({
    iconHTML: isBuds ? BUDS_SVG : ((kind && DEV_ICONS[kind]) || DEV_ICONS.bt),
    plain: !isBuds,
    name: name || 'Device',
    tag: 'Connected',
    pct: battPct
  });
}

let prevConnectedBtDevs: Set<string> | null = null;
export async function checkNewBtConnections(): Promise<void> {
  try {
    const devs = await invokeTauri<BtDevice[]>('get_bt_devices');
    if (!Array.isArray(devs)) return;
    const connected = devs.filter((d) => d && d.connected);
    if (prevConnectedBtDevs === null) {
      prevConnectedBtDevs = new Set(connected.map((d) => d.name));
      return;
    }
    const newly = connected.find((d) => !prevConnectedBtDevs!.has(d.name));
    prevConnectedBtDevs = new Set(connected.map((d) => d.name));
    if (newly) {
      let pct = btBatteryFor(newly.name);
      if (pct == null) {
        try {
          pct = await invokeTauri<number | null>('get_bt_battery', { name: newly.name });
        } catch {
          pct = null;
        }
      }
      showBtConnectHud(newly.name, newly.kind, pct);
    }
  } catch (err) {
    console.warn('Error checking new BT connections:', err);
  }
}

export function initBluetooth(): void {
  bus.on<DeviceHudOptions>('hud:show', (o) => showDeviceHud(o));
  bus.on<boolean>('hud:hide', (instant) => hideDeviceHud(instant));

  $('tile-bt')?.addEventListener('click', (e) => {
    if (appState.btPresent === false) return;
    if ((e.target as Element | null)?.closest('.chev')) {
      openBtView();
      return;
    }
    bus.emit('radio:toggle', { kind: 'bt', on: !appState.btRadio });
  });
  $('tile-bt')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openBtView();
  });
  $('btn-refresh-bt')?.addEventListener('click', () => startBtScan());
  $('btn-more-bt')?.addEventListener('click', () => invokeTauri('open_bt_settings'));

  listenTauri('bluetooth-changed', () => {
    setTimeout(() => {
      bus.emit('bt:refresh');
      void checkNewBtConnections();
      if (isBtOpen()) void loadBtList(true);
    }, 400);
  });
  listenTauri('bluetooth-nearby', () => {
    setTimeout(renderBtNearby, 500);
  });
  listenTauri<BtPromptPayload>('bt-pairing', (e) => {
    const raw = e as unknown as BtPromptPayload & { payload?: BtPromptPayload };
    showBtPrompt(raw?.payload !== undefined ? raw.payload : raw);
  });

  invokeTauri('bt_backend', { on: true }).catch(() => {});
  setTimeout(checkNewBtConnections, 1200);
  setInterval(checkNewBtConnections, 3500);
}
