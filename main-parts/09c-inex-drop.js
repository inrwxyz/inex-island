// ======================================================================================
// Inex Drop: Native offline local file sharing between Phone and PC (Wi-Fi / Hotspot)
// ======================================================================================

let dropActive = false;
let dropConnected = false;
let dropCurrentUrl = '';
let currentPromptId = null;
let promptExpireTimer = null;

function getFileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv'].includes(ext)) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
  }
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(ext)) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><rect x="10" y="8" width="4" height="4" rx="1"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
}

function showPromptHud(id, name, meta, iconSvg) {
  const hud = document.getElementById('c-prompt-hud');
  const ico = document.getElementById('prompt-hud-ico');
  const titleEl = document.getElementById('prompt-hud-title');
  const metaEl = document.getElementById('prompt-hud-meta');
  if (!hud || !ico || !titleEl) return;

  ico.innerHTML = iconSvg;
  titleEl.textContent = name || 'File';
  if (metaEl) metaEl.textContent = meta || '';

  hud.classList.remove('hidden');
  tryInvoke('resize_island', { width: 284, height: 48 });
  island.classList.add('prompt-hud-active');
}

function closePromptHud() {
  const hud = document.getElementById('c-prompt-hud');
  if (hud) hud.classList.add('hidden');
  island.classList.remove('prompt-hud-active');
  if (appState.currentView === 'view-compact' || !appState.currentView) {
    goCompact();
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
    closePromptHud();
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
    closePromptHud();
    const rxBox = document.getElementById('drop-rx-progress');
    if (rxBox) rxBox.classList.add('hidden');
    if (typeof finishCompactTransferUI === 'function') {
      finishCompactTransferUI();
    }
    refreshDropUI();
  } else if (p.type === 'transfer_prompt') {
    currentPromptId = p.id;
    clearTimeout(promptExpireTimer);
    // 1-minute expiration timer on prompt
    promptExpireTimer = setTimeout(() => {
      if (currentPromptId === p.id) {
        declineTransferPrompt(true);
      }
    }, 60000);

    const mb = (p.size / (1024 * 1024)).toFixed(1);
    const iconSvg = getFileIcon(p.name);

    if (appState.currentView === 'view-inexdrop') {
      const devEl = document.getElementById('prompt-sender-name');
      const fileEl = document.getElementById('prompt-file-name');
      const sizeEl = document.getElementById('prompt-file-size');
      if (devEl) devEl.textContent = p.device || 'Android Phone';
      if (fileEl) fileEl.textContent = p.name || 'File';
      if (sizeEl) sizeEl.textContent = `${mb} MB`;
      refreshDropUI();
    } else {
      // Show Dynamic Island Compact Prompt HUD (Bluetooth banner style!)
      showPromptHud(p.id, p.name, `${mb} MB • ${p.device || 'Android Phone'}`, iconSvg);
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

    // P2P-style: copy path to clipboard and add to File Tray!
    if (p.path) {
      try {
        navigator.clipboard.writeText(p.path);
      } catch (_) {}
      if (typeof addTrayItem === 'function') {
        addTrayItem(p.path);
      } else if (appState.trayFiles && !appState.trayFiles.some(f => f.path === p.path)) {
        appState.trayFiles.unshift({ path: p.path, name: p.name, size: p.size });
        if (typeof renderTrayList === 'function') renderTrayList();
      }
    }

    setTimeout(() => {
      if (rxBox) rxBox.classList.add('hidden');
    }, 2500);
  } else if (p.type === 'pushed_file_downloaded') {
    showToast('done', `${p.name || 'File'} downloaded on Phone!`, 2200);
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
      for (const f of appState.trayFiles) {
        if (f.path) {
          await invokeTauri('stage_file_for_phone', { path: f.path });
        }
      }
      showToast('phone', 'Files pushed to Phone! (Expires in 1 min)', 2500);
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
