// Quick Share / Inex Drop Feature: Nearby sharing with Android & Windows
import { $ } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { loadSettings } from '../../core/settings.js';
import { bus } from '../../core/bus.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { showDeviceHud, hideDeviceHud } from '../bluetooth/index.js';
import { getDropMode, updateDropTile, openDeckDrop } from './rail.js';

export let dropActive = false;
export let inTransfer = false;
export let isScanning = false;
export let transferPaused = false;
export let selectedFiles = [];
export const discoveredDevices = new Map();
export let currentOffer = null;
let offerExpireTimer = null;
let xferHideTimer = null;
let lastSendSuccess = false;
let selListOpen = false;

export const DROP_W = 316;
export const DROP_H = 208;

export function fileCategory(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)) return 'image';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'apk'].includes(ext)) return 'zip';
  return 'file';
}

export const FILE_ICONS = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  zip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><rect x="10" y="8" width="4" height="4" rx="1"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6z"/><polyline points="15 2 15 6 19 6"/><path d="M4 7v13a2 2 0 0 0 2 2h9"/></svg>'
};

export function getFileIcon(name) {
  return FILE_ICONS[fileCategory(name)] || FILE_ICONS.file;
}

export function getBatchIcon(names) {
  if (!names || names.length <= 1) return getFileIcon((names && names[0]) || '');
  const cats = new Set(names.map(fileCategory));
  return cats.size === 1 ? FILE_ICONS[[...cats][0]] : FILE_ICONS.files;
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

export function promptTitle(p) {
  const count = p.count || 1;
  return count > 1 ? `${count} files` : (p.name || 'File');
}

export function showPromptHud(p) {
  bus.emit('sound:play', { category: 'transfer', kind: 'transfer-ask' });
  showDeviceHud({
    iconHTML: getBatchIcon(p.names || [p.name]),
    plain: true,
    name: promptTitle(p),
    tag: `${fmtBytes(p.size || p.total)} • ${p.device || 'Phone'}`,
    actions: true,
    ms: 60000
  });
}

export function closePromptHud(instant) {
  hideDeviceHud(!!instant);
}

export function clearPrompt() {
  currentOffer = null;
  clearTimeout(offerExpireTimer);
  closePromptHud(true);
  bus.emit('anim:offer-closed');
  const dropBody = document.querySelector('#view-inexdrop .drop-body');
  const subMount = document.querySelector('.mx-sub-mount');
  const dropView = document.getElementById('view-inexdrop');
  if (dropBody) dropBody.classList.remove('has-prompt');
  if (subMount) subMount.classList.remove('has-prompt');
  if (dropView) dropView.classList.remove('has-prompt');
  updateDropTile({ inTransfer, currentOffer, dropActive });
  bus.emit('smart:sync');
}

function isDeckLayout() {
  const SET = loadSettings();
  return !SET.appearance || SET.appearance.menuLayout === 'deck';
}

export function openQsView() {
  if (isDeckLayout()) {
    openDeckDrop('qs');
    return;
  }
  bus.emit('view:switch', { viewId: 'view-inexdrop', stateClass: 'state-sub', width: DROP_W, height: DROP_H });
  refreshDropUI();
}

export function openP2PView() {
  if (isDeckLayout()) {
    openDeckDrop('p2p');
    return;
  }
  bus.emit('view:switch', { viewId: 'view-p2p', stateClass: 'state-sub', width: DROP_W, height: DROP_H });
  invokeTauri('focus_island').catch(() => {});
}

export function openDropView() {
  if (getDropMode() === 'p2p') openP2PView();
  else openQsView();
}

export function dropTileClick() {
  if (getDropMode() === 'p2p') openP2PView();
  else toggleInexDrop();
}

export function syncScanHint() {
  const h = document.getElementById('qs-scan-hint');
  if (h) h.classList.toggle('off', !dropActive || !!inTransfer);
}

export function clearDiscoveredDevices() {
  discoveredDevices.clear();
  const list = document.getElementById('qs-devices-list');
  if (list) list.innerHTML = '';
}

export async function startScanning() {
  if (!dropActive || inTransfer || isScanning) return;
  try {
    isScanning = true;
    await invokeTauri('start_quick_share_scan');
    const pill = document.getElementById('drop-status-pill');
    if (pill && !inTransfer) {
      pill.textContent = 'Scanning...';
      pill.className = 'status-tag warn';
    }
  } catch (err) {
    console.warn('start_quick_share_scan error:', err);
  }
}

export async function stopScanning() {
  if (!isScanning) return;
  isScanning = false;
  try {
    await invokeTauri('stop_quick_share_scan');
  } catch (err) {
    console.warn('stop_quick_share_scan error:', err);
  }
  const pill = document.getElementById('drop-status-pill');
  if (pill && dropActive && !inTransfer) {
    pill.textContent = 'Ready';
    pill.className = 'status-tag ok';
  }
}

export function renderSelection() {
  const box = document.getElementById('qs-selected-box');
  const txt = document.getElementById('qs-selected-text');
  const list = document.getElementById('qs-selected-list');
  const hint = document.getElementById('qs-scan-hint');
  const scanTxt = document.getElementById('qs-scan-text');

  if (!box || !txt) return;

  if (selectedFiles.length === 0) {
    box.classList.add('hidden');
    box.classList.remove('open');
    if (list) { list.classList.add('hidden'); list.innerHTML = ''; }
    selListOpen = false;
    if (hint) { hint.classList.add('idle'); }
    if (scanTxt) scanTxt.textContent = 'Pick files to find nearby devices';
    clearDiscoveredDevices();
    stopScanning();
    return;
  }

  box.classList.remove('hidden');
  txt.textContent = selectedFiles.length === 1
    ? baseName(selectedFiles[0])
    : `${selectedFiles.length} items selected`;

  if (list) {
    list.innerHTML = '';
    selectedFiles.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'qs-sel-row';
      row.textContent = baseName(f);
      row.title = f;
      list.appendChild(row);
    });
    list.classList.toggle('hidden', !selListOpen);
  }
  box.classList.toggle('open', selListOpen);

  if (hint) {
    hint.classList.remove('idle');
    if (scanTxt) {
      scanTxt.textContent = discoveredDevices.size > 0
        ? 'Nearby devices'
        : 'Looking for nearby devices...';
    }
  }

  if (dropActive && !inTransfer && !isScanning) {
    startScanning();
  }
}

