// System File Tray & Drag-and-Drop (Native OLE Drop, Explorer Integration, Control Deck Tray View)
import { appState } from '../../core/state.js';
import { loadSettings } from '../../core/settings.js';
import { bus } from '../../core/bus.js';
import { invokeTauri, tryInvoke, listenTauri } from '../../core/tauri.js';
import { goCompact, updateCompactStateClasses, reportIslandSize, ISLAND_WIN_W } from '../../core/views.js';
import {
  p2pNativeDrop,
  getDropMode,
  openDeckDrop,
  offerFilesToPeer,
  startInexDrop,
  dropActive,
  openDropView,
  openP2PView
} from '../file-transfer/index.js';

let trayIdSeq = 1;

export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

export function showTrayToast(icon, title, ms) {
  bus.emit('toast:show', { icon, title, ms });
  if (typeof window.showToast === 'function') {
    try { window.showToast(icon, title, ms); } catch { /* ignore */ }
  }
}

export function isDeckMenu() {
  const SET = loadSettings();
  return !SET.appearance || SET.appearance.menuLayout === 'deck';
}

export const DECK_TRAY_H = 172;

export function deckDropTargetAt(pos) {
  if (!pos || typeof pos.x !== 'number') return null;
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
  const panel = el && el.closest ? el.closest('#view-tray-deck [data-drop-target]') : null;
  return panel ? panel.dataset.dropTarget : null;
}

export function setDeckDropHover(t) {
  appState.deckDropTarget = t;
  document.querySelectorAll('#view-tray-deck [data-drop-target]').forEach((el) => {
    el.classList.toggle('over', el.dataset.dropTarget === t);
  });
  const sub = document.getElementById('mt-drop-sub');
  if (sub) sub.textContent = t === 'drop' ? 'Release to send' : 'Send to phone';
}

let deckTrayHome = null;
export function deckTrayPaneOpen() {
  return !!deckTrayHome;
}

export function openDeckTrayPane() {
  const deck = document.getElementById('view-control-deck');
  const tray = document.getElementById('view-tray-deck');
  if (!deck || !tray) return;
  if (deckTrayHome) {
    renderDeckTray();
    return;
  }
  if (typeof window.closeDeckSub === 'function') window.closeDeckSub();
  bus.emit('prayer:close');
  bus.emit('weather:close-deck');
  deckTrayHome = { parent: tray.parentNode, next: tray.nextSibling };
  deck.appendChild(tray);
  tray.classList.add('active', 'in-deck-tray');
  tray.classList.remove('dragging');
  deck.classList.add('tray-open');
  document.getElementById('deck-tray-btn')?.classList.add('on');
  renderDeckTray();
  setDeckDropHover(null);
}

export function closeDeckTrayPane() {
  if (!deckTrayHome) return;
  const tray = document.getElementById('view-tray-deck');
  if (tray) {
    tray.classList.remove('active', 'in-deck-tray', 'dragging');
    deckTrayHome.parent.insertBefore(tray, deckTrayHome.next);
  }
  deckTrayHome = null;
  document.getElementById('view-control-deck')?.classList.remove('tray-open');
  document.getElementById('deck-tray-btn')?.classList.remove('on');
}

export function openDeckTrayView(byDrag) {
  appState.deckTrayByDrag = !!byDrag;
  if (!byDrag) {
    if (appState.currentView !== 'view-control-deck' && typeof window.openControlMenu === 'function') {
      window.openControlMenu();
    }
    openDeckTrayPane();
    return;
  }
  renderDeckTray();
  if (typeof window.switchView === 'function') {
    window.switchView('view-tray-deck', 'state-tray-deck', ISLAND_WIN_W, DECK_TRAY_H);
  }
  document.getElementById('view-tray-deck')?.classList.toggle('dragging', !!byDrag);
  setDeckDropHover(null);
}

