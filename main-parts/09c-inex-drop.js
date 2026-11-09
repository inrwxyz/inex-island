// ======================================================================================
// Quick Share: Native offline local file sharing with Android & Windows devices
// Reverse-engineered Google Nearby / Quick Share protocol over Wi-Fi / LAN & Bluetooth
// ======================================================================================

let dropActive = false;
let inTransfer = false;
let isScanning = false;
let transferPaused = false;
let selectedFiles = [];
const discoveredDevices = new Map();
let currentOffer = null;
let offerExpireTimer = null;
let xferHideTimer = null;
let lastSendSuccess = false;
let selListOpen = false;

function fileCategory(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)) return 'image';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'apk'].includes(ext)) return 'zip';
  return 'file';
}

const FILE_ICONS = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  zip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><rect x="10" y="8" width="4" height="4" rx="1"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6z"/><polyline points="15 2 15 6 19 6"/><path d="M4 7v13a2 2 0 0 0 2 2h9"/></svg>'
};

function getFileIcon(name) {
  return FILE_ICONS[fileCategory(name)] || FILE_ICONS.file;
}

function getBatchIcon(names) {
  if (!names || names.length <= 1) return getFileIcon((names && names[0]) || '');
  const cats = new Set(names.map(fileCategory));
  return cats.size === 1 ? FILE_ICONS[[...cats][0]] : FILE_ICONS.files;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function promptTitle(p) {
  const count = p.count || 1;
  return count > 1 ? `${count} files` : (p.name || 'File');
}

// Island notch prompt HUD
function showPromptHud(p) {
  if (typeof showDeviceHud === 'function') {
    showDeviceHud({
      iconHTML: getBatchIcon(p.names || [p.name]),
      plain: true,
      name: promptTitle(p),
      tag: `${fmtBytes(p.size || p.total)} • ${p.device || 'Phone'}`,
      actions: true,
      ms: 15000
    });
  }
}

function closePromptHud(instant) {
  if (typeof hideDeviceHud === 'function' && typeof btHudPrompt !== 'undefined' && btHudPrompt) {
    hideDeviceHud(!!instant);
  }
}

function clearPrompt() {
  currentOffer = null;
  clearTimeout(offerExpireTimer);
  closePromptHud(true);
}

function openDropView() {
  switchView('view-inexdrop', 'state-sub', 316, 268);
  refreshDropUI();
}

async function refreshDropUI() {
  let status = null;
  try {
    status = await invokeTauri('get_quick_share_status');
  } catch (_) {}

  dropActive = !!(status && status.running);

  const tileDrop = document.getElementById('tile-drop');
  if (tileDrop) {
    tileDrop.classList.toggle('active', dropActive);
  }

  const subEl = document.getElementById('tile-drop-sub');
  if (subEl) {
    if (inTransfer) {
      subEl.textContent = 'Transferring';
    } else if (dropActive) {
      subEl.textContent = 'Ready';
    } else {
      subEl.textContent = 'Off';
    }
  }

  const pill = document.getElementById('drop-status-pill');
  const toggle = document.getElementById('qs-master-toggle');
  if (toggle) toggle.checked = dropActive;

  const boxIdle = document.getElementById('drop-state-idle');
  const boxActive = document.getElementById('drop-state-active');
  const boxPrompt = document.getElementById('drop-state-prompt');

  if (currentOffer) {
    if (pill) { pill.textContent = 'Incoming...'; pill.className = 'status-tag warn'; }
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxActive) boxActive.classList.add('hidden');
    if (boxPrompt) boxPrompt.classList.remove('hidden');
    return;
  }
  if (boxPrompt) boxPrompt.classList.add('hidden');

  if (!dropActive) {
    if (pill) { pill.textContent = 'Off'; pill.className = 'status-tag'; }
    if (boxIdle) boxIdle.classList.remove('hidden');
    if (boxActive) boxActive.classList.add('hidden');
    return;
  }

  // Active
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
  if (boxActive) { boxActive.classList.remove('hidden'); boxActive.classList.toggle('is-xfer', !!inTransfer); }

  const myNameEl = document.getElementById('qs-my-name');
  if (myNameEl && status && status.device_name) {
    myNameEl.textContent = status.device_name;
  }

  // Sync staged files from Rust if selectedFiles is empty
  if (selectedFiles.length === 0) {
    try {
      const staged = await invokeTauri('get_staged_quick_share_files');
      if (Array.isArray(staged) && staged.length > 0) {
        selectedFiles = staged;
      }
    } catch (_) {}
  }

  renderSelection();
}

