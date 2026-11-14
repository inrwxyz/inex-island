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

  if (appState.currentView !== 'view-media' && appState.currentView !== 'view-control-mac') return;

  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  const macProgEl = document.getElementById('mac-prog-fill');
  if (macProgEl && !appState.mediaSeeking) {
    macProgEl.style.setProperty('--v', pct.toFixed(1));
  }
  const macSlider = document.getElementById('mac-seek-slider');
  if (macSlider && !appState.mediaSeeking) {
    const v = Math.round(pct * 10);
    if (macSlider.value != v) macSlider.value = v;
  }
  if (appState.currentView !== 'view-media') return;

  const curTimeEl = document.getElementById('m-cur-time');
  const totTimeEl = document.getElementById('m-tot-time');
  const progFillEl = document.getElementById('m-prog-fill');
  const sliderEl = document.getElementById('m-seek-slider');

  if (curTimeEl) {
    const str = fmtTime(pos);
    if (curTimeEl.textContent !== str) curTimeEl.textContent = str;
  }
  if (totTimeEl) {
    const str = dur > 0 ? `-${fmtTime(dur - pos)}` : '--:--';
    if (totTimeEl.textContent !== str) totTimeEl.textContent = str;
  }
  if (progFillEl) {
    const w = `${pct}%`;
    if (progFillEl.style.width !== w) progFillEl.style.width = w;
  }
  if (sliderEl && !appState.mediaSeeking) {
    const v = Math.round(pct * 10);
    if (sliderEl.value != v) sliderEl.value = v;
  }
}

// Tick media progress smoothly every 250ms when expanded media player is open
// The timer only exists while the media panel is open and a track is playing.
var mediaTickT; // var + no initializer: switchView() may call syncMediaTick() early
function syncMediaTick() {
  const macWantsMedia = appState.currentView === 'view-control-mac' && (!SET.macMenu || SET.macMenu.showMedia !== false);
  const want = (appState.currentView === 'view-media' || macWantsMedia) && appState.mediaPlaying && appState.mediaDuration > 0;
  if (want && !mediaTickT) {
    mediaTickT = setInterval(() => {
      if (!appState.mediaSeeking) renderMediaProgress();
    }, 250);
  } else if (!want && mediaTickT) {
    clearInterval(mediaTickT);
    mediaTickT = null;
  }
}

// Interactive Media Timeline Seek Bar (Classic + Control Deck)
function handleSeekInput(sliderVal) {
  if (appState.mediaDuration <= 0) return;
  appState.mediaSeeking = true;
  const pct = Number(sliderVal) / 1000;
  const targetSec = pct * appState.mediaDuration;
  const mFill = document.getElementById('m-prog-fill');
  const mCur = document.getElementById('m-cur-time');
  const mTot = document.getElementById('m-tot-time');
  if (mFill) mFill.style.width = `${pct * 100}%`;
  if (mCur) mCur.textContent = fmtTime(targetSec);
  if (mTot) mTot.textContent = `-${fmtTime(appState.mediaDuration - targetSec)}`;
  const macFill = document.getElementById('mac-prog-fill');
  if (macFill) macFill.style.setProperty('--v', (pct * 100).toFixed(1));
}

async function handleSeekCommit(sliderVal) {
  if (appState.mediaDuration <= 0) {
    appState.mediaSeeking = false;
    return;
  }
  const pct = Number(sliderVal) / 1000;
  const targetSec = pct * appState.mediaDuration;
  mediaBackendPos = targetSec;
  mediaBackendTime = Date.now();
  appState.mediaProgressSec = targetSec;
  await invokeTauri('seek_media', { positionSec: targetSec });
  setTimeout(() => { appState.mediaSeeking = false; }, 300);
}

['m-seek-slider', 'mac-seek-slider'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', (e) => handleSeekInput(e.target.value));
  el.addEventListener('change', (e) => handleSeekCommit(e.target.value));
});

// Artwork & Dominant Ambient Color
function setAmb(rgb) {
  ['view-media', 'mac-media', 'island'].forEach((id) => document.getElementById(id)?.style.setProperty('--amb', rgb));
}

