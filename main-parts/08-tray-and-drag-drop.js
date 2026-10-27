// 7. File Drag & Drop -> Tray (native Tauri drop: real file paths, no copy, no RAM use)
let trayIdSeq = 1;

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Files dropped from Explorer: Tauri's native drop hands over the REAL path. Nothing is copied,
// nothing is read into RAM or the clipboard; the tray only remembers {path, name, size}.
// Dragging out and P2P sending both read straight from that original location.
async function addDroppedPaths(paths) {
  const metas = (await tryInvoke('file_info', { paths })) || [];
  let added = 0;
  for (const m of metas) {
    if (appState.trayFiles.some((t) => t.path === m.path)) continue;
    appState.trayFiles.push({ id: trayIdSeq++, name: m.name, size: m.size, path: m.path });
    added++;
  }
  if (!added && !metas.length) { goCompact(); return; } // folders / unreadable items are skipped
  updateTrayUI();
  openTrayView();
}

let dropLeaveTimeout = null;

function onNativeDrop(p) {
  if (!p) return;
  if (p.type === 'enter' || p.type === 'over') {
    clearTimeout(dropLeaveTimeout);
    if (!appState.draggingOut && appState.currentView !== 'view-drop') {
      switchView('view-drop', 'state-drop', 200, 92);
    }
  } else if (p.type === 'leave') {
    clearTimeout(dropLeaveTimeout);
    dropLeaveTimeout = setTimeout(() => {
      if (!appState.draggingOut && appState.currentView === 'view-drop') {
        goCompact();
      }
    }, 200);
  } else if (p.type === 'drop') {
    clearTimeout(dropLeaveTimeout);
    if (appState.draggingOut) { appState.draggingOut = false; goCompact(); return; }
    if (p.paths && p.paths.length) addDroppedPaths(p.paths); else goCompact();
  }
}

(function bindNativeDrop() {
  // Hook native OLE drop target on main window and all WebView2 child windows
  const registerDrop = () => {
    invokeTauri('setup_shelf_drop').catch((e) => console.warn('[drop] setup_shelf_drop:', e));
  };
  registerDrop();
  setTimeout(registerDrop, 1000);
  setTimeout(registerDrop, 3000);

  // Native OLE shelf events from shelf.rs
  onTauriEvent('shelf-drag-enter', (e) => {
    const paths = e && e.payload && e.payload.paths;
    onNativeDrop({ type: 'enter', paths });
  });
  onTauriEvent('shelf-drag-leave', () => {
    onNativeDrop({ type: 'leave' });
  });
  onTauriEvent('shelf-drag-drop', (e) => {
    const paths = e && e.payload && e.payload.paths;
    onNativeDrop({ type: 'drop', paths });
  });

  // Tauri 2 standard drag-drop handler on webviewWindow / window / webview
  const bindTauriHandler = (w) => {
    if (!w || !w.onDragDropEvent) return false;
    try {
      const r = w.onDragDropEvent((e) => {
        const payload = e && e.payload;
        if (!payload) return;
        if (payload.type === 'enter' || payload.type === 'over') {
          onNativeDrop({ type: 'enter', paths: payload.paths });
        } else if (payload.type === 'leave') {
          onNativeDrop({ type: 'leave' });
        } else if (payload.type === 'drop') {
          onNativeDrop({ type: 'drop', paths: payload.paths });
        }
      });
      if (r && r.catch) r.catch(() => {});
      return true;
    } catch (_) { return false; }
  };

  const tw = window.__TAURI__;
  if (tw) {
    bindTauriHandler(tw.webviewWindow?.getCurrentWebviewWindow?.());
    bindTauriHandler(tw.window?.getCurrentWindow?.());
    bindTauriHandler(tw.webview?.getCurrentWebview?.());
  }

  // Plain Tauri events fallback
  onTauriEvent('tauri://drag-enter', (e) => onNativeDrop({ type: 'enter', paths: e?.payload?.paths }));
  onTauriEvent('tauri://drag-over', (e) => onNativeDrop({ type: 'over', paths: e?.payload?.paths }));
  onTauriEvent('tauri://drag-leave', () => onNativeDrop({ type: 'leave' }));
  onTauriEvent('tauri://drag-drop', (e) => onNativeDrop({ type: 'drop', paths: e?.payload?.paths }));

  // HTML5 drag/drop events on window
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    onNativeDrop({ type: 'enter' });
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    onNativeDrop({ type: 'over' });
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) onNativeDrop({ type: 'leave' });
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [];
    if (e.dataTransfer && e.dataTransfer.files) {
      for (const f of e.dataTransfer.files) {
        if (f.path) paths.push(f.path);
      }
    }
    if (paths.length) onNativeDrop({ type: 'drop', paths });
  });
})();

