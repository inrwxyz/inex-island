// Real 5-Band Audio Visualizer (WASAPI Loopback + FFT ~32ms Event-Driven)
const cEqBars = [...document.querySelectorAll('#c-eq span')];
const mEqBars = [...document.querySelectorAll('#m-eq-bars span')];
let lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
let currentHeightsC = [2, 2, 2, 2, 2];
let currentHeightsM = [2, 2, 2, 2, 2];
var eqRaf = 0; // var: referenced by refreshMedia() before this line runs
let eqQuietCount = 0;
const eqCompact = document.getElementById('c-eq');

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
  }
});

function eqDraw() {
  const sens = (SET.notch.eqSensitivity || 100) / 100;
  const isPlaying = appState.mediaPlaying;

  cEqBars.forEach((bar, i) => {
    let target = 2;
    if (isPlaying) {
      if (SET.notch.eqSync) {
        const val = lastFrequencies[i] ?? 0.18;
        const bandBoost = i === 4 ? 1.55 : (i === 3 ? 1.35 : (i === 2 ? 1.12 : 1.0));
        const norm = Math.max(0, (val - 0.18) / 0.82) * sens * bandBoost;
        target = 2 + Math.min(1, norm) * 10;
      } else {
        const t = performance.now();
        target = 2 + (0.55 + 0.35 * Math.sin(t / 260 + i * 1.5)) * 10;
      }
    }
    currentHeightsC[i] += (target - currentHeightsC[i]) * 0.45;
    bar.style.height = currentHeightsC[i].toFixed(1) + 'px';
  });

  mEqBars.forEach((bar, i) => {
    let target = 2;
    if (isPlaying) {
      if (SET.notch.eqSync) {
        const val = lastFrequencies[i] ?? 0.18;
        const bandBoost = i === 4 ? 1.55 : (i === 3 ? 1.35 : (i === 2 ? 1.12 : 1.0));
        const norm = Math.max(0, (val - 0.18) / 0.82) * sens * bandBoost;
        target = 2 + Math.min(1, norm) * 18;
      } else {
        const t = performance.now();
        target = 2 + (0.55 + 0.35 * Math.sin(t / 260 + i * 1.5)) * 18;
      }
    }
    currentHeightsM[i] += (target - currentHeightsM[i]) * 0.45;
    bar.style.height = currentHeightsM[i].toFixed(1) + 'px';
  });

  if (!isPlaying && currentHeightsC.every((h) => h < 2.1) && currentHeightsM.every((h) => h < 2.1)) {
    eqRaf = 0;
    return;
  }
  eqRaf = requestAnimationFrame(eqDraw);
}

// Start/stop visualizer and animation loop based on playback state
function syncEq() {
  const active = appState.mediaPlaying && SET.notch && SET.notch.eqSync;
  invokeTauri('set_visualizer_active', { active }).catch(() => {});
  if (appState.mediaPlaying) {
    if (!eqRaf) eqRaf = requestAnimationFrame(eqDraw);
  } else {
    lastFrequencies = [0.18, 0.18, 0.18, 0.18, 0.18];
    if (!eqRaf) eqRaf = requestAnimationFrame(eqDraw);
  }
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175, 1568].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.start(t0); o.stop(t0 + 0.55);
    });
  } catch (_) {}
}

