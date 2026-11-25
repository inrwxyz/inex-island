// Media Feature: handles Windows media playback state, artwork, seek controls, and equalizer sync
import { $, island } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';
import { updateCompactStateClasses } from '../../core/views.js';
import { syncEq } from '../equalizer/index.js';
import { syncMediaAppVolume } from '../volume/index.js';

let mediaBackendPos = 0;
let mediaBackendTime = Date.now();

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function getMediaPositionSec() {
  const dur = appState.mediaDuration || 0;
  let p = appState.mediaProgressSec || 0;
  if (appState.mediaPlaying && !appState.mediaSeeking) {
    const elapsed = Math.max(0, (Date.now() - mediaBackendTime) / 1000);
    const computed = mediaBackendPos + elapsed;
    p = dur > 0 ? Math.min(dur, computed) : computed;
  }
  p = Math.max(0, dur > 0 ? Math.min(dur, p) : p);
  return p;
}

export function renderMediaProgress(pos) {
  let p = pos;
  if (p === undefined) {
    p = getMediaPositionSec();
    if (appState.mediaPlaying && !appState.mediaSeeking) {
      appState.mediaProgressSec = p;
    }
  }
  const dur = appState.mediaDuration || 0;
  p = Math.min(dur || p, Math.max(0, p));

  const pct = dur > 0 ? Math.min(100, (p / dur) * 100) : 0;
  if (appState.currentView !== 'view-media') return;
  bus.emit('media:tick', p);

  const curTimeEl = $('m-cur-time');
  const totTimeEl = $('m-tot-time');
  const progFillEl = $('m-prog-fill');
  const sliderEl = $('m-seek-slider');

  if (curTimeEl) {
    const str = fmtTime(p);
    if (curTimeEl.textContent !== str) curTimeEl.textContent = str;
  }
  if (totTimeEl) {
    const str = dur > 0 ? `-${fmtTime(dur - p)}` : '--:--';
    if (totTimeEl.textContent !== str) totTimeEl.textContent = str;
  }
  if (progFillEl) {
    const w = `${pct}%`;
    if (progFillEl.style.width !== w) progFillEl.style.width = w;
  }
  if (sliderEl && !appState.mediaSeeking) {
    const v = Math.round(pct * 10);
    if (sliderEl.value !== String(v)) sliderEl.value = v;
  }
}

let mediaTickT = null;
let mediaTickMs = 0;
export function syncMediaTick() {
  const want = appState.currentView === 'view-media' && appState.mediaPlaying;
  const ms = 250;
  if (want && mediaTickT && mediaTickMs !== ms) {
    clearInterval(mediaTickT);
    mediaTickT = null;
  }
  if (want && !mediaTickT) {
    mediaTickMs = ms;
    mediaTickT = setInterval(() => {
      if (!appState.mediaSeeking) renderMediaProgress();
    }, ms);
  } else if (!want && mediaTickT) {
    clearInterval(mediaTickT);
    mediaTickT = null;
  }
}

export function handleSeekInput(sliderVal) {
  if (appState.mediaDuration <= 0) return;
  appState.mediaSeeking = true;
  const pct = Number(sliderVal) / 1000;
  const targetSec = pct * appState.mediaDuration;
  const mFill = $('m-prog-fill');
  const mCur = $('m-cur-time');
  const mTot = $('m-tot-time');
  if (mFill) mFill.style.width = `${pct * 100}%`;
  if (mCur) mCur.textContent = fmtTime(targetSec);
  if (mTot) mTot.textContent = `-${fmtTime(appState.mediaDuration - targetSec)}`;
}

export async function handleSeekCommit(sliderVal) {
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
  setTimeout(() => {
    appState.mediaSeeking = false;
  }, 300);
}

export function setAmb(rgb) {
  ['view-media', 'island'].forEach((id) => $(id)?.style.setProperty('--amb', rgb));
}

