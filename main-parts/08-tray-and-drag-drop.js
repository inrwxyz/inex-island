// 7. File Drag & Drop -> Tray (native Tauri drop: real file paths, no copy, no RAM use)
let trayIdSeq = 1;

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Files dropped from Explorer: Tauri's native drop hands over the REAL path. Nothing is copied,
// nothing is read into RAM or the clipboard; the tray only remembers {path, name, size}.
// Dragging out and P2P sending both read straight from that original location.
async function addDroppedPaths(paths, target) {
  const metas = (await tryInvoke('file_info', { paths })) || [];
  let added = 0;
  for (const m of metas) {
    if (appState.trayFiles.some((t) => t.path === m.path)) continue;
    appState.trayFiles.push({ id: trayIdSeq++, name: m.name, size: m.size, path: m.path });
    added++;
  }
  if (!added && !metas.length) { goCompact(); return; } // folders / unreadable items are skipped
  updateTrayUI();
  if (isMacMenu()) {
    if (target === 'drop') macSendToInexDrop(); else openMacTrayView(false);
    return;
  }
  openTrayView();
}

// Only the files ticked in the tray go to the phone (nothing ticked = all of them, like P2P)
function getSelectedTrayFiles() {
  const all = appState.trayFiles || [];
  const picked = all.filter((f) => appState.traySelectedIds && appState.traySelectedIds.has(f.id));
  return picked.length ? picked : [...all];
}

async function stageTrayFilesForPhone() {
  const files = getSelectedTrayFiles().filter((f) => f.path);
  await invokeTauri('clear_staged_files');      // whatever was pushed before must not tag along
  for (const f of files) await invokeTauri('stage_file_for_phone', { path: f.path });
  return files.length;
}

let dropLeaveTimeout = null;

function onNativeDrop(p) {
  if (!p) return;
  if (isMacMenu()) { onNativeDropMac(p); return; }
  if (p.type === 'enter' || p.type === 'over') {
    clearTimeout(dropLeaveTimeout);
    if (!appState.draggingOut && appState.currentView !== 'view-drop') {
      switchView('view-drop', 'state-drop', ISLAND_WIN_W, 92);
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

// ---------- Mac menu mode: tray + Inex Drop open as a two-panel view (Inex Drop | Drop files here) ----------
function isMacMenu() { return !!(SET.appearance && SET.appearance.menuLayout === 'mac'); }
const MAC_TRAY_H = 172;

// which panel is under the mouse (position = client px from the native drag events)
function macDropTargetAt(pos) {
  if (!pos || typeof pos.x !== 'number') return null;
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
  const panel = el && el.closest ? el.closest('#view-tray-mac [data-drop-target]') : null;
  return panel ? panel.dataset.dropTarget : null;
}

function setMacDropHover(t) {
  appState.macDropTarget = t;
  document.querySelectorAll('#view-tray-mac [data-drop-target]').forEach((el) => {
    el.classList.toggle('over', el.dataset.dropTarget === t);
  });
  const sub = document.getElementById('mt-drop-sub');
  if (sub) sub.textContent = t === 'drop' ? 'Release to send' : 'Send to phone';
}

// Tray opened from the Control Deck: the tray (Inex Drop | Drop files here) fills the WHOLE body, only the top strip
// (clock, weather, icons) stays. The Tray icon in the strip toggles it. No resize, no animation.
// (functions + var on purpose: switchView can run before this part has executed)
var macTrayHome = null;
function macTrayPaneOpen() { return !!macTrayHome; }

function openMacTrayPane() {
  const deck = document.getElementById('view-control-mac');
  const tray = document.getElementById('view-tray-mac');
  if (!deck || !tray) return;
  if (macTrayHome) { renderMacTray(); return; }
  if (typeof closeMacSub === 'function') closeMacSub();
  macTrayHome = { parent: tray.parentNode, next: tray.nextSibling };
  deck.appendChild(tray);
  tray.classList.add('active', 'in-mac-tray');
  tray.classList.remove('dragging');
  deck.classList.add('tray-open');
  document.getElementById('mac-tray-btn')?.classList.add('on');
  renderMacTray();
  setMacDropHover(null);
}

function closeMacTrayPane() {
  if (!macTrayHome) return;
  const tray = document.getElementById('view-tray-mac');
  if (tray) {
    tray.classList.remove('active', 'in-mac-tray', 'dragging');
    macTrayHome.parent.insertBefore(tray, macTrayHome.next);
  }
  macTrayHome = null;
  document.getElementById('view-control-mac')?.classList.remove('tray-open');
  document.getElementById('mac-tray-btn')?.classList.remove('on');
}

function openMacTrayView(byDrag) {
  appState.macTrayByDrag = !!byDrag;
  if (!byDrag) {                       // Tray icon / after a drop: inside the Control Deck
    if (appState.currentView !== 'view-control-mac') openControlMenu();
    openMacTrayPane();
    return;
  }
  renderMacTray();
  switchView('view-tray-mac', 'state-tray-mac', ISLAND_WIN_W, MAC_TRAY_H);
  document.getElementById('view-tray-mac')?.classList.toggle('dragging', !!byDrag);
  setMacDropHover(null);
}

function renderMacTray() {
  const files = appState.trayFiles || [];
  const empty = document.getElementById('mt-empty');
  const filled = document.getElementById('mt-filled');
  if (!empty || !filled) return;
  empty.classList.toggle('hidden', files.length > 0);
  filled.classList.toggle('hidden', files.length === 0);
  document.getElementById('mt-count').textContent = `Tray · ${files.length} file${files.length === 1 ? '' : 's'}`;
  const list = document.getElementById('mt-files');
  list.innerHTML = '';
  files.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'mt-file';
    card.title = f.name;
    card.innerHTML = `
      <button class="mt-del" title="Remove file">×</button>
      <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
      <div class="mt-fname">${escHtml(f.name)}</div>`;
    card.querySelector('.mt-del').addEventListener('click', (e) => {
      e.stopPropagation();
      appState.trayFiles = appState.trayFiles.filter((t) => t.id !== f.id);
      if (appState.traySelectedIds) appState.traySelectedIds.delete(f.id);
      updateTrayUI();
    });
    // press + move = drag the file out
    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.mt-del')) return;
      const sx = e.clientX, sy = e.clientY;
      const cleanup = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', cleanup); };
      const move = (ev) => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) { cleanup(); startDragOut(f); }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', cleanup);
    });
    list.appendChild(card);
  });
}

