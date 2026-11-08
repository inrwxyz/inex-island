// ======================================================================================
// Inex Drop: Native offline local file sharing between Phone and PC (Wi-Fi / Hotspot)
// ======================================================================================

let dropActive = false;
let dropConnected = false;
let dropCurrentUrl = '';
let currentPromptId = null;
let promptExpireTimer = null;
let dlActiveCount = 0;   // PC -> phone downloads running right now
let promptQueue = [];   // more requests waiting behind the one on screen: every file needs its own Accept

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

// One icon for a whole batch: the shared type if every file is the same kind, else the multi-file icon
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

function promptTitle(p) {
  const count = p.count || 1;
  return count > 1 ? `${count} files` : (p.name || 'File');
}

// Same island popup as Bluetooth connect (same size, spring and timing), with Accept / Decline buttons.
// It disappears after a few seconds like every other popup; the request stays open and can still be
// accepted from the Inex Drop menu until it expires.
function showPromptHud(p) {
  showDeviceHud({
    iconHTML: getBatchIcon(p.names || [p.name]),
    plain: true,
    name: promptTitle(p),
    tag: `${fmtBytes(p.size)} • ${p.device || 'Phone'}`,
    actions: true,
    ms: 8000
  });
}

function closePromptHud(instant) {
  if (typeof hideDeviceHud === 'function' && btHudPrompt) hideDeviceHud(!!instant);
}

// Drops any open request (phone left, Inex Drop stopped, request expired)
function clearPrompt() {
  currentPromptId = null;
  promptQueue = [];
  clearTimeout(promptExpireTimer);
  closePromptHud(true);
}

// Shows the next waiting request (if any) once the previous one has been answered
function showNextPrompt(delay = 450) {
  if (currentPromptId || promptQueue.length === 0) return;
  setTimeout(() => {
    if (currentPromptId || promptQueue.length === 0) return;
    activatePrompt(promptQueue.shift());
  }, delay);
}

function activatePrompt(p) {
  currentPromptId = p.id;
  clearTimeout(promptExpireTimer);
  // the request expires after 1 minute (the phone stops waiting then too)
  promptExpireTimer = setTimeout(() => {
    if (currentPromptId === p.id) {
      declineTransferPrompt(true);
    }
  }, 60000);

  // fill the Inex Drop menu card (used when the menu is open, or opened later)
  const devEl = document.getElementById('prompt-sender-name');
  const fileEl = document.getElementById('prompt-file-name');
  const sizeEl = document.getElementById('prompt-file-size');
  const iconEl = document.getElementById('prompt-file-icon');
  if (devEl) devEl.textContent = p.device || 'Android Phone';
  if (fileEl) fileEl.textContent = promptTitle(p);
  if (sizeEl) sizeEl.textContent = fmtBytes(p.size);
  if (iconEl) iconEl.innerHTML = getBatchIcon(p.names || [p.name]);

  if (appState.currentView === 'view-inexdrop') {
    refreshDropUI();
  } else {
    showPromptHud(p);
  }
}

async function acceptTransferPrompt() {
  if (!currentPromptId) return;
  const pid = currentPromptId;
  currentPromptId = null;
  clearTimeout(promptExpireTimer);
  closePromptHud();
  await invokeTauri('respond_inex_transfer', { id: pid, accept: true });
  refreshDropUI();
  showNextPrompt();
}

async function declineTransferPrompt(silent = false) {
  if (!currentPromptId) return;
  const pid = currentPromptId;
  currentPromptId = null;
  clearTimeout(promptExpireTimer);
  closePromptHud();
  await invokeTauri('respond_inex_transfer', { id: pid, accept: false });
  refreshDropUI();
  if (!silent) {
    showToast('unphone', 'Transfer declined', 1800);
  }
  showNextPrompt(silent ? 450 : 1900);
}

function openDropView() {
  switchView('view-inexdrop', 'state-sub', 316, 248);
  refreshDropUI();
}