function openTrayView() {
  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  if (appState.traySelectedIds.size === 0 && appState.trayFiles.length > 0) {
    appState.trayFiles.forEach((f) => appState.traySelectedIds.add(f.id));
  }
  appState.traySelect = null;
  island.classList.remove('picker-open');
  document.getElementById('tray-peer-picker').classList.add('hidden');
  updateTrayUI();
  switchView('view-tray', 'state-tray', 316, 218);
}

// Drag a tray card out of the island (to Desktop / Explorer / Discord ...) with a native file drag
async function startDragOut(f) {
  appState.draggingOut = true;
  try {
    if (f.path) await invokeTauri('drag_out_file', { path: f.path }); // the original file, no copy
  } catch (_) {}
  setTimeout(() => { appState.draggingOut = false; }, 400);
}

function updateTrayUI() {
  const count = appState.trayFiles.length;
  document.getElementById('c-tray-count').textContent = count;
  document.getElementById('tray-total-badge').textContent = count;
  document.getElementById('tile-tray-sub').textContent = `${count} File${count === 1 ? '' : 's'}`;
  document.getElementById('tray-cap').textContent = count > 0 ? `${count} file${count > 1 ? 's' : ''}` : '';
  document.getElementById('tile-tray').classList.toggle('active', count > 0);
  document.getElementById('c-tray-btn').classList.toggle('hidden', count === 0);
  updateCompactStateClasses();

  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  // Clean up IDs of files that were removed
  const existingIds = new Set(appState.trayFiles.map((f) => f.id));
  for (const id of Array.from(appState.traySelectedIds)) {
    if (!existingIds.has(id)) appState.traySelectedIds.delete(id);
  }
  if (appState.traySelectedIds.size === 0 && count > 0) {
    appState.trayFiles.forEach((f) => appState.traySelectedIds.add(f.id));
  }

  const sel = appState.traySelect;
  const list = document.getElementById('tray-files-list');
  list.innerHTML = '';
  if (count === 0) {
    list.innerHTML = `<div class="empty-hint" style="width:100%;">Drop files onto Island to add</div>`;
    return;
  }

  appState.trayFiles.forEach((f) => {
    const isPicked = appState.traySelectedIds.has(f.id);
    const card = document.createElement('div');
    card.className = 'tray-file-card' + (isPicked ? ' sel' : '');
    card.title = `${f.name} (Click to ${isPicked ? 'deselect' : 'select'})`;
    card.innerHTML = `
      <span class="f-check">✓</span>
      <button class="f-del" title="Remove file">×</button>
      <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
      <div class="f-name">${escHtml(f.name)}</div>
    `;
    card.querySelector('.f-del').addEventListener('click', (e) => {
      e.stopPropagation();
      appState.trayFiles = appState.trayFiles.filter((t) => t.id !== f.id);
      appState.traySelectedIds.delete(f.id);
      if (sel) sel.picked.delete(f.id);
      updateTrayUI();
      if (appState.currentView === 'view-tray' && !document.getElementById('tray-peer-picker').classList.contains('hidden')) {
        renderPeerPicker();
      }
    });

    // press + move = drag the file out; click = toggle selection for sending
    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.f-del')) return;
      const sx = e.clientX, sy = e.clientY;
      let dragged = false;
      const cleanup = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      const move = (ev) => {
        if (dragged) return;
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) {
          dragged = true;
          cleanup();
          startDragOut(f);
        }
      };
      const up = () => {
        cleanup();
        if (!dragged) {
          // Toggle selection
          if (appState.traySelectedIds.has(f.id)) {
            appState.traySelectedIds.delete(f.id);
          } else {
            appState.traySelectedIds.add(f.id);
          }
          const nowPicked = appState.traySelectedIds.has(f.id);
          card.classList.toggle('sel', nowPicked);
          card.title = `${f.name} (Click to ${nowPicked ? 'deselect' : 'select'})`;
          if (appState.traySelect) {
            if (nowPicked) appState.traySelect.picked.add(f.id);
            else appState.traySelect.picked.delete(f.id);
          }
          renderPeerPicker();
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    list.appendChild(card);
  });
}

// Mouse wheel scrolls the tray sideways, so every file can be reached
const scrollTrayList = (e) => {
  const l = document.getElementById('tray-files-list');
  if (!l || l.scrollWidth <= l.clientWidth) return;
  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  l.scrollLeft += (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) * Math.abs(delta);
  e.preventDefault();
};
document.getElementById('tray-files-list').addEventListener('wheel', scrollTrayList, { passive: false });
document.getElementById('view-tray').addEventListener('wheel', (e) => {
  if (e.target.closest('#tray-peer-picker') || e.target.closest('.tray-share-actions')) return;
  scrollTrayList(e);
}, { passive: false });

document.getElementById('btn-clear-tray').addEventListener('click', () => {
  appState.trayFiles = [];
  appState.traySelect = null;
  if (appState.traySelectedIds) appState.traySelectedIds.clear();
  document.getElementById('tray-peer-picker').classList.add('hidden');
  updateTrayUI();
});

document.getElementById('btn-tray-quickshare').addEventListener('click', async () => {
  goCompact();
  await invokeTauri('launch_quick_share');
});

function makeChip(text, onClick) {
  const chip = document.createElement('button');
  chip.className = 'peer-chip';
  chip.textContent = text;
  chip.addEventListener('click', onClick);
  return chip;
}

function renderPeerPicker() {
  const picker = document.getElementById('tray-peer-picker');
  const label = picker.querySelector('small');
  const box = document.getElementById('tray-peer-buttons');
  box.innerHTML = '';
  
  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  const selectedCount = appState.traySelectedIds.size;
  label.textContent = `Send ${selectedCount || appState.trayFiles.length} file${(selectedCount || appState.trayFiles.length) === 1 ? '' : 's'} to:`;

  if (appState.peers.length === 0) {
    box.appendChild(makeChip('Connect device in P2P...', () => {
      island.classList.remove('picker-open');
      picker.classList.add('hidden');
      switchView('view-p2p', 'state-sub', 316, 208);
    }));
  } else {
    // If more than 1 peer is connected, add a "Send to All" option
    if (appState.peers.length > 1) {
      box.appendChild(makeChip(`🌐 Send to All (${appState.peers.length})`, () => {
        let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds.has(f.id));
        if (toSend.length === 0 && appState.trayFiles.length > 0) toSend = [...appState.trayFiles];
        if (toSend.length > 0) {
          island.classList.remove('picker-open');
          picker.classList.add('hidden');
          appState.peers.forEach((p) => offerFilesToPeer(p.id, toSend));
          goCompact();
          updateTrayUI();
        }
      }));
    }
    appState.peers.forEach((peer) => {
      box.appendChild(makeChip(`🖥️ ${peer.name}`, () => {
        let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds.has(f.id));
        if (toSend.length === 0 && appState.trayFiles.length > 0) {
          toSend = [...appState.trayFiles];
        }
        if (toSend.length > 0) {
          island.classList.remove('picker-open');
          picker.classList.add('hidden');
          sendTrayFiles(peer.id, toSend);
        }
      }));
    });
  }
  picker.classList.remove('hidden');
}

document.getElementById('btn-tray-p2p').addEventListener('click', () => {
  let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds && appState.traySelectedIds.has(f.id));
  if (toSend.length === 0 && appState.trayFiles.length > 0) {
    toSend = [...appState.trayFiles];
  }
  if (toSend.length === 0) {
    showToast('info', 'Drop files into tray first');
    return;
  }
  const picker = document.getElementById('tray-peer-picker');
  if (picker && !picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    island.classList.remove('picker-open');
    invokeTauri('resize_island', { width: 316, height: 218 });
    return;
  }
  appState.traySelect = null;
  renderPeerPicker();
  island.classList.add('picker-open');
  invokeTauri('resize_island', { width: 316, height: 252 });
});

function sendTrayFiles(peerId, files) {
  appState.traySelect = null;
  goCompact();
  offerFilesToPeer(peerId, files);
  updateTrayUI();
}