export function addDiscoveredDevice(dev) {
  const key = dev.key || `${dev.ip}:${dev.port}`;
  if (discoveredDevices.has(key)) return;
  discoveredDevices.set(key, dev);

  const list = document.getElementById('qs-devices-list');
  if (!list) return;

  const item = document.createElement('div');
  item.className = 'qs-device-item';
  item.dataset.key = key;

  const isPc = dev.dev_type === 3;
  const avatarIcon = isPc
    ? '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';

  item.innerHTML = `
    <div class="qs-device-avatar">${avatarIcon}</div>
    <div style="flex:1;min-width:0;">
      <div class="qs-device-name">${escapeHtml(dev.name)}</div>
    </div>
  `;

  item.addEventListener('click', () => {
    sendFilesToDevice(dev);
  });

  list.appendChild(item);

  const scanTxt = document.getElementById('qs-scan-text');
  if (scanTxt && selectedFiles.length > 0) {
    scanTxt.textContent = 'Nearby devices';
  }
}

export function removeDiscoveredDevice(key) {
  discoveredDevices.delete(key);
  const el = document.querySelector(`.qs-device-item[data-key="${key}"]`);
  if (el) el.remove();

  const scanTxt = document.getElementById('qs-scan-text');
  if (scanTxt && selectedFiles.length > 0 && discoveredDevices.size === 0) {
    scanTxt.textContent = 'Looking for nearby devices...';
  }
}

export async function sendFilesToDevice(dev) {
  if (!selectedFiles.length) {
    bus.emit('toast:show', { icon: 'info', title: 'Choose files to send first' });
    return;
  }
  if (inTransfer) {
    bus.emit('toast:show', { icon: 'warn', title: 'Transfer already in progress' });
    return;
  }

  showTransferBox('Sending', `Connecting to ${dev.name}...`, true);
  appState.xferDir = 'send';
  bus.emit('transfer:start');

  try {
    const ok = await invokeTauri('send_quick_share_files', {
      name: dev.name,
      ip: dev.ip,
      port: dev.port,
      devType: dev.dev_type || 1,
      instance: dev.instance || '',
      paths: selectedFiles
    });
    if (ok === false) {
      bus.emit('toast:show', { icon: 'warn', title: 'Transfer rejected or busy' });
      endTransfer(2000);
    }
  } catch (err) {
    bus.emit('toast:show', { icon: 'error', title: `Send error: ${err}` });
    endTransfer(2000);
  }
}