async function refreshDropUI() {
  const status = await invokeTauri('get_inex_drop_status');
  if (!status) return;

  dropActive = !!status.running;
  dropConnected = !!status.connected;
  dropCurrentUrl = status.url || '';

  const tileDrop = document.getElementById('tile-drop');
  if (tileDrop) {
    tileDrop.classList.toggle('active', dropActive);
  }

  const subEl = document.getElementById('tile-drop-sub');
  if (subEl) {
    if (dropConnected) {
      subEl.textContent = status.device ? status.device : 'Connected';
    } else if (dropActive) {
      subEl.textContent = `Waiting (${status.remaining}s)`;
    } else {
      subEl.textContent = 'Off';
    }
  }

  const pill = document.getElementById('drop-status-pill');
  const cdBadge = document.getElementById('drop-countdown-badge');
  const btnDisc = document.getElementById('btn-drop-disconnect');
  const boxIdle = document.getElementById('drop-state-idle');
  const boxWait = document.getElementById('drop-state-waiting');
  const boxConn = document.getElementById('drop-state-connected');
  const boxPrompt = document.getElementById('drop-state-prompt');

  // If a transfer authorization prompt is active, ONLY show prompt and never overlap
  if (currentPromptId) {
    if (pill) { pill.textContent = 'Incoming...'; pill.className = 'status-tag warn'; }
    if (cdBadge) cdBadge.classList.add('hidden');
    if (btnDisc) btnDisc.classList.add('hidden');
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxWait) boxWait.classList.add('hidden');
    if (boxConn) boxConn.classList.add('hidden');
    if (boxPrompt) boxPrompt.classList.remove('hidden');
    return;
  }
  if (boxPrompt) boxPrompt.classList.add('hidden');

  if (!dropActive) {
    if (pill) { pill.textContent = 'Off'; pill.className = 'status-tag'; }
    if (cdBadge) cdBadge.classList.add('hidden');
    if (btnDisc) btnDisc.classList.add('hidden');
    if (boxIdle) boxIdle.classList.remove('hidden');
    if (boxWait) boxWait.classList.add('hidden');
    if (boxConn) boxConn.classList.add('hidden');
    return;
  }

  if (dropConnected) {
    if (pill) { pill.textContent = 'Connected'; pill.className = 'status-tag ok'; }
    if (cdBadge) cdBadge.classList.add('hidden');
    if (btnDisc) btnDisc.classList.remove('hidden');
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxWait) boxWait.classList.add('hidden');
    if (boxConn) boxConn.classList.remove('hidden');

    const devName = document.getElementById('drop-dev-name');
    const devIp = document.getElementById('drop-dev-ip');
    if (devName) devName.textContent = status.device || 'Phone';
    if (devIp) devIp.textContent = `Connected • ${status.ip || 'Local Wi-Fi'}`;

    const trayCount = document.getElementById('drop-tray-count');
    if (trayCount) trayCount.textContent = (appState.trayFiles && appState.trayFiles.length) || 0;
  } else {
    // Waiting for scanner connection
    if (pill) { pill.textContent = 'Waiting...'; pill.className = 'status-tag warn'; }
    if (cdBadge) {
      cdBadge.classList.remove('hidden');
      const rem = status.remaining || 60;
      cdBadge.textContent = `00:${rem < 10 ? '0' : ''}${rem}`;
    }
    if (btnDisc) btnDisc.classList.add('hidden');
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxWait) boxWait.classList.remove('hidden');
    if (boxConn) boxConn.classList.add('hidden');

    renderDropQR(dropCurrentUrl);
  }
}

function renderDropQR(url) {
  const container = document.getElementById('drop-qr-container');
  if (!container || !url) return;
  try {
    if (typeof qrcode === 'function') {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const svg = qr.createSvgTag({ scalable: true });
      container.innerHTML = svg;
    } else {
      container.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--dim);word-break:break-all;">${url}</div>`;
    }
  } catch (err) {
    console.error('QR error:', err);
    container.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--dim);">${url}</div>`;
  }
}

async function startInexDrop() {
  try {
    const res = await invokeTauri('start_inex_drop');
    if (res) {
      dropActive = true;
      dropConnected = false;
      dropCurrentUrl = res.url || '';
      refreshDropUI();
    }
  } catch (err) {
    showToast('lock', 'Could not start Inex Drop: ' + err);
  }
}

