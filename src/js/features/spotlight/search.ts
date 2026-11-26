// Spotlight: turns the typed text into a URL and hands it to the chosen browser.
import { hasTauri, invokeTauri } from '../../core/tauri.js';

export const SEARCH_URL = 'https://www.google.com/search?q=';

export function resolveTarget(raw: string): string {
  const q = String(raw || '').trim();
  if (!q) return '';
  if (/^https?:\/\/\S+$/i.test(q)) return q;
  if (/^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(q)) return `https://${q}`;
  return SEARCH_URL + encodeURIComponent(q);
}

export async function openInBrowser(browserId: string, raw: string): Promise<boolean> {
  const url = resolveTarget(raw);
  if (!url) return false;
  if (hasTauri && browserId) {
    try {
      await invokeTauri('spotlight_open', { browser: browserId, url });
      return true;
    } catch (err) {
      console.warn('[spotlight] open failed, using fallback:', err);
    }
  }
  window.open(url, '_blank', 'noopener');
  return true;
}