export function showTransferBox(title, sub, canPause) {
  inTransfer = true;
  transferPaused = false;
  clearTimeout(xferHideTimer);

  document.getElementById('drop-state-active')?.classList.add('is-xfer');
  syncScanHint();
  const box = document.getElementById('qs-transfer-box');
  const tTitle = document.getElementById('qs-xfer-title');
  const tSub = document.getElementById('qs-xfer-sub');
  const tBar = document.getElementById('qs-xfer-bar');
  const tPct = document.getElementById('qs-xfer-pct');
  const tSpeed = document.getElementById('qs-xfer-speed');
  const tPin = document.getElementById('qs-xfer-pin');
  const pauseBtn = document.getElementById('btn-qs-pause');
  const cancelBtn = document.getElementById('btn-qs-cancel');

  if (box) box.classList.remove('hidden');
  if (tTitle) tTitle.textContent = title;
  if (tSub) tSub.textContent = sub;
  if (tBar) tBar.style.width = '0%';
  if (tPct) tPct.textContent = '0%';
  if (tSpeed) tSpeed.textContent = '';
  if (tPin) tPin.classList.add('hidden');
  if (pauseBtn) {
    pauseBtn.textContent = 'Pause';
    pauseBtn.classList.toggle('hidden', !canPause);
  }
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.classList.remove('hidden');
  }

  const pill = document.getElementById('drop-status-pill');
  if (pill) {
    pill.textContent = 'Transferring';
    pill.className = 'status-tag ok';
  }
}

export function endTransfer(delay = 2800, ok = true) {
  clearTimeout(xferHideTimer);
  xferHideTimer = setTimeout(() => {
    const box = document.getElementById('qs-transfer-box');
    if (box) box.classList.add('hidden');
    inTransfer = false;
    document.getElementById('drop-state-active')?.classList.remove('is-xfer');
    refreshDropUI();
    bus.emit('smart:sync');
  }, delay);

  bus.emit('transfer:finish', { ok });
  bus.emit('smart:sync');
}

export function activateOfferPrompt(offer) {
  currentOffer = offer;
  clearTimeout(offerExpireTimer);

  // Incoming share must unhide smart-mode island immediately before offer UI/animations decide visibility
  document.getElementById('island')?.classList.remove('smart-hidden');

  offerExpireTimer = setTimeout(() => {
    if (currentOffer && currentOffer.pin === offer.pin) {
      declineTransferPrompt(true);
    }
  }, 60000);

  const devEl = document.getElementById('prompt-sender-name');
  const fileEl = document.getElementById('prompt-file-name');
  const sizeEl = document.getElementById('prompt-file-size');
  const iconEl = document.getElementById('prompt-file-icon');
  const pinEl = document.getElementById('prompt-pin');

  const firstFile = (offer.files && offer.files[0]) || {};
  const fName = firstFile.name || 'File';
  const displayTitle = (offer.count || 1) > 1
    ? `${offer.count} files (incl. ${fName})`
    : fName;

  if (devEl) devEl.textContent = offer.device || 'Android Device';
  if (fileEl) fileEl.textContent = displayTitle;
  if (sizeEl) sizeEl.textContent = fmtBytes(offer.total || firstFile.size);
  if (iconEl) iconEl.innerHTML = getBatchIcon(offer.files ? offer.files.map((f) => f.name) : [fName]);
  if (pinEl) pinEl.textContent = offer.pin || '----';

  refreshDropUI();

  if (appState.currentView === 'view-compact') {
    bus.emit('anim:incoming', {
      fileName: displayTitle,
      size: offer.total || firstFile.size,
      sizeText: fmtBytes(offer.total || firstFile.size),
      sender: offer.device || 'Nearby device',
      onAccept: () => acceptTransferPrompt(),
      onDecline: () => declineTransferPrompt()
    });
  }

  const isViewingDrop = (appState.currentView === 'view-inexdrop') ||
    (appState.currentView === 'view-control-deck' && appState.deckSubId === 'view-inexdrop');

  const animCfg = loadSettings()?.animations;
  const radarCardTakesOver = !!(appState.currentView === 'view-compact' && animCfg?.enabled && animCfg?.receive?.enabled && (animCfg?.receive?.id || 'radar') === 'radar');

  if (appState.currentView === 'view-control-deck') {
    if (!isViewingDrop) {
      openDeckDrop('qs');
    }
  } else if (!isViewingDrop && !radarCardTakesOver) {
    showPromptHud({
      name: displayTitle,
      size: offer.total || firstFile.size,
      device: offer.device || 'Phone',
      count: offer.count || 1,
      names: offer.files ? offer.files.map((f) => f.name) : [fName]
    });
  }
}