function renderSelection() {
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
  // one file: its name; more: only a number (tap the chip to see what is inside)
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

async function startScanning() {
  if (!dropActive || inTransfer || isScanning) return;
  try {
    isScanning = true;
    await invokeTauri('start_quick_share_scan');
    const pill = document.getElementById('drop-status-pill');
    if (pill && !inTransfer) {
      pill.textContent = 'Scanning...'; pill.className = 'status-tag warn';
    }
  } catch (err) {
    console.error('start_quick_share_scan error:', err);
  }
}

async function stopScanning() {
  if (!isScanning) return;
  isScanning = false;
  try {
    await invokeTauri('stop_quick_share_scan');
  } catch (_) {}
  const pill = document.getElementById('drop-status-pill');
  if (pill && dropActive && !inTransfer) {
    pill.textContent = 'Ready'; pill.className = 'status-tag ok';
  }
}

function clearDiscoveredDevices() {
  discoveredDevices.clear();
  const list = document.getElementById('qs-devices-list');
  if (list) list.innerHTML = '';
}

function addDiscoveredDevice(dev) {
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

function removeDiscoveredDevice(key) {
  discoveredDevices.delete(key);
  const el = document.querySelector(`.qs-device-item[data-key="${key}"]`);
  if (el) el.remove();

  const scanTxt = document.getElementById('qs-scan-text');
  if (scanTxt && selectedFiles.length > 0 && discoveredDevices.size === 0) {
    scanTxt.textContent = 'Looking for nearby devices...';
  }
}

async function sendFilesToDevice(dev) {
  if (!selectedFiles.length) {
    showToast('info', 'Choose files to send first');
    return;
  }
  if (inTransfer) {
    showToast('warn', 'Transfer already in progress');
    return;
  }

  showTransferBox('Sending', `Connecting to ${dev.name}...`, true);

  // Compact island transfer notification
  if (typeof startCompactTransferUI === 'function') {
    appState.xferDir = 'send';
    startCompactTransferUI();
  }

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
      showToast('warn', 'Transfer rejected or busy');
      endTransfer(2000);
    }
  } catch (err) {
    showToast('error', `Send error: ${err}`);
    endTransfer(2000);
  }
}

function showTransferBox(title, sub, canPause) {
  inTransfer = true;
  transferPaused = false;
  clearTimeout(xferHideTimer);

  document.getElementById('drop-state-active')?.classList.add('is-xfer');
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
  if (pill) { pill.textContent = 'Transferring'; pill.className = 'status-tag ok'; }
}

function endTransfer(delay = 2800) {
  clearTimeout(xferHideTimer);
  xferHideTimer = setTimeout(() => {
    const box = document.getElementById('qs-transfer-box');
    if (box) box.classList.add('hidden');
    inTransfer = false;
    document.getElementById('drop-state-active')?.classList.remove('is-xfer');
    refreshDropUI();
  }, delay);

  if (typeof finishCompactTransferUI === 'function') {
    finishCompactTransferUI();
  }
}

function activateOfferPrompt(offer) {
  currentOffer = offer;
  clearTimeout(offerExpireTimer);

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
  if (iconEl) iconEl.innerHTML = getBatchIcon(offer.files ? offer.files.map(f => f.name) : [fName]);
  if (pinEl) pinEl.textContent = offer.pin || '----';

  if (appState.currentView === 'view-inexdrop') {
    refreshDropUI();
  } else {
    showPromptHud({
      name: displayTitle,
      size: offer.total || firstFile.size,
      device: offer.device || 'Phone',
      count: offer.count || 1,
      names: offer.files ? offer.files.map(f => f.name) : [fName]
    });
  }
}

async function acceptTransferPrompt() {
  if (!currentOffer) return;
  clearTimeout(offerExpireTimer);
  closePromptHud();
  currentOffer = null;

  showTransferBox('Receiving', 'Accepted! Starting transfer...', true);

  if (typeof startCompactTransferUI === 'function') {
    appState.xferDir = 'recv';
    startCompactTransferUI();
  }

  await invokeTauri('respond_quick_share_offer', { accept: true });
  refreshDropUI();
}

async function declineTransferPrompt(silent = false) {
  if (!currentOffer) return;
  clearTimeout(offerExpireTimer);
  closePromptHud();
  currentOffer = null;

  await invokeTauri('respond_quick_share_offer', { accept: false });
  refreshDropUI();
  if (!silent) {
    showToast('unphone', 'Transfer declined', 1800);
  }
}