// Dropped / sent to Inex Drop in the Mac menu: whatever mode the side switch has selected is used.
//  Quick Share -> turns on by itself (files are staged for the phone)
//  P2P         -> NO code is generated for you; with a connected peer the files are offered to it, otherwise the
//                 P2P panel opens and you press Generate yourself
async function macSendToInexDrop() {
  const files = appState.trayFiles || [];
  if (getDropMode() === 'p2p') {
    if (files.length && (appState.peers || []).length > 0) {
      appState.peers.forEach((p) => offerFilesToPeer(p.id, [...files]));
    } else if (files.length) {
      showToast('info', 'Press Generate, connect a peer, then send', 2200);
    }
    openMacDrop('p2p');
    return;
  }
  if (files.length > 0) await stageTrayFilesForPhone();
  if (!dropActive) await startInexDrop();
  openMacDrop('qs');
}

function onNativeDropMac(p) {
  if (p.type === 'enter' || p.type === 'over') {
    clearTimeout(dropLeaveTimeout);
    if (appState.draggingOut) return;
    if (macTrayPaneOpen() || appState.currentView === 'view-tray-mac') document.getElementById('view-tray-mac').classList.add('dragging');
    else openMacTrayView(true);
    if (p.position) setMacDropHover(macDropTargetAt(p.position));
  } else if (p.type === 'leave') {
    clearTimeout(dropLeaveTimeout);
    dropLeaveTimeout = setTimeout(() => {
      const inPane = macTrayPaneOpen();
      if (appState.draggingOut || (!inPane && appState.currentView !== 'view-tray-mac')) return;
      setMacDropHover(null);
      document.getElementById('view-tray-mac').classList.remove('dragging');
      if (!inPane && appState.macTrayByDrag) goCompact();   // opened only by the drag: close again. Opened by the Tray icon: stay.
    }, 200);
  } else if (p.type === 'drop') {
    clearTimeout(dropLeaveTimeout);
    if (appState.draggingOut) { appState.draggingOut = false; goCompact(); return; }
    const target = (p.position && macDropTargetAt(p.position)) || appState.macDropTarget || 'tray';
    setMacDropHover(null);
    document.getElementById('view-tray-mac')?.classList.remove('dragging');
    appState.macTrayByDrag = false;
    if (p.paths && p.paths.length) addDroppedPaths(p.paths, target); else goCompact();
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
    onNativeDrop({ type: 'enter', paths, position: e && e.payload && e.payload.position });
  });
  onTauriEvent('shelf-drag-over', (e) => {
    onNativeDrop({ type: 'over', position: e && e.payload && e.payload.position });
  });
  onTauriEvent('shelf-drag-leave', () => {
    onNativeDrop({ type: 'leave' });
  });
  onTauriEvent('shelf-drag-drop', (e) => {
    const paths = e && e.payload && e.payload.paths;
    onNativeDrop({ type: 'drop', paths, position: e && e.payload && e.payload.position });
  });

  // Tauri 2 standard drag-drop handler on webviewWindow / window / webview
  const bindTauriHandler = (w) => {
    if (!w || !w.onDragDropEvent) return false;
    try {
      const r = w.onDragDropEvent((e) => {
        const payload = e && e.payload;
        if (!payload) return;
        if (payload.type === 'enter' || payload.type === 'over') {
          onNativeDrop({ type: 'enter', paths: payload.paths, position: payload.position });
        } else if (payload.type === 'leave') {
          onNativeDrop({ type: 'leave' });
        } else if (payload.type === 'drop') {
          onNativeDrop({ type: 'drop', paths: payload.paths, position: payload.position });
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
  onTauriEvent('tauri://drag-enter', (e) => onNativeDrop({ type: 'enter', paths: e?.payload?.paths, position: e?.payload?.position }));
  onTauriEvent('tauri://drag-over', (e) => onNativeDrop({ type: 'over', paths: e?.payload?.paths, position: e?.payload?.position }));
  onTauriEvent('tauri://drag-leave', () => onNativeDrop({ type: 'leave' }));
  onTauriEvent('tauri://drag-drop', (e) => onNativeDrop({ type: 'drop', paths: e?.payload?.paths, position: e?.payload?.position }));

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
  if (isMacMenu()) { openMacTrayView(false); return; }
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
  const macTrayBadge = document.getElementById('mac-tray-badge');
  if (macTrayBadge) { macTrayBadge.textContent = count; macTrayBadge.classList.toggle('hidden', count === 0); }
  document.getElementById('mac-tray-btn')?.setAttribute('title', `File Tray (${count} File${count === 1 ? '' : 's'})`);
  document.getElementById('c-tray-btn').classList.toggle('hidden', count === 0);
  if (typeof renderMacTray === 'function') renderMacTray();
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

document.getElementById('mt-clear')?.addEventListener('click', () => {
  appState.trayFiles = [];
  if (appState.traySelectedIds) appState.traySelectedIds.clear();
  updateTrayUI();
});

// Left panel of the Mac tray view = Inex Drop
document.getElementById('mt-drop')?.addEventListener('click', () => macSendToInexDrop());

document.getElementById('btn-clear-tray').addEventListener('click', () => {
  appState.trayFiles = [];
  appState.traySelect = null;
  if (appState.traySelectedIds) appState.traySelectedIds.clear();
  document.getElementById('tray-peer-picker').classList.add('hidden');
  updateTrayUI();
});

// The tray has ONE share button. What it does depends on the mode selected inside Inex Drop.
document.getElementById('btn-tray-inexdrop')?.addEventListener('click', async () => {
  if (getDropMode() === 'p2p') { trayP2PShare(); return; }
  if (appState.trayFiles && appState.trayFiles.length > 0) {
    await stageTrayFilesForPhone();
  }
  if (typeof openDropView === 'function') openDropView();
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
      openP2PView();
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

function trayP2PShare() {
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
    reportIslandSize({ width: ISLAND_WIN_W, height: 218 });
    return;
  }
  appState.traySelect = null;
  renderPeerPicker();
  island.classList.add('picker-open');
  reportIslandSize({ width: ISLAND_WIN_W, height: 252 });
}

function sendTrayFiles(peerId, files) {
  appState.traySelect = null;
  goCompact();
  offerFilesToPeer(peerId, files);
  updateTrayUI();
}