export const MT_KINDS = [
  ['pdf', 'PDF', ['pdf']],
  ['doc', 'DOC', ['doc', 'docx', 'odt', 'rtf', 'txt', 'md']],
  ['xls', 'XLS', ['xls', 'xlsx', 'csv', 'ods']],
  ['ppt', 'PPT', ['ppt', 'pptx', 'odp']],
  ['zip', 'ZIP', ['zip', 'rar', '7z', 'tar', 'gz']],
  ['img', null, ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'ico']],
  ['vid', null, ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv']],
  ['aud', null, ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac']],
  ['code', null, ['js', 'ts', 'py', 'rs', 'html', 'css', 'json', 'xml', 'c', 'cpp', 'java', 'sh']],
  ['app', null, ['exe', 'msi', 'apk', 'dmg', 'bat']]
];

export const MT_ICONS = {
  img: '<path d="M4 5h16v14H4z"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/>',
  vid: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor"/>',
  aud: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  code: '<polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/>',
  app: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>'
};

export function deckTrayKind(name) {
  const m = /\.([^.\\/]+)$/.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  const hit = MT_KINDS.find((k) => k[2].includes(ext));
  const kind = hit ? hit[0] : 'file';
  const label = (hit && hit[1]) || (ext ? ext.slice(0, 4).toUpperCase() : 'FILE');
  return { kind, label };
}

// Type-aware file icon shared by the Classic tray and the Control Deck tray (colour + glyph + extension label).
export function trayFileIconHtml(name) {
  const { kind, label } = deckTrayKind(name);
  const glyph = MT_ICONS[kind] && kind !== 'file' ? `<svg viewBox="0 0 24 24">${MT_ICONS[kind]}</svg>` : '';
  return `<div class="fico k-${kind}">${glyph}<b>${escHtml(label)}</b></div>`;
}

export function renderDeckTray() {
  const files = appState.trayFiles || [];
  const empty = document.getElementById('mt-empty');
  const filled = document.getElementById('mt-filled');
  if (!empty || !filled) return;
  empty.classList.toggle('hidden', files.length > 0);
  filled.classList.toggle('hidden', files.length === 0);
  const mtCount = document.getElementById('mt-count');
  if (mtCount) mtCount.textContent = `Tray \u00B7 ${files.length} file${files.length === 1 ? '' : 's'}`;
  const list = document.getElementById('mt-files');
  if (!list) return;
  list.innerHTML = '';

  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  const liveIds = new Set(files.map((x) => x.id));
  for (const id of Array.from(appState.traySelectedIds)) {
    if (!liveIds.has(id)) appState.traySelectedIds.delete(id);
  }
  if (appState.traySelectedIds.size === 0 && files.length > 0) {
    files.forEach((x) => appState.traySelectedIds.add(x.id));
  }

  files.forEach((f) => {
    const card = document.createElement('div');
    const picked = appState.traySelectedIds.has(f.id);
    card.className = 'mt-file' + (picked ? ' sel' : '');
    card.title = `${f.name} (Click to ${picked ? 'deselect' : 'select'})`;
    card.innerHTML = `
      <span class="mt-check">\u2713</span>
      <button class="mt-del" title="Remove file">\u00D7</button>
      ${trayFileIconHtml(f.name)}
      <div class="mt-fname">${escHtml(f.name)}</div>`;
    card.querySelector('.mt-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.trayFiles = appState.trayFiles.filter((t) => t.id !== f.id);
      if (appState.traySelectedIds) appState.traySelectedIds.delete(f.id);
      updateTrayUI();
    });

    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.mt-del')) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let dragged = false;
      let move;
      let up;
      const cleanup = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      move = (ev) => {
        if (dragged) return;
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) {
          dragged = true;
          cleanup();
          startDragOut(f);
        }
      };
      up = () => {
        cleanup();
        if (dragged) return;
        if (appState.traySelectedIds.has(f.id)) appState.traySelectedIds.delete(f.id);
        else appState.traySelectedIds.add(f.id);
        const now = appState.traySelectedIds.has(f.id);
        card.classList.toggle('sel', now);
        card.title = `${f.name} (Click to ${now ? 'deselect' : 'select'})`;
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    list.appendChild(card);
  });
}

export function getSelectedTrayFiles() {
  const all = appState.trayFiles || [];
  const picked = all.filter((f) => appState.traySelectedIds && appState.traySelectedIds.has(f.id));
  return picked.length ? picked : [...all];
}

