// Volume Feature: handles system volume slider, mute, and UI synchronization
import { $ } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { invokeTauri } from '../../core/tauri.js';

export function getMediaAppName() {
  const src = (appState.cachedMedia && appState.cachedMedia.source) || '';
  if (!src) return 'Volume';
  const s = src.replace(/\.exe$/i, '').trim();
  const lower = s.toLowerCase();
  if (lower.includes('spotify')) return 'Spotify';
  if (lower.includes('chrome')) return 'Chrome';
  if (lower.includes('firefox')) return 'Firefox';
  if (lower.includes('edge') || lower.includes('msedge')) return 'Edge';
  if (lower.includes('brave')) return 'Brave';
  if (lower.includes('opera')) return 'Opera';
  if (lower.includes('vlc')) return 'VLC';
  if (lower.includes('apple')) return 'Apple Music';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function setMediaVolumeUI(level) {
  const ms = $('m-vol-slider');
  if (ms) {
    ms.value = level;
    ms.style.setProperty('--vol-pct', `${level}%`);
  }
  const mVal = $('m-vol-val');
  if (mVal) {
    mVal.textContent = `${getMediaAppName()} ${level}%`;
  }
  const row = $('m-vol-row');
  if (row) {
    row.classList.toggle('vol-high', level >= 75);
    row.classList.toggle('vol-muted', level <= 8);
  }
}

export function setVolumeUI(level) {
  const valEl = $('val-vol');
  if (valEl) valEl.textContent = `${level}%`;
  const s = $('slider-vol');
  if (s) {
    s.value = level;
    s.style.setProperty('--val', `${level}%`);
  }
  const deckVal = $('deck-val-vol');
  if (deckVal) deckVal.textContent = `${level}%`;
  const deckSlider = $('deck-slider-vol');
  if (deckSlider) deckSlider.value = level;
  appState.lastVolume = level;
  if (!appState.cachedMedia || !appState.cachedMedia.source) {
    setMediaVolumeUI(level);
  }
}

export function handleVolumeChange(newVal) {
  const level = parseInt(newVal, 10);
  setVolumeUI(level);
  invokeTauri('set_system_volume', { level });
}

export function handleMediaVolumeChange(newVal) {
  const level = parseInt(newVal, 10);
  setMediaVolumeUI(level);
  const source = (appState.cachedMedia && appState.cachedMedia.source) || '';
  invokeTauri('set_media_app_volume', { source, level });
}

export async function syncMediaAppVolume() {
  const source = (appState.cachedMedia && appState.cachedMedia.source) || '';
  try {
    const level = await invokeTauri('get_media_app_volume', { source });
    if (typeof level === 'number') {
      setMediaVolumeUI(level);
    }
  } catch (err) {
    console.warn('get_media_app_volume failed:', err);
  }
}

export function initVolume() {
  $('slider-vol')?.addEventListener('input', (e) => handleVolumeChange(e.target.value));
  $('deck-slider-vol')?.addEventListener('input', (e) => handleVolumeChange(e.target.value));
  $('m-vol-slider')?.addEventListener('input', (e) => handleMediaVolumeChange(e.target.value));
  invokeTauri('get_system_volume').then((v) => {
    if (typeof v === 'number') setVolumeUI(v);
  });
}
