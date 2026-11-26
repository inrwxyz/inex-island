// Volume Feature: handles system volume slider, mute, and UI synchronization
import { $ } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { invokeTauri } from '../../core/tauri.js';

export function getMediaAppName(): string {
  const cached = appState.cachedMedia as { source?: string } | undefined;
  const src = (cached && cached.source) || '';
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

export function setMediaVolumeUI(level: number): void {
  const ms = $('m-vol-slider') as HTMLInputElement | null;
  if (ms) {
    ms.value = String(level);
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

export function setVolumeUI(level: number): void {
  const valEl = $('val-vol');
  if (valEl) valEl.textContent = `${level}%`;
  const s = $('slider-vol') as HTMLInputElement | null;
  if (s) {
    s.value = String(level);
    s.style.setProperty('--val', `${level}%`);
  }
  const deckVal = $('deck-val-vol');
  if (deckVal) deckVal.textContent = `${level}%`;
  const deckSlider = $('deck-slider-vol') as HTMLInputElement | null;
  if (deckSlider) deckSlider.value = String(level);
  appState.lastVolume = level;
  const cached = appState.cachedMedia as { source?: string } | undefined;
  if (!cached || !cached.source) {
    setMediaVolumeUI(level);
  }
}

export function handleVolumeChange(newVal: string | number): void {
  const level = parseInt(String(newVal), 10);
  setVolumeUI(level);
  invokeTauri('set_system_volume', { level });
}

export function handleMediaVolumeChange(newVal: string | number): void {
  const level = parseInt(String(newVal), 10);
  setMediaVolumeUI(level);
  const cached = appState.cachedMedia as { source?: string } | undefined;
  const source = (cached && cached.source) || '';
  invokeTauri('set_media_app_volume', { source, level });
}

export async function syncMediaAppVolume(): Promise<void> {
  const cached = appState.cachedMedia as { source?: string } | undefined;
  const source = (cached && cached.source) || '';
  try {
    const level = await invokeTauri<number>('get_media_app_volume', { source });
    if (typeof level === 'number') {
      setMediaVolumeUI(level);
    }
  } catch (err) {
    console.warn('get_media_app_volume failed:', err);
  }
}

export function initVolume(): void {
  $('slider-vol')?.addEventListener('input', (e) => handleVolumeChange((e.target as HTMLInputElement).value));
  $('deck-slider-vol')?.addEventListener('input', (e) => handleVolumeChange((e.target as HTMLInputElement).value));
  $('m-vol-slider')?.addEventListener('input', (e) => handleMediaVolumeChange((e.target as HTMLInputElement).value));
  invokeTauri<number>('get_system_volume').then((v) => {
    if (typeof v === 'number') setVolumeUI(v);
  });
}
