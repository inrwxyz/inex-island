// Glass-style media card (standalone module).
// Does not touch the existing media card. It reads playback state from appState (written by features/media),
// draws its own card inside #view-media, and is switched on by the setting  notch.mediaCard === 'glass'.
import { $, island } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { invokeTauri } from '../../core/tauri.js';
import { loadSettings, onSettings } from '../../core/settings.js';
import { reportIslandSize, ISLAND_WIN_W, MEDIA_H, MEDIA_H_VOL } from '../../core/views.js';
import { fmtTime, getMediaPositionSec, handleSeekInput, handleSeekCommit } from '../media/index.js';
import { handleMediaVolumeChange } from '../volume/index.js';
import { openAudioView, refreshActiveAudioName } from '../controls/index.js';

/* ---------- source logos: change with the app the song plays from ---------- */
const SPOTIFY_PATH = 'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.34c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.18.48.66.3 1.02zm1.44-3.3c-.3.42-.84.6-1.26.3-3.24-1.98-8.16-2.58-11.94-1.38-.48.12-1.02-.12-1.14-.6-.12-.48.12-1.02.6-1.14 4.32-1.32 9.72-.66 13.44 1.62.36.18.54.78.3 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.3c-.6.18-1.2-.18-1.38-.72-.18-.6.18-1.2.72-1.38 4.26-1.26 11.28-1.02 15.72 1.62.54.3.72 1.02.42 1.56-.3.42-1.02.6-1.56.3z';
const CHROME_SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#fbbc05"/><path d="M12 1.5A10.5 10.5 0 0 1 21.1 6.75H12a5.25 5.25 0 0 0-4.55 2.63L2.9 6.75A10.5 10.5 0 0 1 12 1.5z" fill="#ea4335"/><path d="M2.9 6.75l4.55 7.88A5.25 5.25 0 0 0 12 17.25l-4.55 5.25A10.5 10.5 0 0 1 2.9 6.75z" fill="#34a853"/><circle cx="12" cy="12" r="5.25" fill="#fff"/><circle cx="12" cy="12" r="4" fill="#4285f4"/></svg>';

