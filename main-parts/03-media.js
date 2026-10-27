let mediaBackendPos = 0;
let mediaBackendTime = Date.now();

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function renderMediaProgress(pos) {
  if (pos === undefined) {
    if (appState.mediaPlaying && !appState.mediaSeeking && appState.mediaDuration > 0) {
      const now = Date.now();
      const elapsed = Math.max(0, (now - mediaBackendTime) / 1000);
      const computed = Math.min(appState.mediaDuration, mediaBackendPos + elapsed);
      if (appState.mediaProgressSec && computed < appState.mediaProgressSec && (appState.mediaProgressSec - computed) < 6.0) {
        pos = appState.mediaProgressSec;
      } else {
        pos = computed;
        appState.mediaProgressSec = pos;
      }
    } else {
      pos = appState.mediaProgressSec || 0;
    }
  }
  const dur = appState.mediaDuration || 0;
  pos = Math.min(dur || pos, Math.max(0, pos));
  const curTimeEl = document.getElementById('m-cur-time');
  const totTimeEl = document.getElementById('m-tot-time');
  const progFillEl = document.getElementById('m-prog-fill');
  const sliderEl = document.getElementById('m-seek-slider');

  if (curTimeEl) curTimeEl.textContent = fmtTime(pos);
  if (totTimeEl) totTimeEl.textContent = dur > 0 ? `-${fmtTime(dur - pos)}` : '--:--';
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  if (progFillEl) progFillEl.style.width = `${pct}%`;
  if (sliderEl && !appState.mediaSeeking) {
    sliderEl.value = Math.round(pct * 10);
  }
}

// Tick media progress smoothly every 250ms (no backwards snapping)
setInterval(() => {
  if (appState.mediaPlaying && !appState.mediaSeeking && appState.mediaDuration > 0) {
    renderMediaProgress();
  }
}, 250);

// Interactive Media Timeline Seek Bar
const seekSlider = document.getElementById('m-seek-slider');
seekSlider.addEventListener('input', (e) => {
  if (appState.mediaDuration <= 0) return;
  appState.mediaSeeking = true;
  const pct = Number(e.target.value) / 1000;
  const targetSec = pct * appState.mediaDuration;
  document.getElementById('m-prog-fill').style.width = `${pct * 100}%`;
  document.getElementById('m-cur-time').textContent = fmtTime(targetSec);
  document.getElementById('m-tot-time').textContent = `-${fmtTime(appState.mediaDuration - targetSec)}`;
});

seekSlider.addEventListener('change', async (e) => {
  if (appState.mediaDuration <= 0) {
    appState.mediaSeeking = false;
    return;
  }
  const pct = Number(e.target.value) / 1000;
  const targetSec = pct * appState.mediaDuration;
  mediaBackendPos = targetSec;
  mediaBackendTime = Date.now();
  appState.mediaProgressSec = targetSec;
  await invokeTauri('seek_media', { positionSec: targetSec });
  setTimeout(() => { appState.mediaSeeking = false; }, 300);
});

// Artwork & Dominant Ambient Color
async function loadMediaArt() {
  const url = await invokeTauri('get_media_art');
  const cArt = document.getElementById('c-art'), mArt = document.getElementById('m-art');
  const cFb = document.getElementById('c-art-fallback'), mFb = document.getElementById('m-art-fallback');
  const card = document.getElementById('view-media');

  if (!url) {
    appState.loadedArtUrl = '';
    [cArt, mArt].forEach((i) => {
      i.classList.add('hidden');
      i.src = '';
    });
    [cFb, mFb].forEach((i) => (i.style.display = ''));
    if (card) card.style.setProperty('--amb', '70, 130, 180');
    return;
  }

  if (url === appState.loadedArtUrl) return;

  const img = new Image();
  img.onload = () => {
    // If image is a tiny icon (width and height <= 64), skip it (it's a browser placeholder)
    if (img.naturalWidth > 0 && img.naturalWidth <= 64 && img.naturalHeight <= 64) {
      return;
    }
    appState.loadedArtUrl = url;
    cArt.src = url;
    mArt.src = url;
    [cArt, mArt].forEach((i) => i.classList.remove('hidden'));
    [cFb, mFb].forEach((i) => (i.style.display = 'none'));
    const c = dominantColor(img);
    if (card) card.style.setProperty('--amb', c);
    const mBtn = document.getElementById('c-media-btn');
    if (mBtn) mBtn.style.setProperty('--thumb-glow', `rgba(${c}, 0.9)`);
  };
  img.src = url;
}

function dominantColor(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 24, 24);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
    const sat = max === 0 ? 0 : (max - min) / max;
    const wt = 0.15 + sat * sat * 3 + (max > 40 ? 0.1 : 0);
    r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
  }
  r /= w; g /= w; b /= w;
  const m = Math.max(r, g, b) || 1, k = m < 120 ? 120 / m : 1;
  return `${Math.min(255, Math.round(r * k))}, ${Math.min(255, Math.round(g * k))}, ${Math.min(255, Math.round(b * k))}`;
}

setInterval(updateClocks, 1000);
updateClocks();