async function stopInexDrop() {
  try {
    await invokeTauri('stop_inex_drop');
    dropActive = false;
    dropConnected = false;
    refreshDropUI();
  } catch (_) {}
}

async function toggleInexDrop() {
  if (dropActive) {
    await stopInexDrop();
  } else {
    await startInexDrop();
    openDropView();
  }
}

// Bind Inex Drop Events from Rust
onTauriEvent('inexdrop-event', (event) => {
  let p = event.payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (_) {}
  }
  if (!p || typeof p !== 'object') return;

  if (p.type === 'tick') {
    const cdBadge = document.getElementById('drop-countdown-badge');
    if (cdBadge) {
      const rem = p.remaining || 0;
      cdBadge.textContent = `00:${rem < 10 ? '0' : ''}${rem}`;
    }
    const subEl = document.getElementById('tile-drop-sub');
    if (subEl && dropActive && !dropConnected) {
      subEl.textContent = `Waiting (${p.remaining}s)`;
    }
  } else if (p.type === 'timeout') {
    dropActive = false;
    dropConnected = false;
    refreshDropUI();
    if (appState.currentView === 'view-inexdrop') {
      goCompact();
    }
  } else if (p.type === 'connected') {
    dropActive = true;
    dropConnected = true;
    const PHONE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';
    if (typeof showDeviceHud === 'function') {
      showDeviceHud({
        iconHTML: PHONE_SVG,
        plain: true,
        name: p.device || 'Android Phone',
        tag: 'Connected',
        accent: 'green',
        ms: 2800
      });
    } else {
      showToast('phone', `Connected to ${p.device || 'Phone'}!`, 2000);
    }
    refreshDropUI();
  } else if (p.type === 'disconnected') {
    dropConnected = false;
    clearPrompt();
    const UNPHONE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
    if (typeof showDeviceHud === 'function') {
      showDeviceHud({
        iconHTML: UNPHONE_SVG,
        plain: true,
        name: p.device || 'Phone',
        tag: 'Disconnected',
        accent: 'red',
        ms: 2200
      });
    } else {
      showToast('unphone', 'Phone disconnected', 1800);
    }
    refreshDropUI();
  } else if (p.type === 'stopped') {
    dropActive = false;
    dropConnected = false;
    clearPrompt();
    const rxBox = document.getElementById('drop-rx-progress');
    if (rxBox) rxBox.classList.add('hidden');
    if (typeof finishCompactTransferUI === 'function') {
      finishCompactTransferUI();
    }
    refreshDropUI();
  } else if (p.type === 'transfer_prompt') {
    // one request per file; a request that arrives while another is open waits its turn
    if (currentPromptId && currentPromptId !== p.id) {
      if (!promptQueue.some((q) => q.id === p.id)) promptQueue.push(p);
    } else {
      activatePrompt(p);
    }
  } else if (p.type === 'upload_cancelled') {
    const rxBox = document.getElementById('drop-rx-progress');
    if (rxBox) rxBox.classList.add('hidden');
    if (typeof finishCompactTransferUI === 'function') {
      finishCompactTransferUI();
    }
    showToast('unphone', 'Transfer cancelled', 1800);
  } else if (p.type === 'upload_start') {
    const rxBox = document.getElementById('drop-rx-progress');
    const rxName = document.getElementById('drop-rx-name');
    const rxPct = document.getElementById('drop-rx-pct');
    const rxBar = document.getElementById('drop-rx-bar');
    if (rxBox) rxBox.classList.remove('hidden');
    if (rxName) rxName.textContent = `Receiving ${p.name || 'File'}`;
    if (rxPct) rxPct.textContent = '0%';
    if (rxBar) rxBar.style.width = '0%';

    // Island compact transfer morph animation
    if (typeof startCompactTransferUI === 'function') {
      appState.xferDir = 'recv';
      startCompactTransferUI();
    }
  } else if (p.type === 'progress') {
    const rxPct = document.getElementById('drop-rx-pct');
    const rxBar = document.getElementById('drop-rx-bar');
    if (rxPct) rxPct.textContent = p.speed ? `${p.speed} • ${p.pct}%` : `${p.pct}%`;
    if (rxBar) rxBar.style.width = `${p.pct}%`;

    if (typeof updateCompactTransferPct === 'function') {
      updateCompactTransferPct(p.pct, p.speed);
    }
  } else if (p.type === 'upload_done') {
    closePromptHud();
    const rxPct = document.getElementById('drop-rx-pct');
    const rxBar = document.getElementById('drop-rx-bar');
    const rxBox = document.getElementById('drop-rx-progress');
    if (rxPct) rxPct.textContent = p.speed ? `100% • ${p.speed}` : '100%';
    if (rxBar) rxBar.style.width = '100%';

    if (typeof finishCompactTransferUI === 'function') {
      finishCompactTransferUI();
    }

    const dlDoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
    if (typeof showDeviceHud === 'function') {
      showDeviceHud({
        iconHTML: dlDoneSvg,
        plain: true,
        accent: 'ok',
        name: p.name || 'File received',
        tag: p.speed ? `Saved to Downloads • ${p.speed}` : 'Saved to Downloads',
        ms: 3500
      });
    }

    // Files from the phone only land in Downloads: no clipboard copy, nothing is added to the tray.

    setTimeout(() => {
      if (rxBox) rxBox.classList.add('hidden');
    }, 2500);
  } else if (p.type === 'download_start') {
    // PC -> phone: same island animation as receiving, arrow pointing up ("Sending")
    dlActiveCount++;
    if (dlActiveCount === 1 && typeof startCompactTransferUI === 'function') {
      appState.xferDir = 'send';
      startCompactTransferUI();
    }
  } else if (p.type === 'download_progress') {
    if (typeof updateCompactTransferPct === 'function') updateCompactTransferPct(p.pct, p.speed);
  } else if (p.type === 'download_cancelled') {
    dlActiveCount = Math.max(0, dlActiveCount - 1);
    if (dlActiveCount === 0 && typeof finishCompactTransferUI === 'function') finishCompactTransferUI();
  } else if (p.type === 'pushed_file_downloaded') {
    dlActiveCount = Math.max(0, dlActiveCount - 1);
    if (dlActiveCount === 0 && typeof finishCompactTransferUI === 'function') finishCompactTransferUI();
    const sentSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
    if (typeof showDeviceHud === 'function') {
      showDeviceHud({
        iconHTML: sentSvg,
        plain: true,
        accent: 'ok',
        name: p.name || 'File sent',
        tag: 'Sent to Phone',
        ms: 3000
      });
    }
  }
});