export async function stageTrayFilesForPhone() {
  const files = getSelectedTrayFiles().filter((f) => f.path);
  await invokeTauri('clear_staged_quick_share_files');
  if (files.length) {
    await invokeTauri('stage_quick_share_files', { paths: files.map((f) => f.path) });
  }
  return files.length;
}

export async function deckSendToInexDrop() {
  const files = getSelectedTrayFiles();
  if (getDropMode() === 'p2p') {
    if (files.length && (appState.peers || []).length > 0) {
      appState.peers.forEach((p) => offerFilesToPeer(p.id, [...files]));
    } else if (files.length) {
      showTrayToast('info', 'Press Generate, connect a peer, then send', 2200);
    }
    openDeckDrop('p2p');
    return;
  }
  if (files.length > 0) await stageTrayFilesForPhone();
  if (!dropActive) await startInexDrop();
  openDeckDrop('qs');
}

export async function addDroppedPaths(paths, target) {
  let metas = await tryInvoke('file_info', { paths });
  if (!Array.isArray(metas)) {
    metas = (paths || []).map((p) => {
      const parts = String(p).split(/[\\/]/);
      const name = parts[parts.length - 1] || 'file';
      return { path: p, name, size: 0 };
    });
  }
  let added = 0;
  for (const m of metas) {
    if (appState.trayFiles.some((t) => t.path === m.path)) continue;
    appState.trayFiles.push({ id: trayIdSeq++, name: m.name, size: m.size, path: m.path });
    added++;
  }
  if (!added && !metas.length) {
    goCompact();
    return;
  }
  updateTrayUI();
  if (isDeckMenu()) {
    if (target === 'drop') deckSendToInexDrop();
    else openDeckTrayView(false);
  } else {
    openTrayView();
  }
  if (added > 0 && target !== 'drop') {
    requestAnimationFrame(() => {
      bus.emit('anim:tray-drop', {
        menuLayout: isDeckMenu() ? 'deck' : 'classic',
        addedPaths: metas.slice(0, added).map((m) => m.path)
      });
    });
  }
}

let dropLeaveTimeout = null;

export function onNativeDropDeck(p) {
  if (p.type === 'enter' || p.type === 'over') {
    clearTimeout(dropLeaveTimeout);
    if (appState.draggingOut) return;
    if (deckTrayPaneOpen() || appState.currentView === 'view-tray-deck') {
      document.getElementById('view-tray-deck')?.classList.add('dragging');
    } else {
      openDeckTrayView(true);
    }
    if (p.position) setDeckDropHover(deckDropTargetAt(p.position));
  } else if (p.type === 'leave') {
    clearTimeout(dropLeaveTimeout);
    dropLeaveTimeout = setTimeout(() => {
      const inPane = deckTrayPaneOpen();
      if (appState.draggingOut || (!inPane && appState.currentView !== 'view-tray-deck')) return;
      setDeckDropHover(null);
      document.getElementById('view-tray-deck')?.classList.remove('dragging');
      if (!inPane && appState.deckTrayByDrag) goCompact();
    }, 200);
  } else if (p.type === 'drop') {
    clearTimeout(dropLeaveTimeout);
    if (appState.draggingOut) {
      appState.draggingOut = false;
      goCompact();
      return;
    }
    const target = (p.position && deckDropTargetAt(p.position)) || appState.deckDropTarget || 'tray';
    setDeckDropHover(null);
    document.getElementById('view-tray-deck')?.classList.remove('dragging');
    appState.deckTrayByDrag = false;
    if (p.paths && p.paths.length) addDroppedPaths(p.paths, target);
    else if (!deckTrayPaneOpen() && appState.currentView !== 'view-tray-deck') goCompact();
  }
}

