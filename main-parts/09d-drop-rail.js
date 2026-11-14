// ==================== 09d. INEX DROP SIDE RAIL ====================
// P2P lives inside Inex Drop. A slim icon rail (right side, vertically centred) picks the mode:
// Quick Share or P2P. Exactly ONE mode is selected at a time and it is remembered across restarts.
// The selected mode decides what the Inex Drop tile (left click / chevron) and the File Tray button do.
// (functions + var on purpose: switchView can run before this part has executed)
var dropModeCache = null;

function dropRailViews() { return ['view-inexdrop', 'view-p2p']; }

function getDropMode() {
  if (dropModeCache == null) {
    let v = 'qs';
    try { if (localStorage.getItem('inex.dropMode') === 'p2p') v = 'p2p'; } catch (_) {}
    dropModeCache = v;
  }
  return dropModeCache;
}

function setDropMode(mode) {
  const m = mode === 'p2p' ? 'p2p' : 'qs';
  const changed = m !== getDropMode();
  dropModeCache = m;
  if (changed) { try { localStorage.setItem('inex.dropMode', m); } catch (_) {} }
  updateDropTile();
  updateTrayShareButton();
}

var QS_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10M8 8l4-4 4 4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>';
var P2P_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="9" height="7" rx="1.5"/><path d="M4 13h4"/><rect x="13.5" y="12" width="9" height="7" rx="1.5"/><path d="M16 22h4"/><path d="M12 6.5h4.5V10"/><path d="M12 17.5H7.5V14"/></svg>';

// The one Inex Drop tile always shows the selected mode (icon + status)
function updateDropTile() {
  const tile = document.getElementById('tile-drop');
  if (!tile) return;
  const p2p = getDropMode() === 'p2p';
  tile.classList.toggle('mode-p2p', p2p);
  const sub = document.getElementById('tile-drop-sub');
  const cap = document.getElementById('drop-cap');
  const title = document.getElementById('tile-drop-title');
  const count = (appState.peers || []).length;
  const direct = rtcPeers.has('direct-peer');
  const macTile = document.getElementById('mac-tile-drop');
  const macSub = document.getElementById('mac-drop-sub');
  const macTitle = macTile ? macTile.querySelector('.mx-txt b') : null;
  if (p2p) {
    const p2pText = count > 0 ? (direct ? 'Direct 1:1' : `${count}/5 Peers`) : 'Standby';
    tile.classList.toggle('active', count > 0);
    if (sub) sub.textContent = p2pText;
    if (cap) cap.textContent = count > 0 ? (direct ? '1 direct peer' : `${count} peer${count > 1 ? 's' : ''}`) : '';
    if (title) title.textContent = 'P2P Link';
    tile.title = 'Inex Drop · P2P (click to open)';
    if (macTile) macTile.classList.toggle('active', count > 0);
    if (macSub) macSub.textContent = p2pText;
    if (macTitle) macTitle.textContent = 'P2P Link';
  } else {
    const qsText = inTransfer ? 'Transferring' : (dropActive ? 'Ready' : 'Off');
    tile.classList.toggle('active', dropActive);
    if (sub) sub.textContent = qsText;
    if (cap) cap.textContent = '';
    if (title) title.textContent = 'Inex Drop';
    tile.title = 'Inex Drop · Quick Share (click to turn on / off)';
    if (macTile) macTile.classList.toggle('active', dropActive);
    if (macSub) macSub.textContent = qsText;
    if (macTitle) macTitle.textContent = 'Inex Drop';
  }
}

// The File Tray has a single "Inex Drop" button; its icon follows the selected mode
function updateTrayShareButton() {
  const btn = document.getElementById('btn-tray-inexdrop');
  if (!btn) return;
  const svg = btn.querySelector('svg');
  const p2p = getDropMode() === 'p2p';
  if (svg) {
    const tmp = document.createElement('div');
    tmp.innerHTML = p2p ? P2P_ICON_SVG : QS_ICON_SVG;
    const n = tmp.firstElementChild;
    n.setAttribute('width', '15'); n.setAttribute('height', '15');
    svg.replaceWith(n);
  }
  btn.title = p2p ? 'Inex Drop · P2P' : 'Inex Drop · Quick Share';
}

function syncDropRail(viewId) {
  const idx = dropRailViews().indexOf(viewId);
  island.classList.toggle('has-rail', idx !== -1);
  if (idx === -1) return;
  setDropMode(idx === 0 ? 'qs' : 'p2p');   // whatever is opened last is the selected mode (one at a time, remembered)
  const rail = document.getElementById('drop-rail');
  if (rail) rail.style.setProperty('--i', String(idx));
  document.getElementById('rail-qs')?.classList.toggle('on', idx === 0);
  document.getElementById('rail-p2p')?.classList.toggle('on', idx === 1);
}

// Mac menu: open Quick Share or P2P in the right-hand panel (the rail on the side switches between them)
function openMacDrop(mode) {
  const m = mode || getDropMode();
  if (appState.currentView !== 'view-control-mac') openControlMenu();
  if (m === 'p2p') {
    openMacSub('view-p2p', 'P2P');
  } else {
    openMacSub('view-inexdrop', 'Inex Drop');
    if (typeof refreshDropUI === 'function') refreshDropUI();
  }
}

// which rail slot is open right now (classic view, or in-place sub panel of the Mac menu)
function currentDropRailIdx() {
  if (appState.currentView === 'view-control-mac' && typeof currentMacSubTarget !== 'undefined' && currentMacSubTarget) {
    return dropRailViews().indexOf(currentMacSubTarget.id);
  }
  return dropRailViews().indexOf(appState.currentView);
}

function goDropRail(idx) {
  if (idx < 0 || idx >= dropRailViews().length) return;
  if (currentDropRailIdx() === idx) return;
  if (appState.currentView === 'view-control-mac') {          // Mac menu: swap the panel in place
    if (idx === 0) { openMacSub('view-inexdrop', 'Inex Drop'); refreshDropUI(); }
    else openMacSub('view-p2p', 'P2P');
    return;
  }
  if (idx === 0) openQsView();
  else openP2PView();
}

function updateDropRailBadge(count) {
  const b = document.getElementById('rail-p2p-badge');
  if (!b) return;
  b.textContent = String(count);
  b.classList.toggle('hidden', !count);
}

document.getElementById('rail-qs')?.addEventListener('click', (e) => { e.stopPropagation(); goDropRail(0); });
document.getElementById('rail-p2p')?.addEventListener('click', (e) => { e.stopPropagation(); goDropRail(1); });

let dropRailWheelAt = 0;
document.getElementById('drop-rail')?.addEventListener('wheel', (e) => {
  e.preventDefault();
  const now = Date.now();
  if (now - dropRailWheelAt < 250) return;
  dropRailWheelAt = now;
  const cur = currentDropRailIdx();
  if (cur === -1) return;
  goDropRail(cur + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });

// restore the remembered mode on the tile / tray button right after start
updateDropTile();
updateTrayShareButton();
