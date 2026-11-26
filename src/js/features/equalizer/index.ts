// Equalizer Feature
// Real 5-Band Audio Visualizer (WASAPI Loopback + FFT ~32ms Event-Driven)
import { $, $$, island } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';

type EqBarElement = HTMLElement & { _sc?: string };

let cEqBars: EqBarElement[] = [];
let mEqBars: EqBarElement[] = [];
let lastFrequencies: number[] = [0.18, 0.18, 0.18, 0.18, 0.18];
const currentHeightsC = [2, 2, 2, 2, 2];
const currentHeightsM = [2, 2, 2, 2, 2];
let eqRaf: number | ReturnType<typeof setTimeout> = 0;
let eqQuietCount = 0;
let lastVisualizerActive: boolean | null = null;
const EQ_FRAME_MS = 33;
const EQ_H_COMPACT = 12; // 2px rest + 10px range
const EQ_H_MEDIA = 20; // 2px rest + 18px range

function eqStep(
  bars: EqBarElement[],
  heights: number[],
  range: number,
  H: number,
  isPlaying: boolean,
  sens: number,
  now: number,
  eqSync: boolean
): boolean {
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

function eqDraw(): void {
  eqRaf = 0;
  if (document.hidden || island?.classList.contains('smart-hidden') || island?.classList.contains('intro-pre')) return;
  const view = appState.currentView;
  if (view !== 'view-compact' && view !== 'view-media') return;

  const SET = loadSettings();
  if (view === 'view-media' && SET.notch?.mediaCard !== 'classic') return;
  const sens = (SET.notch?.eqSensitivity || 100) / 100;
  const isPlaying = appState.mediaPlaying;
  const now = performance.now();

  if (cEqBars.length === 0) cEqBars = $$('#c-eq span') as EqBarElement[];
  if (mEqBars.length === 0) mEqBars = $$('#m-eq-bars span') as EqBarElement[];

  const eqSync = !!SET.notch?.eqSync;
  let moving = false;
  if (view === 'view-compact') moving = eqStep(cEqBars, currentHeightsC, 10, EQ_H_COMPACT, isPlaying, sens, now, eqSync) || moving;
  if (view === 'view-media') moving = eqStep(mEqBars, currentHeightsM, 18, EQ_H_MEDIA, isPlaying, sens, now, eqSync) || moving;

  const animating = isPlaying && !eqSync && (view === 'view-compact' || view === 'view-media');
  if (moving || animating) {
    eqRaf = setTimeout(eqDraw, EQ_FRAME_MS);
  }
}

export function eqKick(): void {
  if (!eqRaf) eqRaf = requestAnimationFrame(eqDraw);
}

export interface VisualizerWantedInput {
  mediaPlaying: boolean;
  musicMode: boolean;
  eqSync: boolean;
  compactMode: boolean;
  mediaCard: string;
  currentView: string;
  documentHidden: boolean;
  islandHidden: boolean;
  isBusy: boolean;
}

export function shouldActivateVisualizer(v: VisualizerWantedInput): boolean {
  if (!v.mediaPlaying || !v.musicMode || !v.eqSync || v.documentHidden || v.islandHidden) {
    return false;
  }
  if (v.currentView === 'view-compact') {
    return v.compactMode && !v.isBusy;
  }
  if (v.currentView === 'view-media') {
    return v.mediaCard === 'classic';
  }
  return false;
}

export function isVisualizerWanted(): boolean {
  const SET = loadSettings();
  return shouldActivateVisualizer({
    mediaPlaying: !!appState.mediaPlaying,
    musicMode: SET.notch?.musicMode !== false,
    eqSync: !!SET.notch?.eqSync,
    compactMode: SET.notch?.compactMode !== false,
    mediaCard: SET.notch?.mediaCard || 'glass',
    currentView: appState.currentView,
    documentHidden: !!document.hidden,
    islandHidden: !!(island?.classList.contains('smart-hidden') || island?.classList.contains('intro-pre')),
    isBusy: !!(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast),
  });
}

export function syncEq(): void {
  const active = isVisualizerWanted();
  if (lastVisualizerActive !== active) {
    lastVisualizerActive = active;
    invokeTauri('set_visualizer_active', { active }).catch((err) => {
      lastVisualizerActive = null;
      console.warn('Tauri invoke error:', err);
    });
  }
  if (!active) lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
  eqKick();
}

export function initEqualizer(): void {
  cEqBars = $$('#c-eq span') as EqBarElement[];
  mEqBars = $$('#m-eq-bars span') as EqBarElement[];
  const eqCompact = $('c-eq');

  listenTauri<{ frequencies?: number[] }>('audio-visualization', (event) => {
    if (!isVisualizerWanted()) return;

    const payload = (event && event.payload !== undefined) ? event.payload : (event as unknown as { frequencies?: number[] });
    const freqs = payload?.frequencies || [];
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
  bus.on('view:change', () => syncEq());
  bus.on('smart:visibility-change', () => syncEq());
  document.addEventListener('visibilitychange', () => syncEq());
  syncEq();
}