export async function acceptTransferPrompt() {
  if (!currentOffer) return;
  const firstFile = (currentOffer.files && currentOffer.files[0]) || {};
  const fName = firstFile.name || 'File';
  const displayTitle = (currentOffer.count || 1) > 1
    ? `${currentOffer.count} files (incl. ${fName})`
    : fName;
  const offerMeta = {
    fileName: displayTitle,
    sizeText: fmtBytes(currentOffer.total || firstFile.size),
    sender: currentOffer.device || 'Nearby device'
  };

  clearTimeout(offerExpireTimer);
  closePromptHud();
  currentOffer = null;

  showTransferBox('Receiving', 'Accepted! Starting transfer...', true);
  appState.xferDir = 'recv';
  bus.emit('anim:accepted', offerMeta);
  bus.emit('transfer:start', { dir: 'recv' });

  await invokeTauri('respond_quick_share_offer', { accept: true });
  refreshDropUI();
}

export async function declineTransferPrompt(silent = false) {
  if (!currentOffer) return;
  clearTimeout(offerExpireTimer);
  closePromptHud();
  currentOffer = null;

  await invokeTauri('respond_quick_share_offer', { accept: false });
  refreshDropUI(false);
  if (!silent) {
    bus.emit('toast:show', { icon: 'unphone', title: 'Transfer declined', ms: 1800 });
  }
}

export async function startInexDrop() {
  dropActive = true;
  appState.dropActive = true;
  refreshDropUI(false);
  try {
    const res = await invokeTauri('start_quick_share');
    if (!res) {
      dropActive = false;
      appState.dropActive = false;
      refreshDropUI(false);
    }
  } catch (err) {
    dropActive = false;
    appState.dropActive = false;
    refreshDropUI(false);
    console.warn('start_quick_share error:', err);
  }
}

export async function stopInexDrop() {
  dropActive = false;
  appState.dropActive = false;
  inTransfer = false;
  clearDiscoveredDevices();
  refreshDropUI(false);
  try {
    await invokeTauri('stop_quick_share');
  } catch (err) {
    console.warn('stop_quick_share error:', err);
  } finally {
    refreshDropUI(false);
  }
}

export async function toggleInexDrop() {
  if (dropActive) {
    await stopInexDrop();
  } else {
    await startInexDrop();
  }
}