async function startInexDrop() {
  try {
    const res = await invokeTauri('start_quick_share');
    if (res) {
      dropActive = true;
      refreshDropUI();
      showToast('done', 'Quick Share is Ready', 1500);
    }
  } catch (err) {
    showToast('error', 'Could not start Quick Share: ' + err);
  }
}

async function stopInexDrop() {
  try {
    await invokeTauri('stop_quick_share');
    dropActive = false;
    inTransfer = false;
    clearDiscoveredDevices();
    refreshDropUI();
    showToast('info', 'Quick Share is Off', 1500);
  } catch (_) {}
}

async function toggleInexDrop() {
  if (dropActive) {
    await stopInexDrop();
  } else {
    await startInexDrop();
  }
}

// Global Quick Share Event Listener
onTauriEvent('quickshare-event', (event) => {
  let p = event.payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (_) {}
  }
  if (!p || typeof p !== 'object') return;

  switch (p.type) {
    case 'started': {
      dropActive = true;
      refreshDropUI();
      break;
    }
    case 'stopped': {
      dropActive = false;
      inTransfer = false;
      clearPrompt();
      clearDiscoveredDevices();
      refreshDropUI();
      break;
    }
    case 'scan_started': {
      isScanning = true;
      refreshDropUI();
      break;
    }
    case 'scan_stopped': {
      isScanning = false;
      refreshDropUI();
      break;
    }
    case 'device': {
      addDiscoveredDevice(p);
      break;
    }
    case 'device_gone': {
      removeDiscoveredDevice(p.key);
      break;
    }
    case 'offer': {
      activateOfferPrompt(p);
      break;
    }
    case 'offer_closed': {
      clearPrompt();
      refreshDropUI();
      break;
    }
    case 'send_started': {
      lastSendSuccess = false;
      showTransferBox('Sending', `Connecting to ${p.device || 'device'}...`, true);
      break;
    }
    case 'send_pin': {
      const pinEl = document.getElementById('qs-xfer-pin');
      const subEl = document.getElementById('qs-xfer-sub');
      if (pinEl) {
        pinEl.textContent = p.pin;
        pinEl.classList.remove('hidden');
      }
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
    case 'rx_accepted': {
      showTransferBox('Receiving', `Receiving from ${p.device || 'phone'}...`, true);
      break;
    }
    case 'xfer_paused': {
      transferPaused = true;
      const btnPause = document.getElementById('btn-qs-pause');
      if (btnPause) btnPause.textContent = 'Resume';
      const tSpeed = document.getElementById('qs-xfer-speed');
      if (tSpeed) tSpeed.textContent = 'Paused';
      const tPct = document.getElementById('qs-xfer-pct');
      const curPct = tPct ? parseInt(tPct.textContent) || 0 : 0;
      if (typeof updateCompactTransferPct === 'function') {
        updateCompactTransferPct(curPct, 'Paused');
      }
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
      if (!appState.transferring && typeof startCompactTransferUI === 'function') {
        startCompactTransferUI();
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

      if (typeof updateCompactTransferPct === 'function') {
        updateCompactTransferPct(Math.round(pctNum), speedStr, p.name);
      }
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

      if (typeof showDeviceHud === 'function') {
        const sentSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
        showDeviceHud({
          iconHTML: sentSvg,
          plain: true,
          accent: 'ok',
          name: 'Files sent',
          tag: 'Sent to Phone',
          ms: 3000
        });
      }
      showToast('done', 'Files sent successfully!', 2000);
      break;
    }
    case 'send_finished': {
      if (p.cancelled) {
        showToast('warn', 'Transfer cancelled');
      }
      endTransfer(p.cancelled ? 600 : 3000);
      if (lastSendSuccess || p.cancelled) {
        selectedFiles = [];
        try { invokeTauri('clear_staged_quick_share_files'); } catch (_) {}
        clearDiscoveredDevices();
        renderSelection();
      }
      break;
    }
    case 'file_done': {
      // a toast here covers the progress pill between two files of one batch: the final "All files saved" toast is enough
      if (!appState.transferring) showToast('done', `Saved: ${p.name}`);
      break;
    }
    case 'rx_session_end': {
      clearPrompt();
      if (p.ok) {
        const tBar = document.getElementById('qs-xfer-bar');
        const tPct = document.getElementById('qs-xfer-pct');
        const tSub = document.getElementById('qs-xfer-sub');
        if (tBar) tBar.style.width = '100%';
        if (tPct) tPct.textContent = '100%';
        if (tSub) tSub.textContent = 'All files received!';

        if (typeof showDeviceHud === 'function') {
          const dlDoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
          showDeviceHud({
            iconHTML: dlDoneSvg,
            plain: true,
            accent: 'ok',
            name: 'Files received',
            tag: 'Saved to Downloads',
            ms: 3500
          });
        }
        showToast('done', 'All files saved to Downloads', 2500);
      } else if (p.cancelled) {
        showToast('warn', 'Transfer cancelled');
      } else if (p.error) {
        showToast('error', `Transfer error: ${p.error}`, 4000);
      }
      endTransfer(p.cancelled ? 600 : 2500);
      break;
    }
    case 'error': {
      showToast('error', p.message || 'Quick Share error');
      endTransfer(1500);
      break;
    }
  }
});

function initInexDrop() {
  const tileDrop = document.getElementById('tile-drop');
  if (tileDrop) {
    tileDrop.addEventListener('click', (e) => {
      if (e.target.closest('.chev')) return openDropView();
      toggleInexDrop();
    });
    tileDrop.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openDropView();
    });
  }

  const qsToggle = document.getElementById('qs-master-toggle');
  if (qsToggle) {
    qsToggle.addEventListener('change', () => {
      if (qsToggle.checked) {
        startInexDrop();
      } else {
        stopInexDrop();
      }
    });
  }

  const btnStart = document.getElementById('btn-drop-start');
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      startInexDrop();
    });
  }

  const btnOpenDl = document.getElementById('btn-qs-open-downloads');
  if (btnOpenDl) {
    btnOpenDl.addEventListener('click', () => {
      invokeTauri('open_quick_share_downloads');
    });
  }

  let isPickingFiles = false;
  const btnPickFiles = document.getElementById('btn-qs-pick-files');
  if (btnPickFiles) {
    btnPickFiles.addEventListener('click', async (e) => {
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
        console.error('pick files err:', err);
      } finally {
        isPickingFiles = false;
        setTimeout(() => { appState.keepOpen = false; }, 350);
      }
    });
  }

  let isPickingFolder = false;
  const btnPickFolder = document.getElementById('btn-qs-pick-folder');
  if (btnPickFolder) {
    btnPickFolder.addEventListener('click', async (e) => {
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
        console.error('pick folder err:', err);
      } finally {
        isPickingFolder = false;
        setTimeout(() => { appState.keepOpen = false; }, 350);
      }
    });
  }

  document.getElementById('btn-qs-sel-toggle')?.addEventListener('click', () => {
    selListOpen = !selListOpen;
    renderSelection();
  });

  const btnClearSel = document.getElementById('btn-qs-clear-sel');
  if (btnClearSel) {
    btnClearSel.addEventListener('click', async () => {
      selectedFiles = [];
      try { await invokeTauri('clear_staged_quick_share_files'); } catch (_) {}
      clearDiscoveredDevices();
      stopScanning();
      renderSelection();
    });
  }

  const btnPause = document.getElementById('btn-qs-pause');
  if (btnPause) {
    btnPause.addEventListener('click', () => {
      transferPaused = !transferPaused;
      btnPause.textContent = transferPaused ? 'Resume' : 'Pause';
      invokeTauri('control_quick_share', { cmd: transferPaused ? 'p' : 'r' });
    });
  }

  const btnCancel = document.getElementById('btn-qs-cancel');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      invokeTauri('control_quick_share', { cmd: 'c' });
      const tSub = document.getElementById('qs-xfer-sub');
      if (tSub) tSub.textContent = 'Cancelling...';
      btnCancel.disabled = true;
    });
  }

  // Island notch HUD Accept / Decline buttons
  document.getElementById('btn-hud-accept')?.addEventListener('click', (e) => {
    e.stopPropagation();
    acceptTransferPrompt();
  });
  document.getElementById('btn-hud-decline')?.addEventListener('click', (e) => {
    e.stopPropagation();
    declineTransferPrompt();
  });

  // Subview Accept / Decline buttons
  document.getElementById('btn-prompt-accept')?.addEventListener('click', () => {
    acceptTransferPrompt();
  });
  document.getElementById('btn-prompt-decline')?.addEventListener('click', () => {
    declineTransferPrompt();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInexDrop);
} else {
  initInexDrop();
}
