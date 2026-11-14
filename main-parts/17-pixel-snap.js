
// ---- Pixel snap: the island is centred inside its window, so on Windows scales like 125% / 150% (and in the built app, where the
// window size is rounded to whole device pixels) its left edge can land on a half pixel. The bezel ear hangs off that edge and
// got anti-aliased away on one side only (left ear slightly cut, right ear fine). Nudge the island so its left edge sits on a whole
// device pixel; the right ear then follows the same grid.
(function pixelSnap() {
  const snap = () => {
    const dpr = window.devicePixelRatio || 1;
    const zoom = parseFloat(island.style.zoom) || 1;
    island.style.left = '0px';
    const r = island.getBoundingClientRect();
    const d = Math.round(r.left * dpr) / dpr - r.left;
    if (Math.abs(d) > 0.001) island.style.left = (d / zoom) + 'px';
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(snap).observe(island);
  window.addEventListener('resize', snap);
  snap();
})();

// Block the WebView2 default right-click menu (Back / Refresh / Save as / Print / More tools).
// Our own handlers (tiles, rows...) still run; text fields keep the normal Cut / Copy / Paste menu.
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t && t.closest && t.closest('input:not([type="range"]):not([type="checkbox"]), textarea, [contenteditable="true"]')) return;
  e.preventDefault();
});