export async function refreshDropUI(syncFromBackend = true) {
  let status = null;
  if (syncFromBackend) {
    try {
      status = await invokeTauri('get_quick_share_status');
      if (status && typeof status.running === 'boolean') {
        dropActive = status.running;
        appState.dropActive = dropActive;
      }
    } catch (err) {
      console.warn('get_quick_share_status error:', err);
    }
  }

  const tileDrop = document.getElementById('tile-drop');
  if (tileDrop) tileDrop.classList.toggle('active', dropActive);
  const deckDrop = document.getElementById('deck-tile-drop');
  if (deckDrop) deckDrop.classList.toggle('active', dropActive);

  const dropText = inTransfer ? 'Transferring' : (dropActive ? 'Ready' : 'Off');
  const subEl = document.getElementById('tile-drop-sub');
  if (subEl) subEl.textContent = dropText;
  const deckDropSub = document.getElementById('deck-drop-sub');
  if (deckDropSub) deckDropSub.textContent = dropText;

  updateDropTile({ inTransfer, currentOffer, dropActive });

  const pill = document.getElementById('drop-status-pill');
  const toggle = document.getElementById('qs-master-toggle');
  if (toggle) toggle.checked = dropActive;
  syncScanHint();

  const boxIdle = document.getElementById('drop-state-idle');
  const boxActive = document.getElementById('drop-state-active');
  const boxPrompt = document.getElementById('drop-state-prompt');
  const dropBody = document.querySelector('#view-inexdrop .drop-body');
  const subMount = document.querySelector('.mx-sub-mount');
  const dropView = document.getElementById('view-inexdrop');

  const hasPrompt = !!currentOffer;
  if (dropBody) dropBody.classList.toggle('has-prompt', hasPrompt);
  if (subMount) subMount.classList.toggle('has-prompt', hasPrompt);
  if (dropView) dropView.classList.toggle('has-prompt', hasPrompt);

  if (currentOffer) {
    if (dropBody) dropBody.classList.remove('has-active');
    if (pill) { pill.textContent = 'Incoming...'; pill.className = 'status-tag warn'; }
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxActive) boxActive.classList.add('hidden');
    if (boxPrompt) boxPrompt.classList.remove('hidden');

    const devEl = document.getElementById('prompt-sender-name');
    const fileEl = document.getElementById('prompt-file-name');
    const sizeEl = document.getElementById('prompt-file-size');
    const iconEl = document.getElementById('prompt-file-icon');
    const pinEl = document.getElementById('prompt-pin');

    const firstFile = (currentOffer.files && currentOffer.files[0]) || {};
    const fName = firstFile.name || 'File';
    const displayTitle = (currentOffer.count || 1) > 1
      ? `${currentOffer.count} files (incl. ${fName})`
      : fName;

    if (devEl) devEl.textContent = currentOffer.device || 'Android Device';
    if (fileEl) fileEl.textContent = displayTitle;
    if (sizeEl) sizeEl.textContent = fmtBytes(currentOffer.total || firstFile.size);
    if (iconEl) iconEl.innerHTML = getBatchIcon(currentOffer.files ? currentOffer.files.map((f) => f.name) : [fName]);
    if (pinEl) pinEl.textContent = currentOffer.pin || '----';

    updateDropTile({ inTransfer, currentOffer, dropActive });
    return;
  }
  if (boxPrompt) boxPrompt.classList.add('hidden');

  if (!dropActive) {
    if (dropBody) dropBody.classList.remove('has-active');
    if (pill) { pill.textContent = 'Off'; pill.className = 'status-tag'; }
    if (boxIdle) boxIdle.classList.remove('hidden');
    if (boxActive) boxActive.classList.add('hidden');
    return;
  }

  if (dropBody) dropBody.classList.add('has-active');

  if (pill) {
    if (inTransfer) {
      pill.textContent = 'Transferring'; pill.className = 'status-tag ok';
    } else if (isScanning) {
      pill.textContent = 'Scanning...'; pill.className = 'status-tag warn';
    } else {
      pill.textContent = 'Ready'; pill.className = 'status-tag ok';
    }
  }

  if (boxIdle) boxIdle.classList.add('hidden');
  if (boxActive) {
    boxActive.classList.remove('hidden');
    boxActive.classList.toggle('is-xfer', !!inTransfer);
  }

  const myNameEl = document.getElementById('qs-my-name');
  if (myNameEl && status && status.device_name) {
    myNameEl.textContent = status.device_name;
  }

  if (selectedFiles.length === 0) {
    try {
      const staged = await invokeTauri('get_staged_quick_share_files');
      if (Array.isArray(staged) && staged.length > 0) {
        selectedFiles = staged;
      }
    } catch (err) {
      console.warn('get_staged_quick_share_files error:', err);
    }
  }

  renderSelection();
}

export function stageFilesForDrop(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  selectedFiles = [...new Set([...selectedFiles, ...paths])];
  invokeTauri('stage_quick_share_files', { paths: selectedFiles });
  renderSelection();
}