// UI Event Listeners
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

  const btnStart = document.getElementById('btn-drop-start');
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      startInexDrop();
    });
  }

  const btnDisc = document.getElementById('btn-drop-disconnect');
  if (btnDisc) {
    btnDisc.addEventListener('click', () => {
      stopInexDrop();
    });
  }

  const btnCopy = document.getElementById('btn-copy-drop-url');
  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      if (dropCurrentUrl) {
        navigator.clipboard.writeText(dropCurrentUrl).then(() => {
          showToast('done', 'Link copied to clipboard!', 1400);
        });
      }
    });
  }

  const btnPush = document.getElementById('btn-drop-push');
  if (btnPush) {
    btnPush.addEventListener('click', async () => {
      if (!appState.trayFiles || appState.trayFiles.length === 0) {
        showToast('info', 'Drop files into Tray first');
        return;
      }
      const n = await stageTrayFilesForPhone();
      showToast('phone', `${n} file${n === 1 ? '' : 's'} pushed to Phone! (Expires in 1 min)`, 2500);
    });
  }

  // Accept / Decline handlers (both Compact HUD and Subview)
  document.getElementById('btn-hud-accept')?.addEventListener('click', (e) => {
    e.stopPropagation();
    acceptTransferPrompt();
  });
  document.getElementById('btn-hud-decline')?.addEventListener('click', (e) => {
    e.stopPropagation();
    declineTransferPrompt();
  });

  document.getElementById('btn-prompt-accept')?.addEventListener('click', async () => {
    acceptTransferPrompt();
  });
  document.getElementById('btn-prompt-decline')?.addEventListener('click', async () => {
    declineTransferPrompt();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInexDrop);
} else {
  initInexDrop();
}