function clearMediaUI() {
  appState.cachedMedia = null;
  appState.mediaPlaying = false;
  appState.mediaTitleKey = '';
  appState.loadedArtUrl = '';

  const eq = document.getElementById('c-eq');
  const mediaBtn = document.getElementById('c-media-btn');
  const cArt = document.getElementById('c-art');
  const mArt = document.getElementById('m-art');
  const cFb = document.getElementById('c-art-fallback');
  const mFb = document.getElementById('m-art-fallback');
  const playSvg = document.getElementById('m-play-svg');
  const mEqBars = document.getElementById('m-eq-bars');
  const mTitle = document.getElementById('m-title');
  const mArtist = document.getElementById('m-artist');
  const card = document.getElementById('view-media');

  if (eq) eq.classList.add('hidden');
  if (mediaBtn) {
    mediaBtn.classList.add('hidden');
    mediaBtn.classList.remove('paused');
  }
  if (cArt) {
    cArt.src = '';
    cArt.classList.add('hidden');
  }
  if (mArt) {
    mArt.src = '';
    mArt.classList.add('hidden');
  }
  if (cFb) cFb.style.display = '';
  if (mFb) mFb.style.display = '';
  if (card) card.style.setProperty('--amb', '70, 130, 180');
  if (playSvg) playSvg.innerHTML = `<polygon points="6 3 20 12 6 21"/>`;
  if (mEqBars) mEqBars.style.visibility = 'hidden';
  if (mTitle) mTitle.textContent = 'Not Playing';
  if (mArtist) mArtist.textContent = 'Spotify / YouTube';

  appState.mediaProgressSec = 0;
  appState.mediaDuration = 0;
  renderMediaProgress();

  island.classList.remove('media-active');
  updateCompactStateClasses();
  syncEq();
}

// 2. Poll Media, RAM, Wi-Fi & Fullscreen Window State (Smart Mode)
// 2. System state. Windows now TELLS us about changes (events from Rust); the only timer left
// is one cheap native stats read every 3 s, and it sleeps while the island is hidden.
async function refreshMedia() {
  if (SET.notch && SET.notch.musicMode === false) {
    clearMediaUI();
    return;
  }

  const media = await invokeTauri('get_media_status');
  const eq = document.getElementById('c-eq');
  const mediaBtn = document.getElementById('c-media-btn');
  const playSvg = document.getElementById('m-play-svg');
  const mTitle = document.getElementById('m-title');
  const mArtist = document.getElementById('m-artist');
  const mEqBars = document.getElementById('m-eq-bars');

  const hasMedia = !!(media && media.title && media.title.trim());
  const isPlaying = !!(hasMedia && media.playing);

  appState.mediaPlaying = isPlaying;

  if (!hasMedia) {
    clearMediaUI();
    return;
  }

  if (media.duration > 0) appState.mediaDuration = media.duration;

  // Active track exists
  if (isPlaying) {
    if (mTitle) mTitle.textContent = media.title;
    if (mArtist) mArtist.textContent = media.artist || 'Playing on PC';
    if (playSvg) playSvg.innerHTML = `<rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/>`;
    if (mEqBars) mEqBars.style.visibility = 'visible';

    if (SET.notch && SET.notch.compactMode !== false) {
      if (eq) eq.classList.remove('hidden');
      if (mediaBtn) mediaBtn.classList.remove('hidden', 'paused');
    } else {
      if (eq) eq.classList.add('hidden');
      if (mediaBtn) mediaBtn.classList.add('hidden');
    }

    const key = media.title + '|' + (media.artist || '');
    const isNewTrack = key !== appState.mediaTitleKey;
    const now = media.updated_at || Date.now();

    if (isNewTrack) {
      appState.mediaTitleKey = key;
      appState.loadedArtUrl = '';
      mediaBackendPos = Math.max(0, media.position || 0);
      mediaBackendTime = now;
      appState.mediaProgressSec = mediaBackendPos;
      loadMediaArt();
      // Retry in 400ms and 1200ms to guarantee fetching YouTube high-res thumbnail after initial buffering
      setTimeout(loadMediaArt, 400);
      setTimeout(loadMediaArt, 1200);
    } else if (!appState.mediaSeeking && media.position >= 0) {
      // Smooth monotonic progress extrapolation
      const currentExtrapolated = mediaBackendPos + Math.max(0, (now - mediaBackendTime) / 1000);
      const forwardJump = media.position - currentExtrapolated;
      const backwardJump = currentExtrapolated - media.position;

      // Only accept backward change if user performed a real backward seek (> 6.0s).
      // Stale polling timestamps (< 6s backwards) are completely ignored to prevent jumping glitches.
      if (backwardJump > 6.0 || forwardJump > 1.2) {
        mediaBackendPos = media.position;
        mediaBackendTime = now;
      }
    }
    renderMediaProgress();
  } else {
    // Paused: hide equalizer and compact disc, return island to clean desktop mode
    if (eq) eq.classList.add('hidden');
    if (mediaBtn) {
      mediaBtn.classList.add('hidden');
      mediaBtn.classList.add('paused');
    }
    if (mEqBars) mEqBars.style.visibility = 'hidden';
    if (playSvg) playSvg.innerHTML = `<polygon points="6 3 20 12 6 21"/>`;

    // Keep metadata in expanded player if opened
    if (mTitle) mTitle.textContent = media.title;
    if (mArtist) mArtist.textContent = media.artist ? `${media.artist} (Paused)` : 'Paused on PC';
    if (!appState.mediaSeeking && media.position >= 0) {
      mediaBackendPos = media.position;
      mediaBackendTime = Date.now();
      appState.mediaProgressSec = media.position;
    }
    renderMediaProgress();
  }

  updateCompactStateClasses();
  syncEq();
}