export function initQuickShare() {
  listenTauri('quickshare-event', (event) => {
    let p = event.payload;
    if (typeof p === 'string') {
      try { p = JSON.parse(p); } catch (err) { console.warn('JSON parse error:', err); }
    }
    if (!p || typeof p !== 'object') return;

    switch (p.type) {
      case 'started':
        dropActive = true;
        appState.dropActive = true;
        refreshDropUI();
        break;
      case 'stopped':
        dropActive = false;
        appState.dropActive = false;
        inTransfer = false;
        clearPrompt();
        clearDiscoveredDevices();
        refreshDropUI();
        break;
      case 'scan_started':
        isScanning = true;
        refreshDropUI();
        break;
      case 'scan_stopped':
        isScanning = false;
        refreshDropUI();
        break;
      case 'device':
        addDiscoveredDevice(p);
        break;
      case 'device_gone':
        removeDiscoveredDevice(p.key);
        break;
      case 'offer':
        activateOfferPrompt(p);
        break;
      case 'offer_closed':
        clearPrompt();
        refreshDropUI();
        break;
      case 'send_started':
        lastSendSuccess = false;
        showTransferBox('Sending', `Connecting to ${p.device || 'device'}...`, true);
        break;
      case 'send_pin': {
        const pinEl = document.getElementById('qs-xfer-pin');
        const subEl = document.getElementById('qs-xfer-sub');
        if (pinEl) { pinEl.textContent = p.pin; pinEl.classList.remove('hidden'); }
        if (subEl) subEl.textContent = 'Check matching PIN on phone...';
        break;
      }
      case 'send_waiting': {
        const subEl = document.getElementById('qs-xfer-sub');
        if (subEl) subEl.textContent = 'Waiting for phone to tap Accept...';
        break;
      }
      case 'send_accepted': {
        const pinEl = document.getElementById('qs-xfer-pin');
        const subEl = document.getElementById('qs-xfer-sub');
        if (pinEl) pinEl.classList.add('hidden');
        if (subEl) subEl.textContent = 'Phone accepted! Transmitting...';
        break;
      }
      case 'rx_accepted':
        showTransferBox('Receiving', `Receiving from ${p.device || 'phone'}...`, true);
        break;
      case 'xfer_paused': {
        transferPaused = true;
        const btnPause = document.getElementById('btn-qs-pause');
        if (btnPause) btnPause.textContent = 'Resume';
        const tSpeed = document.getElementById('qs-xfer-speed');
        if (tSpeed) tSpeed.textContent = 'Paused';
        const tPct = document.getElementById('qs-xfer-pct');
        const curPct = tPct ? parseInt(tPct.textContent) || 0 : 0;
        bus.emit('transfer:progress', { pct: curPct, speed: 'Paused' });
        break;
      }
      case 'xfer_resumed': {
        transferPaused = false;
        const btnPause = document.getElementById('btn-qs-pause');
        if (btnPause) btnPause.textContent = 'Pause';
        break;
      }
      case 'progress': {
        appState.xferDir = p.dir === 'rx' ? 'recv' : 'send';
        if (!inTransfer) {
          showTransferBox(p.dir === 'rx' ? 'Receiving' : 'Sending', p.name || 'Transferring...', true);
        }
        if (!appState.transferring) {
          bus.emit('transfer:start');
        }
        const pinEl = document.getElementById('qs-xfer-pin');
        if (pinEl) pinEl.classList.add('hidden');

        const pctNum = Math.min(100, Math.max(0, Number(p.pct) || 0));
        const mbpsNum = Number(p.mbps) || 0;
        const speedStr = transferPaused ? 'Paused' : (mbpsNum > 0 ? `${mbpsNum.toFixed(1)} MB/s` : '');

        const tBar = document.getElementById('qs-xfer-bar');
        const tPct = document.getElementById('qs-xfer-pct');
        const tSpeed = document.getElementById('qs-xfer-speed');
        const tSub = document.getElementById('qs-xfer-sub');

        if (tBar) tBar.style.width = `${pctNum}%`;
        if (tPct) tPct.textContent = `${Math.round(pctNum)}%`;
        if (tSpeed) tSpeed.textContent = speedStr;
        if (tSub && p.name) {
          tSub.textContent = p.files > 1
            ? `${p.name} (${p.file_index || 1}/${p.files})`
            : p.name;
        }

        bus.emit('transfer:progress', { pct: Math.round(pctNum), speed: speedStr, name: p.name });
        break;
      }
      case 'send_done': {
        lastSendSuccess = true;
        const tBar = document.getElementById('qs-xfer-bar');
        const tPct = document.getElementById('qs-xfer-pct');
        const tSub = document.getElementById('qs-xfer-sub');
        if (tBar) tBar.style.width = '100%';
        if (tPct) tPct.textContent = '100%';
        if (tSub) {
          const mb = Number(p.mb || 0).toFixed(1);
          const s = Number(p.secs || 0).toFixed(1);
          const sp = Number(p.mbps || 0).toFixed(1);
          tSub.textContent = `Done! ${mb} MB in ${s}s (${sp} MB/s)`;
        }
        const sentSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
        showDeviceHud({
          iconHTML: sentSvg,
          plain: true,
          accent: 'ok',
          name: 'Files sent',
          tag: 'Sent to Phone',
          ms: 3000
        });
        bus.emit('toast:show', { icon: 'done', title: 'Files sent successfully!', ms: 2000 });
        break;
      }
      case 'send_finished': {
        if (p.cancelled) bus.emit('toast:show', { icon: 'warn', title: 'Transfer cancelled' });
        endTransfer(p.cancelled ? 600 : 3000, !p.cancelled);
        if (lastSendSuccess || p.cancelled) {
          selectedFiles = [];
          invokeTauri('clear_staged_quick_share_files').catch((err) => console.warn('Clear staged failed:', err));
          clearDiscoveredDevices();
          renderSelection();
        }
        break;
      }
      case 'file_done':
        if (!appState.transferring) bus.emit('toast:show', { icon: 'done', title: `Saved: ${p.name}` });
        break;
      case 'rx_session_end': {
        clearPrompt();
        if (p.ok) {
          bus.emit('sound:play', { category: 'transfer', kind: 'transfer' });
          const tBar = document.getElementById('qs-xfer-bar');
          const tPct = document.getElementById('qs-xfer-pct');
          const tSub = document.getElementById('qs-xfer-sub');
          if (tBar) tBar.style.width = '100%';
          if (tPct) tPct.textContent = '100%';
          if (tSub) tSub.textContent = 'All files received!';

          const dlDoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
          showDeviceHud({
            iconHTML: dlDoneSvg,
            plain: true,
            accent: 'ok',
            name: 'Files received',
            tag: 'Saved to Downloads',
            ms: 3500
          });
          bus.emit('toast:show', { icon: 'done', title: 'All files saved to Downloads', ms: 2500 });
        } else if (p.cancelled) {
          bus.emit('toast:show', { icon: 'warn', title: 'Transfer cancelled' });
        } else if (p.error) {
          bus.emit('toast:show', { icon: 'error', title: `Transfer error: ${p.error}`, ms: 4000 });
        }
        endTransfer(p.cancelled ? 600 : 2500, !!p.ok);
        break;
      }
      case 'error':
        bus.emit('toast:show', { icon: 'error', title: p.message || 'Quick Share error' });
        endTransfer(1500, false);
        break;
    }
  });

  bus.on('drop:refresh', () => refreshDropUI());
  bus.on('drop:mode-switched', (mode) => {
    if (mode === 'p2p' && (dropActive || currentOffer || inTransfer)) {
      if (currentOffer) declineTransferPrompt(true);
      stopInexDrop();
    }
  });

  const tileDrop = $('tile-drop');
  if (tileDrop) {
    tileDrop.addEventListener('click', (e) => {
      if (e.target.closest('.chev')) {
        openDropView();
      } else if (getDropMode() === 'p2p' || currentOffer || inTransfer) {
        openDropView();
      } else {
        toggleInexDrop();
      }
    });
    tileDrop.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openDropView();
    });
  }

  $('qs-master-toggle')?.addEventListener('change', () => {
    const checked = $('qs-master-toggle')?.checked;
    if (checked) startInexDrop();
    else stopInexDrop();
  });

  $('btn-drop-start')?.addEventListener('click', () => startInexDrop());
  const updateFolderBtnTitle = (dir) => {
    const btn = $('btn-qs-open-downloads');
    if (btn) btn.setAttribute('title', `Save location: ${dir || 'Downloads'} (click to change, right-click to open)`);
  };

  const savedSaveDir = localStorage.getItem('inex_qs_save_dir');
  if (savedSaveDir) {
    invokeTauri('set_quick_share_save_dir', { path: savedSaveDir }).catch(() => {});
    updateFolderBtnTitle(savedSaveDir);
  } else {
    invokeTauri('get_quick_share_save_dir').then((dir) => updateFolderBtnTitle(dir)).catch(() => {});
  }

  $('btn-qs-open-downloads')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    appState.keepOpen = true;
    try {
      const picked = await invokeTauri('choose_quick_share_save_dir');
      if (picked) {
        localStorage.setItem('inex_qs_save_dir', picked);
        updateFolderBtnTitle(picked);
      }
    } catch (err) {
      console.warn('Choose save dir error:', err);
    } finally {
      setTimeout(() => { appState.keepOpen = false; }, 350);
    }
  });

  $('btn-qs-open-downloads')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    invokeTauri('open_quick_share_downloads');
  });

  let isPickingFiles = false;
  $('btn-qs-pick-files')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isPickingFiles) return;
    isPickingFiles = true;
    appState.keepOpen = true;
    try {
      const picked = await invokeTauri('pick_quick_share_files');
      if (Array.isArray(picked) && picked.length > 0) {
        selectedFiles = [...new Set([...selectedFiles, ...picked])];
        await invokeTauri('stage_quick_share_files', { paths: selectedFiles });
        renderSelection();
      }
    } catch (err) {
      console.warn('Pick files error:', err);
    } finally {
      isPickingFiles = false;
      setTimeout(() => { appState.keepOpen = false; }, 350);
    }
  });

  let isPickingFolder = false;
  $('btn-qs-pick-folder')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isPickingFolder) return;
    isPickingFolder = true;
    appState.keepOpen = true;
    try {
      const folder = await invokeTauri('pick_quick_share_folder');
      if (folder) {
        selectedFiles = [...new Set([...selectedFiles, folder])];
        await invokeTauri('stage_quick_share_files', { paths: selectedFiles });
        renderSelection();
      }
    } catch (err) {
      console.warn('Pick folder error:', err);
    } finally {
      isPickingFolder = false;
      setTimeout(() => { appState.keepOpen = false; }, 350);
    }
  });

  $('btn-qs-sel-toggle')?.addEventListener('click', () => {
    selListOpen = !selListOpen;
    renderSelection();
  });

  $('btn-qs-clear-sel')?.addEventListener('click', async () => {
    selectedFiles = [];
    try { await invokeTauri('clear_staged_quick_share_files'); } catch (err) { console.warn('Clear error:', err); }
    clearDiscoveredDevices();
    stopScanning();
    renderSelection();
  });

  $('btn-qs-pause')?.addEventListener('click', () => {
    transferPaused = !transferPaused;
    const btnPause = $('btn-qs-pause');
    if (btnPause) btnPause.textContent = transferPaused ? 'Resume' : 'Pause';
    const tSpeed = $('qs-xfer-speed');
    if (tSpeed) tSpeed.textContent = transferPaused ? 'Paused' : '';
    const tPct = $('qs-xfer-pct');
    const curPct = tPct ? parseInt(tPct.textContent) || 0 : 0;
    bus.emit('transfer:progress', { pct: curPct, speed: transferPaused ? 'Paused' : '' });
    invokeTauri('control_quick_share', { cmd: transferPaused ? 'p' : 'r' });
  });

  $('btn-qs-cancel')?.addEventListener('click', () => {
    invokeTauri('control_quick_share', { cmd: 'c' });
    const tSub = $('qs-xfer-sub');
    if (tSub) tSub.textContent = 'Cancelling...';
    const btnCancel = $('btn-qs-cancel');
    if (btnCancel) btnCancel.disabled = true;
  });

  $('btn-hud-accept')?.addEventListener('click', (e) => {
    e.stopPropagation();
    acceptTransferPrompt();
  });
  $('btn-hud-decline')?.addEventListener('click', (e) => {
    e.stopPropagation();
    declineTransferPrompt();
  });

  $('btn-prompt-accept')?.addEventListener('click', () => acceptTransferPrompt());
  $('btn-prompt-decline')?.addEventListener('click', () => declineTransferPrompt());

  refreshDropUI(true);
}