export function dominantColor(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 24, 24);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const max = Math.max(d[i], d[i + 1], d[i + 2]);
    const min = Math.min(d[i], d[i + 1], d[i + 2]);
    const sat = max === 0 ? 0 : (max - min) / max;
    const wt = 0.15 + sat * sat * 3 + (max > 40 ? 0.1 : 0);
    r += d[i] * wt;
    g += d[i + 1] * wt;
    b += d[i + 2] * wt;
    w += wt;
  }
  r /= w;
  g /= w;
  b /= w;
  const m = Math.max(r, g, b) || 1;
  const k = m < 120 ? 120 / m : 1;
  return `${Math.min(255, Math.round(r * k))}, ${Math.min(255, Math.round(g * k))}, ${Math.min(255, Math.round(b * k))}`;
}

export async function loadMediaArt() {
  const url = await invokeTauri('get_media_art');
  const cArt = $('c-art');
  const mArt = $('m-art');
  const cFb = $('c-art-fallback');
  const mFb = $('m-art-fallback');

  if (!url) {
    appState.loadedArtUrl = '';
    [cArt, mArt].forEach((i) => {
      if (!i) return;
      i.classList.add('hidden');
      i.src = '';
    });
    [cFb, mFb].forEach((i) => {
      if (i) i.classList.remove('hidden');
    });
    setAmb('70, 130, 180');
    return;
  }

  if (url === appState.loadedArtUrl) return;

  const img = new Image();
  img.onload = () => {
    if (img.naturalWidth > 0 && img.naturalWidth <= 64 && img.naturalHeight <= 64) {
      return;
    }
    appState.loadedArtUrl = url;
    if (cArt) cArt.src = url;
    if (mArt) mArt.src = url;
    [cArt, mArt].forEach((i) => {
      if (i) i.classList.remove('hidden');
    });
    [cFb, mFb].forEach((i) => {
      if (i) i.classList.add('hidden');
    });
    const c = dominantColor(img);
    setAmb(c);
    const mBtn = $('c-media-btn');
    if (mBtn) mBtn.style.setProperty('--thumb-glow', `rgba(${c}, 0.9)`);
  };
  img.src = url;
}

