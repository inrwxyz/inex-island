// Brightness Feature: handles brightness sliders and Windows sync
import { $ } from '../../core/dom.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';

export function syncBrightTextAndApply(level: string | number, commit: boolean): void {
  const n = parseInt(String(level), 10);
  const vEl = $('val-bright');
  if (vEl) vEl.textContent = `${n}%`;
  const s = $('slider-bright') as HTMLInputElement | null;
  if (s) {
    s.value = String(n);
    s.style.setProperty('--val', `${n}%`);
  }
  const mvEl = $('deck-val-bright');
  if (mvEl) mvEl.textContent = `${n}%`;
  const ms = $('deck-slider-bright') as HTMLInputElement | null;
  if (ms) ms.value = String(n);
  if (commit) invokeTauri('set_system_brightness', { level: n });
}

export function setBrightUI(level: unknown): void {
  if (typeof level !== 'number') return;
  const s = $('slider-bright') as HTMLInputElement | null;
  if (s) {
    if (s.dataset.drag !== '1') s.value = String(level);
    s.style.setProperty('--val', `${level}%`);
  }
  const valEl = $('val-bright');
  if (valEl) valEl.textContent = `${level}%`;
  const ms = $('deck-slider-bright') as HTMLInputElement | null;
  if (ms && ms.dataset.drag !== '1') ms.value = String(level);
  const mvEl = $('deck-val-bright');
  if (mvEl) mvEl.textContent = `${level}%`;
}

export function initBrightness(): void {
  $('slider-bright')?.addEventListener('change', (e) => syncBrightTextAndApply((e.target as HTMLInputElement).value, true));
  $('slider-bright')?.addEventListener('input', (e) => syncBrightTextAndApply((e.target as HTMLInputElement).value, false));
  $('deck-slider-bright')?.addEventListener('change', (e) => syncBrightTextAndApply((e.target as HTMLInputElement).value, true));
  $('deck-slider-bright')?.addEventListener('input', (e) => syncBrightTextAndApply((e.target as HTMLInputElement).value, false));

  $('slider-bright')?.addEventListener('pointerdown', (e) => { (e.target as HTMLElement).dataset.drag = '1'; });
  $('deck-slider-bright')?.addEventListener('pointerdown', (e) => { (e.target as HTMLElement).dataset.drag = '1'; });
  window.addEventListener('pointerup', () => {
    const s = $('slider-bright'); if (s) s.dataset.drag = '';
    const ms = $('deck-slider-bright'); if (ms) ms.dataset.drag = '';
  });

  listenTauri<number>('brightness-changed', (e) => setBrightUI(e && e.payload));
  invokeTauri<number>('get_system_brightness').then(setBrightUI);
}
