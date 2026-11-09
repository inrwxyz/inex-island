// ==================== 09d. INEX DROP SIDE RAIL ====================
// P2P is no longer a separate menu tile: it lives inside Inex Drop. A slim icon rail on the right side of the
// Inex Drop / P2P panels lets you slide up / down (mouse wheel) or click to pick Quick Share or P2P.
// The two panels themselves (view-inexdrop, view-p2p) are unchanged.
// (a function, not a const: switchView can run before this part has executed)
function dropRailViews() { return ['view-inexdrop', 'view-p2p']; }

function syncDropRail(viewId) {
  const idx = dropRailViews().indexOf(viewId);
  island.classList.toggle('has-rail', idx !== -1);
  if (idx === -1) return;
  const rail = document.getElementById('drop-rail');
  if (rail) rail.style.setProperty('--i', String(idx));
  document.getElementById('rail-qs')?.classList.toggle('on', idx === 0);
  document.getElementById('rail-p2p')?.classList.toggle('on', idx === 1);
}

function goDropRail(idx) {
  if (idx < 0 || idx >= dropRailViews().length) return;
  if (appState.currentView === dropRailViews()[idx]) return;
  if (idx === 0) openDropView();
  else switchView('view-p2p', 'state-sub', 316, 268);
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
  const cur = dropRailViews().indexOf(appState.currentView);
  if (cur === -1) return;
  goDropRail(cur + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });
