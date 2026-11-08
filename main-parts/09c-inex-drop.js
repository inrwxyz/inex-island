// ======================================================================================
// Inex Drop: Native offline local file sharing between Phone and PC (Wi-Fi / Hotspot)
// ======================================================================================

let dropActive = false;
let dropConnected = false;
let dropCurrentUrl = '';
let currentPromptId = null;

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
    const urlTxt = document.getElementById('drop-url-text');
    if (urlTxt) urlTxt.textContent = dropCurrentUrl;
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
    showToast('phone', `Connected to ${p.device || 'Phone'}!`, 2000);
    refreshDropUI();
  } else if (p.type === 'disconnected') {
    dropConnected = false;
    showToast('unphone', 'Phone disconnected', 1800);
    refreshDropUI();
  } else if (p.type === 'stopped') {
    dropActive = false;
    dropConnected = false;
    const rxBox = document.getElementById('drop-rx-progress');
    if (rxBox) rxBox.classList.add('hidden');
    if (typeof finishCompactTransferUI === 'function') {
      finishCompactTransferUI();
    }
    refreshDropUI();
  } else if (p.type === 'transfer_prompt') {
    currentPromptId = p.id;
    openDropView();
    const boxPrompt = document.getElementById('drop-state-prompt');
    const boxWait = document.getElementById('drop-state-waiting');
    const boxConn = document.getElementById('drop-state-connected');
    const boxIdle = document.getElementById('drop-state-idle');
    if (boxIdle) boxIdle.classList.add('hidden');
    if (boxWait) boxWait.classList.add('hidden');
    if (boxConn) boxConn.classList.add('hidden');
    if (boxPrompt) {
      boxPrompt.classList.remove('hidden');
      const devEl = document.getElementById('prompt-sender-name');
      const fileEl = document.getElementById('prompt-file-name');
      const sizeEl = document.getElementById('prompt-file-size');
      if (devEl) devEl.textContent = p.device || 'Phone';
      if (fileEl) fileEl.textContent = p.name || 'File';
      if (sizeEl) {
        const mb = (p.size / (1024 * 1024)).toFixed(1);
        sizeEl.textContent = `${mb} MB`;
      }
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

    setTimeout(() => {
      if (rxBox) rxBox.classList.add('hidden');
    }, 2500);
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
      showToast('done', 'Files pushed to Phone!', 1800);
    });
  }

  // Accept / Decline handlers
  document.getElementById('btn-prompt-accept')?.addEventListener('click', async () => {
    if (currentPromptId) {
      await invokeTauri('respond_inex_transfer', { id: currentPromptId, accept: true });
      document.getElementById('drop-state-prompt')?.classList.add('hidden');
      document.getElementById('drop-state-connected')?.classList.remove('hidden');
    }
  });
  document.getElementById('btn-prompt-decline')?.addEventListener('click', async () => {
    if (currentPromptId) {
      await invokeTauri('respond_inex_transfer', { id: currentPromptId, accept: false });
      document.getElementById('drop-state-prompt')?.classList.add('hidden');
      document.getElementById('drop-state-connected')?.classList.remove('hidden');
      showToast('unphone', 'Transfer declined', 1800);
    }
  });

  // Browser vs App tab toggle
  document.getElementById('btn-drop-mode-web')?.addEventListener('click', () => {
    document.getElementById('btn-drop-mode-web')?.classList.add('active');
    document.getElementById('btn-drop-mode-app')?.classList.remove('active');
    const hint = document.getElementById('drop-qr-hint');
    if (hint) hint.textContent = 'Scan with phone camera to connect';
    document.getElementById('drop-url-row')?.classList.remove('hidden');
    document.getElementById('drop-app-row')?.classList.add('hidden');
    renderDropQR(dropCurrentUrl);
  });
  document.getElementById('btn-drop-mode-app')?.addEventListener('click', () => {
    document.getElementById('btn-drop-mode-app')?.classList.add('active');
    document.getElementById('btn-drop-mode-web')?.classList.remove('active');
    const hint = document.getElementById('drop-qr-hint');
    if (hint) hint.textContent = 'Scan with Inex Drop App to connect';
    document.getElementById('drop-app-row')?.classList.remove('hidden');
    renderDropQR(dropCurrentUrl);
  });

  document.getElementById('btn-copy-apk-url')?.addEventListener('click', () => {
    if (dropCurrentUrl) {
      try {
        const u = new URL(dropCurrentUrl);
        const apkUrl = `${u.protocol}//${u.host}/inex-drop.apk`;
        navigator.clipboard.writeText(apkUrl).then(() => {
          showToast('done', 'APK download link copied!', 1500);
        });
      } catch (_) {}
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInexDrop);
} else {
  initInexDrop();
}
