// Real 5-Band Audio Visualizer (WASAPI Loopback + FFT ~32ms Event-Driven)
const cEqBars = [...document.querySelectorAll('#c-eq span')];
const mEqBars = [...document.querySelectorAll('#m-eq-bars span')];
let lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
let currentHeightsC = [2, 2, 2, 2, 2];
let currentHeightsM = [2, 2, 2, 2, 2];
// Cost notes (this is the only thing that keeps the WebView busy while music plays):
//  * bars are drawn with transform: scaleY (compositor only: no layout, no repaint);
//  * redraw at ~30 Hz, the same rate Rust sends data, with setTimeout instead of a 60-144 Hz rAF;
//  * when every bar has reached its target (silence, pause, no new data) the timer is NOT re-armed.
//    The next audio-visualization event, view change or play state change restarts it.
var eqRaf = 0; // timer id; var: referenced by refreshMedia() before this line runs
let eqQuietCount = 0;
const eqCompact = document.getElementById('c-eq');
const EQ_FRAME_MS = 33;
const EQ_H_COMPACT = 12;  // 2px rest + 10px range
const EQ_H_MEDIA = 20;    // 2px rest + 18px range

function eqKick() {
  if (!eqRaf) eqRaf = setTimeout(eqDraw, 0);
}

// Tauri event pushed by Rust WASAPI Loopback FFT worker (~32ms)
onTauriEvent('audio-visualization', (event) => {
  if (!SET.notch.eqSync || !appState.mediaPlaying) return;
  const freqs = (event.payload && event.payload.frequencies) || [];
  if (freqs.length >= 5) {
    lastFrequencies = freqs;
    const avg = freqs.reduce((a, b) => a + b, 0) / freqs.length;
    if (avg > 0.20) {
      eqQuietCount = 0;
      eqCompact.classList.remove('quiet');
    } else {
      eqQuietCount++;
      if (eqQuietCount > 50) eqCompact.classList.add('quiet');
    }
    eqKick();
  }
});

// Move one set of bars toward its targets. Returns true while anything is still moving.
function eqStep(bars, heights, range, H, isPlaying, sens, now) {
  let moving = false;
  bars.forEach((bar, i) => {
    let target = 2;
    if (isPlaying) {
      if (SET.notch.eqSync) {
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
      heights[i] += d * 0.7; // 0.45 per 60 Hz frame is about 0.7 per 30 Hz frame
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
  const sens = (SET.notch.eqSensitivity || 100) / 100;
  const isPlaying = appState.mediaPlaying;
  const now = performance.now();
  const view = appState.currentView;

  let moving = false;
  if (view === 'view-compact') moving = eqStep(cEqBars, currentHeightsC, 10, EQ_H_COMPACT, isPlaying, sens, now) || moving;
  if (view === 'view-media') moving = eqStep(mEqBars, currentHeightsM, 18, EQ_H_MEDIA, isPlaying, sens, now) || moving;

  // Without audio sync the bars run a decorative sine wave: that one needs the timer while playing.
  const animating = isPlaying && !SET.notch.eqSync && (view === 'view-compact' || view === 'view-media');
  if (moving || animating) eqRaf = setTimeout(eqDraw, EQ_FRAME_MS);
}

// Start/stop visualizer and animation loop based on playback state
function syncEq() {
  const active = appState.mediaPlaying && SET.notch && SET.notch.eqSync;
  invokeTauri('set_visualizer_active', { active }).catch(() => {});
  if (!appState.mediaPlaying) lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
  eqKick();
}

function chime() {
  invokeTauri('play_alarm_sound').catch(() => {});
}





