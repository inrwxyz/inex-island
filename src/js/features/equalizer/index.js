// Equalizer Feature
// Real 5-Band Audio Visualizer (WASAPI Loopback + FFT ~32ms Event-Driven)
import { $, $$ } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';

let cEqBars = [];
let mEqBars = [];
let lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
const currentHeightsC = [2, 2, 2, 2, 2];
const currentHeightsM = [2, 2, 2, 2, 2];
let eqRaf = 0;
let eqQuietCount = 0;
const EQ_FRAME_MS = 33;
const EQ_H_COMPACT = 12; // 2px rest + 10px range
const EQ_H_MEDIA = 20; // 2px rest + 18px range

function eqStep(bars, heights, range, H, isPlaying, sens, now, eqSync) {
  let moving = false;
  bars.forEach((bar, i) => {
    let target = 2;
    if (isPlaying) {
      if (eqSync) {
        const val = lastFrequencies[i] ?? 0.18;
        const bandBoost = i === 4 ? 1.55 : (i === 3 ? 1.35 : (i === 2 ? 1.12 : 1.0));
        const norm = Math.max(0, (val - 0.18) / 0.82) * sens * bandBoost;
        target = 2 + Math.min(1, norm) * range;
      } else {
        target = 2 + (0.55 + 0.35 * Math.sin(now / 260 + i * 1.5)) * range;
      }
    }
    const d = target - heights[i];
    if (Math.abs(d) < 0.05) {
      heights[i] = target;
    } else {
      heights[i] += d * 0.7;
      moving = true;
    }
    const sc = (heights[i] / H).toFixed(3);
    if (bar._sc !== sc) {
      bar._sc = sc;
      bar.style.transform = `scaleY(${sc})`;
    }
  });
  return moving;
}

function eqDraw() {
  eqRaf = 0;
  const view = appState.currentView;
  if (view !== 'view-compact' && view !== 'view-media') return;

  const SET = loadSettings();
  const sens = (SET.notch?.eqSensitivity || 100) / 100;
  const isPlaying = appState.mediaPlaying;
  const now = performance.now();

  if (cEqBars.length === 0) cEqBars = $$('#c-eq span');
  if (mEqBars.length === 0) mEqBars = $$('#m-eq-bars span');

  const eqSync = !!SET.notch?.eqSync;
  let moving = false;
  if (view === 'view-compact') moving = eqStep(cEqBars, currentHeightsC, 10, EQ_H_COMPACT, isPlaying, sens, now, eqSync) || moving;
  if (view === 'view-media') moving = eqStep(mEqBars, currentHeightsM, 18, EQ_H_MEDIA, isPlaying, sens, now, eqSync) || moving;

  const animating = isPlaying && !eqSync && (view === 'view-compact' || view === 'view-media');
  if (moving || animating) {
    eqRaf = setTimeout(eqDraw, EQ_FRAME_MS);
  }
}

export function eqKick() {
  if (!eqRaf) eqRaf = requestAnimationFrame(eqDraw);
}

export function syncEq() {
  const SET = loadSettings();
  const active = appState.mediaPlaying && SET.notch && SET.notch.eqSync;
  invokeTauri('set_visualizer_active', { active }).catch((err) => console.warn('Tauri invoke error:', err));
  if (!appState.mediaPlaying) lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
  eqKick();
}

export function initEqualizer() {
  cEqBars = $$('#c-eq span');
  mEqBars = $$('#m-eq-bars span');
  const eqCompact = $('c-eq');

  listenTauri('audio-visualization', (event) => {
    const view = appState.currentView;
    if (view !== 'view-compact' && view !== 'view-media') return;
    if (!appState.mediaPlaying) return;
    const SET = loadSettings();
    if (!SET.notch?.eqSync) return;

    const payload = (event && event.payload !== undefined) ? event.payload : (event || {});
    const freqs = payload.frequencies || [];
    if (freqs.length >= 5) {
      lastFrequencies = freqs;
      const avg = freqs.reduce((a, b) => a + b, 0) / freqs.length;
      if (avg > 0.20) {
        eqQuietCount = 0;
        if (eqCompact?.classList.contains('quiet')) eqCompact.classList.remove('quiet');
      } else {
        eqQuietCount++;
        if (eqQuietCount > 50 && eqCompact && !eqCompact.classList.contains('quiet')) {
          eqCompact.classList.add('quiet');
        }
      }
      eqKick();
    }
  });

  bus.on('media:playback-change', () => syncEq());
  bus.on('view:change', () => eqKick());
}
