// Spotlight: turns the typed text into a URL and hands it to the chosen browser.
// This only sends the page to that browser. It never changes the system default browser.
import { hasTauri, invokeTauri } from '../../core/tauri.js';

export const SEARCH_URL = 'https://www.google.com/search?q=';

export function resolveTarget(raw) {
  const q = String(raw || '').trim();
  if (!q) return '';
  if (/^https?:\/\/\S+$/i.test(q)) return q;
  if (/^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(q)) return `https://${q}`;
  return SEARCH_URL + encodeURIComponent(q);
}

// Resolves true when the query was handed to a browser.
export async function openInBrowser(browserId, raw) {
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