async function loadMediaArt() {
  const url = await invokeTauri('get_media_art');
  const cArt = document.getElementById('c-art'), mArt = document.getElementById('m-art'), macArt = document.getElementById('mac-art');
  const cFb = document.getElementById('c-art-fallback'), mFb = document.getElementById('m-art-fallback'), macFb = document.getElementById('mac-art-fallback');

  if (!url) {
    appState.loadedArtUrl = '';
    [cArt, mArt, macArt].forEach((i) => {
      if (!i) return;
      i.classList.add('hidden');
      i.src = '';
    });
    [cFb, mFb, macFb].forEach((i) => { if (i) i.style.display = ''; });
    setAmb('70, 130, 180');
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
    if (cArt) cArt.src = url;
    if (mArt) mArt.src = url;
    if (macArt) macArt.src = url;
    [cArt, mArt, macArt].forEach((i) => { if (i) i.classList.remove('hidden'); });
    [cFb, mFb, macFb].forEach((i) => { if (i) i.style.display = 'none'; });
    const c = dominantColor(img);
    setAmb(c);
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

// The clock shows hours:minutes, so wake only on the minute (and again after the PC resumes).
function tickClock() {
  updateClocks();
  setTimeout(tickClock, 60000 - (Date.now() % 60000) + 20);
}
tickClock();
onTauriEvent('system-resumed', updateClocks);

function sourceBadgeMeta(src) {
  const s = (src || '').toLowerCase();
  if (s.includes('spotify')) {
    return {
      cls: 'src-spotify',
      svg: '<svg viewBox="0 0 24 24" fill="#1ed760"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.34c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.18.48.66.3 1.02zm1.44-3.3c-.3.42-.84.6-1.26.3-3.24-1.98-8.16-2.58-11.94-1.38-.48.12-1.02-.12-1.14-.6-.12-.48.12-1.02.6-1.14 4.32-1.32 9.72-.66 13.44 1.62.36.18.54.78.3 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.3c-.6.18-1.2-.18-1.38-.72-.18-.6.18-1.2.72-1.38 4.26-1.26 11.28-1.02 15.72 1.62.54.3.72 1.02.42 1.56-.3.42-1.02.6-1.56.3z"/></svg>'
    };
  }
  if (s.includes('youtube')) {
    if (s.includes('music')) {
      return {
        cls: 'src-youtube-music',
        svg: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7.5" stroke="#ffffff" stroke-width="1.6"/><polygon points="10,8.5 16,12 10,15.5" fill="#ffffff"/></svg>'
      };
    }
    return {
      cls: 'src-youtube',
      svg: '<svg viewBox="0 0 24 24" fill="#ffffff"><path d="M9.5 7.4v9.2L17.2 12 9.5 7.4z"/></svg>'
    };
  }
  if (s.includes('apple')) {
    return {
      cls: 'src-apple',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 4v10.2a2.8 2.8 0 1 1-1.8-2.6V7.5l-6 1.5v6.8a2.8 2.8 0 1 1-1.8-2.6V6.2L16 4z"/></svg>'
    };
  }
  if (s.includes('vlc')) {
    return {
      cls: 'src-vlc',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 7.5 18H5v2h14v-2h-2.5L12 3z"/></svg>'
    };
  }
  if (s.includes('chrome') || s.includes('edge') || s.includes('firefox') || s.includes('brave') || s.includes('opera')) {
    return {
      cls: 'src-browser',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="8"/><path d="M4.5 12h15M12 4a11 11 0 0 1 0 16M12 4a11 11 0 0 0 0 16"/></svg>'
    };
  }
  return {
    cls: '',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
  };
}

function updateSourceBadge(badgeId, icoId, _nameId, source) {
  const badge = document.getElementById(badgeId);
  const ico = document.getElementById(icoId);
  if (!badge) return;
  const label = (source || '').trim();
  if (!label) {
    badge.className = 'src-corner hidden';
    badge.title = '';
    delete badge.dataset.src;
    return;
  }
  if (badge.dataset.src !== label) {
    badge.dataset.src = label;
    const meta = sourceBadgeMeta(label);
    badge.className = `src-corner${meta.cls ? ' ' + meta.cls : ''}`;
    badge.title = `Playing from ${label}`;
    if (ico) ico.innerHTML = meta.svg;
  }
  badge.classList.remove('hidden');
}

function syncMacMediaUI() {
  const m = appState.cachedMedia;
  const hasMedia = !!(m && m.title && m.title.trim());
  const isPlaying = !!(hasMedia && appState.mediaPlaying);
  const titleEl = document.getElementById('mac-title');
  const artistEl = document.getElementById('mac-artist');
  const playSvg = document.getElementById('mac-play-svg');
  const macArt = document.getElementById('mac-art');
  const macFb = document.getElementById('mac-art-fallback');
  const progEl = document.getElementById('mac-prog-fill');
  document.getElementById('mac-media')?.classList.toggle('has-media', hasMedia);

  const _t = hasMedia ? m.title : 'Not Playing';
  if (titleEl && titleEl.textContent !== _t) titleEl.textContent = _t;   // same text: keep the sliding animation running
  if (artistEl) {
    const _a = !hasMedia
      ? 'Spotify / YouTube'
      : isPlaying
        ? (m.artist || 'Playing on PC')
        : (m.artist ? `${m.artist} (Paused)` : 'Paused on PC');
    if (artistEl.textContent !== _a) artistEl.textContent = _a;
  }
  updateSourceBadge('mac-source-badge', 'mac-source-ico', 'mac-source-name', hasMedia ? m.source : '');
  if (playSvg) {
    playSvg.innerHTML = isPlaying
      ? '<rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/>'
      : '<polygon points="6 3 20 12 6 21"/>';
  }
  if (macArt && macFb) {
    if (hasMedia && appState.loadedArtUrl) {
      if (macArt.src !== appState.loadedArtUrl) macArt.src = appState.loadedArtUrl;
      macArt.classList.remove('hidden');
      macFb.style.display = 'none';
    } else {
      macArt.src = '';
      macArt.classList.add('hidden');
      macFb.style.display = '';
    }
  }
  if (progEl && !hasMedia) progEl.style.setProperty('--v', '0');
}

document.querySelector('#mac-media .mx-media-top')?.addEventListener('click', () => {
  if (appState.cachedMedia && appState.cachedMedia.title) openMedia();
});

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
  setAmb('70, 130, 180');
  if (playSvg) playSvg.innerHTML = `<polygon points="6 3 20 12 6 21"/>`;
  if (mEqBars) mEqBars.style.visibility = 'hidden';
  if (mTitle) mTitle.textContent = 'Not Playing';
  if (mArtist) mArtist.textContent = 'Spotify / YouTube';
  updateSourceBadge('m-source-badge', 'm-source-ico', 'm-source-name', '');
  syncMacMediaUI();

  appState.mediaProgressSec = 0;
  appState.mediaDuration = 0;
  if (typeof syncMediaTick === 'function') syncMediaTick();
  renderMediaProgress();

  island.classList.remove('media-active');
  syncMacMediaUI();
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
  appState.cachedMedia = media;
  updateSourceBadge('m-source-badge', 'm-source-ico', 'm-source-name', media.source || '');

  if (media.duration > 0) appState.mediaDuration = media.duration;
  syncMediaTick();

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

  syncMacMediaUI();
  updateCompactStateClasses();
  syncEq();
}

