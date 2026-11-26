// Spotlight: browser catalog (logos, brand colours) + one-time detection of what is installed on this PC.
import { tryInvoke } from '../../core/tauri.js';

export interface BrowserInfo {
  id: string;
  name: string;
  color: string;
}

const STORE_KEY = 'inex.spotlight.browser';

export const BROWSERS: BrowserInfo[] = [
  { id: 'chrome', name: 'Chrome', color: '#4285F4' },
  { id: 'edge', name: 'Edge', color: '#0EA5C6' },
  { id: 'firefox', name: 'Firefox', color: '#FF7139' },
  { id: 'brave', name: 'Brave', color: '#FB542B' },
  { id: 'opera', name: 'Opera', color: '#FF1B2D' },
  { id: 'vivaldi', name: 'Vivaldi', color: '#EF3939' }
];

export function browserById(id: string): BrowserInfo | null {
  return BROWSERS.find((b) => b.id === id) || null;
}

export function logoHtml(id: string): string {
  return `<span class="sp-logo sp-${id}" aria-hidden="true"><i></i><b></b></span>`;
}

let detecting: Promise<BrowserInfo[]> | null = null;

export function detectInstalled(): Promise<BrowserInfo[]> {
  if (!detecting) {
    detecting = tryInvoke<Array<{ id: string }>>('spotlight_detect_browsers').then((found) => {
      const ids = new Set(Array.isArray(found) ? found.map((f) => f.id) : []);
      return BROWSERS.filter((b) => ids.has(b.id));
    });
  }
  return detecting;
}

export function loadChoice(): string {
  try {
    return localStorage.getItem(STORE_KEY) || '';
  } catch {
    return '';
  }
}

export function saveChoice(id: string): void {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    /* storage unavailable */
  }
}