export function sourceLogo(src) {
  const s = (src || '').toLowerCase();
  if (s.includes('spotify')) {
    return { cls: 'mgl-spotify', svg: `<svg viewBox="0 0 24 24"><path fill="#1ed760" d="${SPOTIFY_PATH}"/></svg>` };
  }
  if (s.includes('youtube')) {
    if (s.includes('music')) {
      return { cls: '', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#ff0033"/><circle cx="12" cy="12" r="6.2" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M10.2 9.2v5.6l4.6-2.8z" fill="#fff"/></svg>' };
    }
    return { cls: '', svg: '<svg viewBox="0 0 24 24"><rect x="1" y="4.5" width="22" height="15" rx="4.5" fill="#ff0033"/><path d="M10 9v6l5.2-3z" fill="#fff"/></svg>' };
  }
  if (s.includes('apple')) {
    return { cls: '', svg: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#fa243c"/><path d="M16 5.5v9.2a2.4 2.4 0 1 1-1.6-2.3V8.6l-5.2 1.3v6.1a2.4 2.4 0 1 1-1.6-2.3V7.2L16 5.5z" fill="#fff"/></svg>' };
  }
  if (s.includes('vlc')) {
    return { cls: '', svg: '<svg viewBox="0 0 24 24"><path d="M12 2 6.5 18h11L12 2z" fill="#ff8800"/><rect x="4" y="19" width="16" height="3" rx="1.2" fill="#ff8800"/></svg>' };
  }
  if (s.includes('chrome')) {
    return { cls: '', svg: CHROME_SVG };
  }
  if (/edge|firefox|brave|opera/.test(s)) {
    return { cls: '', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#6ea8ff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>' };
  }
  return { cls: '', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>' };
}

/* ---------- icons ---------- */
const ICO_PLAY = '<polygon points="7 4 20 12 7 20"/>';
const ICO_PAUSE = '<rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/>';

const CARD_HTML = `
  <div class="mgl-bg" id="mgl-bg"><div class="mgl-amb"></div><div class="mgl-art" id="mgl-art"></div><div class="mgl-shade"></div></div>
  <div class="mgl-head">
    <div class="mgl-src" id="mgl-src"></div>
    <div class="mgl-meta">
      <div class="mgl-head-top">
        <span class="mgl-artist-txt" id="mgl-artist">Ready</span>
        <span class="mgl-dev">This PC</span>
      </div>
      <div class="mgl-now" id="mgl-now"><div class="mgl-track" id="mgl-track"></div></div>
    </div>
  </div>
  <div class="mgl-prog" id="mgl-prog"><canvas id="mgl-wave"></canvas></div>
  <div class="mgl-times"><span id="mgl-cur">0:00</span><span id="mgl-tot">--:--</span></div>
  <div class="mgl-ctrls">
    <button class="mgl-b mgl-ghost" id="mgl-volbtn" title="Volume">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
    </button>
    <button class="mgl-b" id="mgl-prev" title="Previous">
      <svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="2.6" height="14" rx="1"/><polygon points="19 5 9 12 19 19"/></svg>
    </button>
    <button class="mgl-b mgl-play" id="mgl-play" title="Play / Pause">
      <svg id="mgl-play-svg" viewBox="0 0 24 24" fill="currentColor">${ICO_PLAY}</svg>
    </button>
    <button class="mgl-b" id="mgl-next" title="Next">
      <svg viewBox="0 0 24 24" fill="currentColor"><rect x="16.4" y="5" width="2.6" height="14" rx="1"/><polygon points="5 5 15 12 5 19"/></svg>
    </button>
    <button class="mgl-b mgl-ghost" id="mgl-devbtn" title="Sound device">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
    </button>
  </div>
  <div class="mgl-vol" id="mgl-vol">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/></svg>
    <div class="mgl-vtrack" id="mgl-vtrack"><div class="mgl-vfill" id="mgl-vfill"></div><div class="mgl-vthumb" id="mgl-vthumb"></div></div>
    <span class="mgl-vval" id="mgl-vval">0%</span>
  </div>`;

let view = null;
let card = null;
let audioView = null;
let audioBg = null;
let ready = false;

/* ---------- state ---------- */
let rafId = 0;
let lastFrame = 0;
let lastDraw = 0;
let amp = 0.12;
let phase = 0;
const PAD = 8;
let boxW = 296;
const H = 28;
const BASE_Y = 20;
let ctx = null;
let gradH1 = null;
let gradH2 = null;
let dpr = 1;
let seekDrag = false;
let seekPct = 0;
let trackKey = '';
let shownArt = null;
let shownDev = '';
let playShown = null;
let volOpen = false;
let volDrag = false;
let volTimer = 0;
let volPending = null;

const el = {};
const FRAME_STEP_MS = 32; // smooth ~30fps canvas redraw while active; stops when paused & settled

function pollSoon() {
  if (typeof window.pollSystemAndMedia === 'function') setTimeout(window.pollSystemAndMedia, 250);
}

/* ---------- settings switch ---------- */
function wantGlass() {
  const S = loadSettings();
  return !!(S && S.notch && S.notch.mediaCard === 'glass');
}

function applyStyle() {
  const on = wantGlass();
  view.classList.toggle('mgl-mode', on);
  if (card) card.hidden = !on;
  if (audioView) audioView.classList.toggle('mgl-mode', on);
  if (audioBg) audioBg.hidden = !on;
  if (island) island.classList.toggle('mgl-on', on);
  if (!on) resetVol();
  syncLoop();
}

function isShown() {
  return wantGlass() && view.classList.contains('active');
}

function needsTick() {
  return isShown() && (!!appState.mediaPlaying || seekDrag || Math.abs(amp - 0.12) > 0.015);
}

function syncLoop() {
  if (!isShown()) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (volOpen) resetVol();
    return;
  }
  const now = performance.now();
  lastFrame = now;
  lastDraw = 0;
  layoutWave();
  renderNow(now);
  if (needsTick() && !rafId) {
    rafId = requestAnimationFrame(frame);
  } else if (!needsTick() && rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

/* ---------- header: pinned corner source logo + artist on top + song title below ---------- */
function buildTrack(m) {
  const key = `${m.title}|${m.artist}|${m.source}`;
  if (key === trackKey) return;
  trackKey = key;

  const logo = sourceLogo(m.source);
  const srcCls = `mgl-src ${logo.cls}`.trim();
  if (el.src.className !== srcCls) el.src.className = srcCls;
  el.src.innerHTML = logo.svg;
  el.artist.textContent = m.artist || m.source || 'Now Playing';

  const makeTitle = () => {
    const t = document.createElement('span');
    t.className = 'mgl-title-txt';
    t.textContent = m.title || 'Not Playing';
    return t;
  };

  const first = makeTitle();
  el.now.classList.remove('mgl-scroll');
  el.track.replaceChildren(first);
  el.track.style.animation = 'none';
  requestAnimationFrame(() => {
    const w = el.now.clientWidth || el.now.offsetWidth || 210;
    const real = first.offsetWidth || first.getBoundingClientRect().width;
    if (real > w + 2) {
      el.track.replaceChildren(first, first.cloneNode(true), first.cloneNode(true));
      requestAnimationFrame(() => {
        const shift = first.offsetWidth || real;
        el.track.style.setProperty('--mgl-shift', `${-shift}px`);
        el.track.style.setProperty('--mgl-dur', `${Math.max(6, shift / 32)}s`);
        el.now.classList.add('mgl-scroll');
        el.track.style.animation = '';
      });
    } else {
      el.track.style.removeProperty('--mgl-shift');
      el.track.style.animation = '';
    }
  });
}

/* ---------- progress wave (2D canvas: zero DOM nodes, zero SVG tessellation) ---------- */
function layoutWave() {
  const curW = el.prog.clientWidth || el.prog.offsetWidth || 0;
  const w = (curW >= 260 && curW <= 312) ? curW : 296;
  const nextDpr = Math.min(2, window.devicePixelRatio || 1);
  if (w !== boxW || nextDpr !== dpr || !ctx) {
    boxW = w;
    dpr = nextDpr;
    el.wave.width = Math.round(boxW * dpr);
    el.wave.height = Math.round(H * dpr);
    ctx = el.wave.getContext('2d');
    if (ctx) {
      gradH1 = ctx.createLinearGradient(0, 0, 0, BASE_Y);
      gradH1.addColorStop(0, 'rgba(255, 111, 184, .16)');
      gradH1.addColorStop(1, 'rgba(255, 45, 149, .75)');
      gradH2 = ctx.createLinearGradient(0, 0, 0, BASE_Y);
      gradH2.addColorStop(0, 'rgba(255, 214, 236, .10)');
      gradH2.addColorStop(1, 'rgba(255, 155, 208, .55)');
    }
  }
}

function drawHill(span, a, k, speed, sh, fill) {
  if (span <= 2) return;
  ctx.beginPath();
  ctx.moveTo(PAD, BASE_Y);
  for (let i = 0; i <= span; i += 3) {
    const e = Math.pow(Math.sin(Math.PI * i / span), 1.4);
    const h = e * a * (0.55 + 0.45 * Math.sin(i / k + phase * speed + sh)) * (0.7 + 0.3 * Math.sin(i / (k * 2.3) - phase * 0.6));
    ctx.lineTo(PAD + i, BASE_Y - 3 - Math.max(0, h));
  }
  ctx.lineTo(PAD + span, BASE_Y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function currentPos() {
  const dur = appState.mediaDuration || 0;
  if (seekDrag) return seekPct * dur;
  return getMediaPositionSec();
}

function drawWave(pos) {
  if (!ctx) return;
  const dur = appState.mediaDuration || 0;
  const frac = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
  const trackW = Math.max(40, boxW - PAD * 2);
  const span = Math.max(0, Math.min(trackW, trackW * frac));
  const cx = PAD + span;
  const A = amp * 13;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boxW, H);

  // Remaining track
  ctx.beginPath();
  ctx.moveTo(cx, BASE_Y);
  ctx.lineTo(PAD + trackW, BASE_Y);
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = 'rgba(255, 255, 255, .38)';
  ctx.stroke();

  // Animated sine-wave hills behind thumb
  drawHill(span, A * 0.72, 19, -1.4, 1.7, gradH2);
  drawHill(span, A, 26, 1.0, 0, gradH1);

  // Active pink bar
  ctx.beginPath();
  ctx.moveTo(PAD, BASE_Y);
  ctx.lineTo(cx, BASE_Y);
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = '#ff1f8f';
  ctx.stroke();

  // Glow halo (padded inside canvas bounds so edges never clip)
  ctx.beginPath();
  ctx.arc(cx, BASE_Y, 10, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 31, 143, .28)';
  ctx.fill();

  // Thumb
  ctx.beginPath();
  ctx.arc(cx, BASE_Y, 6.2, 0, Math.PI * 2);
  ctx.fillStyle = '#ff1f8f';
  ctx.fill();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = '#fff';
  ctx.stroke();

  const c = fmtTime(pos);
  if (el.cur.textContent !== c) el.cur.textContent = c;
  const t = dur > 0 ? `-${fmtTime(dur - pos)}` : '--:--';
  if (el.tot.textContent !== t) el.tot.textContent = t;
}

/* ---------- art & labels (only update DOM when values actually change) ---------- */
function syncArt() {
  const url = appState.loadedArtUrl || '';
  if (url === shownArt) return;
  shownArt = url;
  const bg = url ? `url(${JSON.stringify(url)})` : '';
  el.art.style.backgroundImage = bg;
  if (el.bg) el.bg.classList.toggle('mgl-has-art', !!url);
  if (el.audioArt) el.audioArt.style.backgroundImage = bg;
  if (el.audioBgInner) el.audioBgInner.classList.toggle('mgl-has-art', !!url);
}

function syncDevLabel() {
  const devName = appState.activeAudioName || 'This PC';
  if (devName !== shownDev && el.dev) {
    shownDev = devName;
    el.dev.textContent = devName;
  }
}

function syncPlayIcon() {
  const playing = !!appState.mediaPlaying;
  if (playing === playShown) return;
  playShown = playing;
  el.playSvg.innerHTML = playing ? ICO_PAUSE : ICO_PLAY;
}

function renderNow() {
  const m = appState.cachedMedia;
  if (m) buildTrack(m);
  syncDevLabel();
  syncArt();
  syncPlayIcon();
  drawWave(currentPos());
}

function frame(now) {
  rafId = 0;
  if (!isShown()) return;
  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
  lastFrame = now;
  const targetAmp = appState.mediaPlaying ? 1 : 0.12;
  amp += (targetAmp - amp) * Math.min(1, dt * 5);
  phase += dt * (1.2 + amp * 2.6);

  if (!lastDraw || (now - lastDraw) >= FRAME_STEP_MS) {
    lastDraw = now;
    renderNow();
  }
  if (needsTick()) {
    rafId = requestAnimationFrame(frame);
  } else {
    renderNow();
  }
}

/* ---------- seek (drag on the wave) ---------- */
function seekFromEvent(e) {
  const r = el.prog.getBoundingClientRect();
  const trackW = Math.max(1, r.width - PAD * 2);
  seekPct = Math.min(1, Math.max(0, (e.clientX - r.left - PAD) / trackW));
  handleSeekInput(Math.round(seekPct * 1000));
  renderNow(performance.now());
}

function wireSeek() {
  el.prog.addEventListener('pointerdown', (e) => {
    if (!(appState.mediaDuration > 0)) return;
    seekDrag = true;
    el.prog.setPointerCapture(e.pointerId);
    seekFromEvent(e);
    syncLoop();
  });
  el.prog.addEventListener('pointermove', (e) => { if (seekDrag) seekFromEvent(e); });
  const end = () => {
    if (!seekDrag) return;
    seekDrag = false;
    handleSeekCommit(Math.round(seekPct * 1000));
    syncLoop();
  };
  el.prog.addEventListener('pointerup', end);
  el.prog.addEventListener('pointercancel', end);
}

/* ---------- volume: open on click, closes the moment the mouse leaves the card ---------- */
function setVolUI(level) {
  const v = Math.round(Math.min(100, Math.max(0, level)));
  el.vfill.style.width = `${v}%`;
  el.vthumb.style.left = `${v}%`;
  el.vval.textContent = `${v}%`;
  el.volBtn.classList.toggle('mgl-muted', v === 0);
}

async function pullVol() {
  const source = (appState.cachedMedia && appState.cachedMedia.source) || '';
  try {
    const v = await invokeTauri('get_media_app_volume', { source });
    if (typeof v === 'number') setVolUI(v);
  } catch (err) {
    console.warn('[media-glass] get_media_app_volume failed:', err);
  }
}

function setVolOpen(open) {
  if (volOpen === open) return;
  volOpen = open;
  appState.volOpen = open;
  if (island) island.classList.toggle('vol-open', open);
  card.classList.toggle('mgl-vol-open', open);
  el.volBtn.classList.toggle('mgl-on', open);
  reportIslandSize({ width: ISLAND_WIN_W, height: open ? MEDIA_H_VOL : MEDIA_H });
  if (open) pullVol();
}

// used when the card is switched off / hidden: no window resize, the view change already handles it
function resetVol() {
  volOpen = false;
  volDrag = false;
  appState.volOpen = false;
  if (island) island.classList.remove('vol-open');
  card.classList.remove('mgl-vol-open');
  el.volBtn.classList.remove('mgl-on');
}

function sendVol(level) {
  volPending = level;
  if (volTimer) return;
  volTimer = setTimeout(() => {
    volTimer = 0;
    if (volPending !== null) handleMediaVolumeChange(volPending);
    volPending = null;
  }, 60);
}

function wireVolume() {
  el.volBtn.addEventListener('click', () => setVolOpen(!volOpen));

  const setFromEvent = (e) => {
    const r = el.vtrack.getBoundingClientRect();
    const v = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    setVolUI(v);
    sendVol(Math.round(v));
  };
  el.vtrack.addEventListener('pointerdown', (e) => {
    volDrag = true;
    el.vtrack.setPointerCapture(e.pointerId);
    setFromEvent(e);
  });
  el.vtrack.addEventListener('pointermove', (e) => { if (volDrag) setFromEvent(e); });
  const end = () => {
    if (!volDrag) return;
    volDrag = false;
    if (!card.matches(':hover')) setVolOpen(false);
  };
  el.vtrack.addEventListener('pointerup', end);
  el.vtrack.addEventListener('pointercancel', end);

  card.addEventListener('mouseleave', () => {
    if (!volDrag) setVolOpen(false);
  });
}

/* ---------- init ---------- */
export function initGlassMedia() {
  if (ready) return;
  view = $('view-media');
  if (!view) return;
  ready = true;

  card = document.createElement('div');
  card.className = 'mgl-card';
  card.id = 'mgl-card';
  card.innerHTML = CARD_HTML;
  view.appendChild(card);

  audioView = $('view-audio');
  if (audioView) {
    audioBg = document.createElement('div');
    audioBg.className = 'mgl-audio-bg';
    audioBg.id = 'mgl-audio-bg';
    audioBg.innerHTML = '<div class="mgl-bg" id="mgl-audio-bg-inner"><div class="mgl-amb"></div><div class="mgl-art" id="mgl-audio-art"></div><div class="mgl-shade"></div></div>';
    audioView.prepend(audioBg);
    el.audioBgInner = $('mgl-audio-bg-inner');
    el.audioArt = $('mgl-audio-art');
  }

  el.bg = $('mgl-bg');
  el.art = $('mgl-art');
  el.src = $('mgl-src');
  el.artist = $('mgl-artist');
  el.now = $('mgl-now');
  el.track = $('mgl-track');
  el.prog = $('mgl-prog');
  el.wave = $('mgl-wave');
  el.cur = $('mgl-cur');
  el.tot = $('mgl-tot');
  el.dev = card.querySelector('.mgl-dev');
  el.playSvg = $('mgl-play-svg');
  el.volBtn = $('mgl-volbtn');
  el.vtrack = $('mgl-vtrack');
  el.vfill = $('mgl-vfill');
  el.vthumb = $('mgl-vthumb');
  el.vval = $('mgl-vval');

  layoutWave();
  setVolUI(70);
  wireSeek();
  wireVolume();

  $('mgl-play').addEventListener('click', async (e) => {
    e.stopPropagation();
    await invokeTauri('media_play_pause');
    pollSoon();
  });
  $('mgl-next').addEventListener('click', async (e) => {
    e.stopPropagation();
    await invokeTauri('media_next');
    pollSoon();
  });
  $('mgl-prev').addEventListener('click', async (e) => {
    e.stopPropagation();
    await invokeTauri('media_prev');
    pollSoon();
  });
  $('mgl-devbtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openAudioView();
  });

  new MutationObserver(syncLoop).observe(view, { attributes: true, attributeFilter: ['class'] });
  if (audioView) {
    new MutationObserver(() => { if (audioView.classList.contains('active')) syncArt(); }).observe(audioView, { attributes: true, attributeFilter: ['class'] });
  }
  bus.on('media:playback-change', () => {
    if (isShown()) syncLoop();
  });
  bus.on('audio:device-updated', syncDevLabel);
  bus.on('media:updated', () => {
    if (isShown()) syncLoop();
  });
  bus.on('media:tick', () => {
    if (!isShown()) return;
    if (!lastDraw || (performance.now() - lastDraw) >= 220) {
      if (appState.mediaPlaying) {
        amp = 1;
        phase += 0.55;
      }
      lastDraw = performance.now();
      renderNow();
    }
    if (needsTick() && !rafId) rafId = requestAnimationFrame(frame);
  });
  onSettings(applyStyle);
  refreshActiveAudioName();
  applyStyle();
}