export function sourceBadgeMeta(src) {
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

export function updateSourceBadge(badgeId, icoId, _nameId, source) {
  const badge = $(badgeId);
  const ico = $(icoId);
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

export function clearMediaUI() {
  appState.cachedMedia = null;
  appState.mediaPlaying = false;
  appState.mediaTitleKey = '';
  appState.loadedArtUrl = '';

  const eq = $('c-eq');
  const mediaBtn = $('c-media-btn');
  const cArt = $('c-art');
  const mArt = $('m-art');
  const cFb = $('c-art-fallback');
  const mFb = $('m-art-fallback');
  const playSvg = $('m-play-svg');
  const mEqBars = $('m-eq-bars');
  const mTitle = $('m-title');
  const mArtist = $('m-artist');

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
  if (cFb) cFb.classList.remove('hidden');
  if (mFb) mFb.classList.remove('hidden');
  setAmb('70, 130, 180');
  if (playSvg) playSvg.innerHTML = '<polygon points="6 3 20 12 6 21"/>';
  if (mEqBars) mEqBars.classList.add('hidden');
  if (mTitle) mTitle.textContent = 'Not Playing';
  if (mArtist) mArtist.textContent = 'Spotify / YouTube';
  updateSourceBadge('m-source-badge', 'm-source-ico', 'm-source-name', '');

  appState.mediaProgressSec = 0;
  appState.mediaDuration = 0;
  syncMediaTick();
  renderMediaProgress();

  island?.classList.remove('media-active');
  $('view-media')?.classList.remove('is-playing');
  updateCompactStateClasses();
  syncEq();
}

export async function refreshMedia() {
  const SET = loadSettings();
  if (SET.notch && SET.notch.musicMode === false) {
    clearMediaUI();
    return;
  }

  const media = await invokeTauri('get_media_status');
  const eq = $('c-eq');
  const mediaBtn = $('c-media-btn');
  const playSvg = $('m-play-svg');
  const mTitle = $('m-title');
  const mArtist = $('m-artist');
  const mEqBars = $('m-eq-bars');

  const prevPlaying = !!appState.mediaPlaying;
  const hasMedia = !!(media && media.title && media.title.trim());
  const isPlaying = !!(hasMedia && media.playing);

  appState.mediaPlaying = isPlaying;
  if (prevPlaying !== isPlaying) bus.emit('media:playback-change', isPlaying);
  $('view-media')?.classList.toggle('is-playing', isPlaying);

  if (!hasMedia) {
    clearMediaUI();
    return;
  }
  appState.cachedMedia = media;
  updateSourceBadge('m-source-badge', 'm-source-ico', 'm-source-name', media.source || '');
  if (appState.currentView === 'view-media') syncMediaAppVolume();

  const key = media.title + '|' + (media.artist || '') + '|' + (media.source || '');
  const isNewTrack = key !== appState.mediaTitleKey;
  if (isNewTrack) {
    appState.mediaDuration = media.duration > 0 ? media.duration : 0;
  } else if (media.duration > 0) {
    appState.mediaDuration = media.duration;
  }
  syncMediaTick();

  if (isPlaying) {
    if (mTitle) mTitle.textContent = media.title;
    if (mArtist) mArtist.textContent = media.artist || 'Playing on PC';
    if (playSvg) playSvg.innerHTML = '<rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/>';
    if (mEqBars) mEqBars.classList.remove('hidden');

    if (SET.notch && SET.notch.compactMode !== false) {
      if (eq) eq.classList.remove('hidden');
      if (mediaBtn) mediaBtn.classList.remove('hidden', 'paused');
    } else {
      if (eq) eq.classList.add('hidden');
      if (mediaBtn) mediaBtn.classList.add('hidden');
    }

    const now = Date.now();
    if (isNewTrack) {
      appState.mediaTitleKey = key;
      appState.loadedArtUrl = '';
      mediaBackendPos = Math.max(0, media.position || 0);
      mediaBackendTime = now;
      appState.mediaProgressSec = mediaBackendPos;
      loadMediaArt();
      setTimeout(loadMediaArt, 400);
      setTimeout(loadMediaArt, 1200);
    } else if (!prevPlaying) {
      mediaBackendPos = Math.max(0, media.position >= 0 ? media.position : (appState.mediaProgressSec || 0));
      mediaBackendTime = now;
      appState.mediaProgressSec = mediaBackendPos;
    } else if (!appState.mediaSeeking && media.position >= 0) {
      const currentExtrapolated = mediaBackendPos + Math.max(0, (now - mediaBackendTime) / 1000);
      if (Math.abs(media.position - currentExtrapolated) > 1.2) {
        mediaBackendPos = media.position;
        mediaBackendTime = now;
        appState.mediaProgressSec = mediaBackendPos;
      }
    }
    renderMediaProgress();
  } else {
    if (eq) eq.classList.add('hidden');
    if (mediaBtn) {
      mediaBtn.classList.add('hidden');
      mediaBtn.classList.add('paused');
    }
    if (mEqBars) mEqBars.classList.add('hidden');
    if (playSvg) playSvg.innerHTML = '<polygon points="6 3 20 12 6 21"/>';

    if (mTitle) mTitle.textContent = media.title;
    if (mArtist) mArtist.textContent = media.artist ? `${media.artist} (Paused)` : 'Paused on PC';
    if (isNewTrack) {
      appState.mediaTitleKey = key;
      appState.loadedArtUrl = '';
      loadMediaArt();
    }
    if (!appState.mediaSeeking && media.position >= 0) {
      mediaBackendPos = media.position;
      mediaBackendTime = Date.now();
      appState.mediaProgressSec = media.position;
    }
    renderMediaProgress();
  }

  bus.emit('media:updated', media);
  updateCompactStateClasses();
  syncEq();
}

export function initMedia() {
  const el = $('m-seek-slider');
  if (!el) return;
  el.addEventListener('input', (e) => handleSeekInput(e.target.value));
  el.addEventListener('change', (e) => handleSeekCommit(e.target.value));
}