export function onNativeDrop(p) {
  if (!p) return;
  if (p2pNativeDrop(p)) return;
  if (isDeckMenu()) {
    onNativeDropDeck(p);
    return;
  }
  if (p.type === 'enter' || p.type === 'over') {
    clearTimeout(dropLeaveTimeout);
    if (!appState.draggingOut && appState.currentView !== 'view-drop' && appState.currentView !== 'view-tray') {
      if (typeof window.switchView === 'function') {
        window.switchView('view-drop', 'state-drop', ISLAND_WIN_W, 92);
      }
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
    if (appState.draggingOut) {
      appState.draggingOut = false;
      goCompact();
      return;
    }
    if (p.paths && p.paths.length) addDroppedPaths(p.paths);
    else if (appState.currentView === 'view-drop') goCompact();
  }
}

export function openTrayView() {
  if (isDeckMenu()) {
    openDeckTrayView(false);
    return;
  }
  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  if (appState.traySelectedIds.size === 0 && appState.trayFiles.length > 0) {
    appState.trayFiles.forEach((f) => appState.traySelectedIds.add(f.id));
  }
  appState.traySelect = null;
  const island = document.getElementById('island');
  island?.classList.remove('picker-open');
  document.getElementById('tray-peer-picker')?.classList.add('hidden');
  updateTrayUI();
  if (typeof window.switchView === 'function') {
    window.switchView('view-tray', 'state-tray', 316, 218);
  }
}

export async function startDragOut(f) {
  appState.draggingOut = true;
  try {
    if (f.path) await invokeTauri('drag_out_file', { path: f.path });
  } catch (err) {
    console.warn('Tauri drag_out_file failed:', err);
  }
  setTimeout(() => {
    appState.draggingOut = false;
  }, 400);
}

export function updateTrayUI() {
  const count = appState.trayFiles.length;
  const cTrayCount = document.getElementById('c-tray-count');
  if (cTrayCount) cTrayCount.textContent = count;
  const trayTotalBadge = document.getElementById('tray-total-badge');
  if (trayTotalBadge) trayTotalBadge.textContent = count;
  const tileTraySub = document.getElementById('tile-tray-sub');
  if (tileTraySub) tileTraySub.textContent = `${count} File${count === 1 ? '' : 's'}`;
  const trayCap = document.getElementById('tray-cap');
  if (trayCap) trayCap.textContent = count > 0 ? `${count} file${count > 1 ? 's' : ''}` : '';
  document.getElementById('tile-tray')?.classList.toggle('active', count > 0);
  const deckTrayBadge = document.getElementById('deck-tray-badge');
  if (deckTrayBadge) {
    deckTrayBadge.textContent = count;
    deckTrayBadge.classList.toggle('hidden', count === 0);
  }
  document.getElementById('deck-tray-btn')?.setAttribute('title', `File Tray (${count} File${count === 1 ? '' : 's'})`);
  document.getElementById('c-tray-btn')?.classList.toggle('hidden', count === 0);
  renderDeckTray();
  updateCompactStateClasses();

  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  const existingIds = new Set(appState.trayFiles.map((f) => f.id));
  for (const id of Array.from(appState.traySelectedIds)) {
    if (!existingIds.has(id)) appState.traySelectedIds.delete(id);
  }
  if (appState.traySelectedIds.size === 0 && count > 0) {
    appState.trayFiles.forEach((f) => appState.traySelectedIds.add(f.id));
  }

  const sel = appState.traySelect;
  const list = document.getElementById('tray-files-list');
  if (!list) return;
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
      <span class="f-check">\u2713</span>
      <button class="f-del" title="Remove file">\u00D7</button>
      ${trayFileIconHtml(f.name)}
      <div class="f-name">${escHtml(f.name)}</div>
    `;
    card.querySelector('.f-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.trayFiles = appState.trayFiles.filter((t) => t.id !== f.id);
      appState.traySelectedIds.delete(f.id);
      if (sel) sel.picked.delete(f.id);
      updateTrayUI();
      if (appState.currentView === 'view-tray' && !document.getElementById('tray-peer-picker')?.classList.contains('hidden')) {
        renderPeerPicker();
      }
    });

    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.f-del')) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let dragged = false;
      let move;
      let up;
      const cleanup = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      move = (ev) => {
        if (dragged) return;
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) {
          dragged = true;
          cleanup();
          startDragOut(f);
        }
      };
      up = () => {
        cleanup();
        if (!dragged) {
          if (appState.traySelectedIds.has(f.id)) {
            appState.traySelectedIds.delete(f.id);
          } else {
            appState.traySelectedIds.add(f.id);
          }
          const nowPicked = appState.traySelectedIds.has(f.id);
          card.classList.toggle('sel', nowPicked);
          card.title = `${f.name} (Click to ${nowPicked ? 'deselect' : 'select'})`;
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    list.appendChild(card);
  });
}

export function makeChip(text, onClick) {
  const chip = document.createElement('button');
  chip.className = 'peer-chip';
  chip.textContent = text;
  chip.addEventListener('click', onClick);
  return chip;
}

export function renderPeerPicker() {
  const picker = document.getElementById('tray-peer-picker');
  if (!picker) return;
  const label = picker.querySelector('small');
  const box = document.getElementById('tray-peer-buttons');
  if (!box) return;
  box.innerHTML = '';

  if (!appState.traySelectedIds) appState.traySelectedIds = new Set();
  const selectedCount = appState.traySelectedIds.size;
  if (label) {
    label.textContent = `Send ${selectedCount || appState.trayFiles.length} file${(selectedCount || appState.trayFiles.length) === 1 ? '' : 's'} to:`;
  }

  const island = document.getElementById('island');

  if (appState.peers.length === 0) {
    box.appendChild(makeChip('Connect device in P2P...', () => {
      island?.classList.remove('picker-open');
      picker.classList.add('hidden');
      openP2PView();
    }));
  } else {
    if (appState.peers.length > 1) {
      box.appendChild(makeChip(`\uD83C\uDF10 Send to All (${appState.peers.length})`, () => {
        let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds.has(f.id));
        if (toSend.length === 0 && appState.trayFiles.length > 0) toSend = [...appState.trayFiles];
        if (toSend.length > 0) {
          island?.classList.remove('picker-open');
          picker.classList.add('hidden');
          appState.peers.forEach((p) => offerFilesToPeer(p.id, toSend));
          goCompact();
          updateTrayUI();
        }
      }));
    }
    appState.peers.forEach((peer) => {
      box.appendChild(makeChip(`\uD83D\uDDA5\uFE0F ${peer.name}`, () => {
        let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds.has(f.id));
        if (toSend.length === 0 && appState.trayFiles.length > 0) {
          toSend = [...appState.trayFiles];
        }
        if (toSend.length > 0) {
          island?.classList.remove('picker-open');
          picker.classList.add('hidden');
          sendTrayFiles(peer.id, toSend);
        }
      }));
    });
  }
  picker.classList.remove('hidden');
}

export function trayP2PShare() {
  let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds && appState.traySelectedIds.has(f.id));
  if (toSend.length === 0 && appState.trayFiles.length > 0) {
    toSend = [...appState.trayFiles];
  }
  if (toSend.length === 0) {
    showTrayToast('info', 'Drop files into tray first');
    return;
  }
  const picker = document.getElementById('tray-peer-picker');
  const island = document.getElementById('island');
  if (picker && !picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    island?.classList.remove('picker-open');
    reportIslandSize({ width: ISLAND_WIN_W, height: 218 });
    return;
  }
  appState.traySelect = null;
  renderPeerPicker();
  island?.classList.add('picker-open');
  reportIslandSize({ width: ISLAND_WIN_W, height: 252 });
}

export function sendTrayFiles(peerId, files) {
  appState.traySelect = null;
  goCompact();
  offerFilesToPeer(peerId, files);
  updateTrayUI();
}

export function initTray() {
  window.sendTrayFiles = sendTrayFiles;
  bus.on('tray:update', updateTrayUI);

  const registerDrop = () => {
    invokeTauri('setup_shelf_drop').catch((e) => console.warn('[drop] setup_shelf_drop:', e));
  };
  registerDrop();
  setTimeout(registerDrop, 1000);
  setTimeout(registerDrop, 3000);

  const getEventData = (e) => {
    const p = (e && e.payload !== undefined) ? e.payload : e;
    return {
      paths: p?.paths || (Array.isArray(p) ? p : undefined),
      position: p?.position
    };
  };

  listenTauri('shelf-drag-enter', (e) => {
    const d = getEventData(e);
    onNativeDrop({ type: 'enter', paths: d.paths, position: d.position });
  });
  listenTauri('shelf-drag-over', (e) => {
    const d = getEventData(e);
    onNativeDrop({ type: 'over', position: d.position });
  });
  listenTauri('shelf-drag-leave', () => {
    onNativeDrop({ type: 'leave' });
  });
  listenTauri('shelf-drag-drop', (e) => {
    const d = getEventData(e);
    onNativeDrop({ type: 'drop', paths: d.paths, position: d.position });
  });

  const bindTauriHandler = (w) => {
    if (!w || !w.onDragDropEvent) return false;
    try {
      const r = w.onDragDropEvent((e) => {
        const d = getEventData(e);
        const pType = (e && e.payload && e.payload.type) || (e && e.type);
        if (pType === 'enter' || pType === 'over') {
          onNativeDrop({ type: 'enter', paths: d.paths, position: d.position });
        } else if (pType === 'leave') {
          onNativeDrop({ type: 'leave' });
        } else if (pType === 'drop') {
          onNativeDrop({ type: 'drop', paths: d.paths, position: d.position });
        }
      });
      if (r && r.catch) r.catch((err) => console.warn('Tray onDragDropEvent error:', err));
      return true;
    } catch {
      return false;
    }
  };

  const tw = window.__TAURI__;
  if (tw) {
    bindTauriHandler(tw.webviewWindow?.getCurrentWebviewWindow?.());
    bindTauriHandler(tw.window?.getCurrentWindow?.());
    bindTauriHandler(tw.webview?.getCurrentWebview?.());
  }

  listenTauri('tauri://drag-enter', (e) => {
    const d = getEventData(e);
    onNativeDrop({ type: 'enter', paths: d.paths, position: d.position });
  });
  listenTauri('tauri://drag-over', (e) => {
    const d = getEventData(e);
    onNativeDrop({ type: 'over', paths: d.paths, position: d.position });
  });
  listenTauri('tauri://drag-leave', () => onNativeDrop({ type: 'leave' }));
  listenTauri('tauri://drag-drop', (e) => {
    const d = getEventData(e);
    onNativeDrop({ type: 'drop', paths: d.paths, position: d.position });
  });

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

  const scrollTrayList = (e) => {
    const l = document.getElementById('tray-files-list');
    if (!l || l.scrollWidth <= l.clientWidth) return;
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    l.scrollLeft += (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) * Math.abs(delta);
    e.preventDefault();
  };
  document.getElementById('tray-files-list')?.addEventListener('wheel', scrollTrayList, { passive: false });
  // Control Deck tray: mouse wheel scrolls the file row sideways, like the Classic tray
  document.getElementById('mt-files')?.addEventListener('wheel', (e) => {
    const l = e.currentTarget;
    if (l.scrollWidth <= l.clientWidth) return;
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    l.scrollLeft += delta;
    e.preventDefault();
  }, { passive: false });
  document.getElementById('view-tray')?.addEventListener('wheel', (e) => {
    if (e.target.closest('#tray-peer-picker') || e.target.closest('.tray-share-actions')) return;
    scrollTrayList(e);
  }, { passive: false });

  document.getElementById('mt-clear')?.addEventListener('click', () => {
    appState.trayFiles = [];
    if (appState.traySelectedIds) appState.traySelectedIds.clear();
    updateTrayUI();
  });

  document.getElementById('mt-drop')?.addEventListener('click', () => deckSendToInexDrop());

  document.getElementById('btn-clear-tray')?.addEventListener('click', () => {
    appState.trayFiles = [];
    appState.traySelect = null;
    if (appState.traySelectedIds) appState.traySelectedIds.clear();
    document.getElementById('tray-peer-picker')?.classList.add('hidden');
    updateTrayUI();
  });

  document.getElementById('btn-tray-inexdrop')?.addEventListener('click', async () => {
    if (getDropMode() === 'p2p') {
      trayP2PShare();
      return;
    }
    if (appState.trayFiles && appState.trayFiles.length > 0) {
      await stageTrayFilesForPhone();
    }
    openDropView();
  });
}
