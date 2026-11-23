// Spotlight: browser catalog (logos, brand colours) + one-time detection of what is installed on this PC.
import { tryInvoke } from '../../core/tauri.js';

const STORE_KEY = 'inex.spotlight.browser';

export const BROWSERS = [
  { id: 'chrome', name: 'Chrome', color: '#4285F4' },
  { id: 'edge', name: 'Edge', color: '#0EA5C6' },
  { id: 'firefox', name: 'Firefox', color: '#FF7139' },
  { id: 'brave', name: 'Brave', color: '#FB542B' },
  { id: 'opera', name: 'Opera', color: '#FF1B2D' },
  { id: 'vivaldi', name: 'Vivaldi', color: '#EF3939' }
];

export function browserById(id) {
  return BROWSERS.find((b) => b.id === id) || null;
}

// Logo markup is styled in spotlight.css (.sp-logo.sp-<id>), true brand colours only.
export function logoHtml(id) {
  return `<span class="sp-logo sp-${id}" aria-hidden="true"><i></i><b></b></span>`;
}

let detecting = null;

// Runs the native detection exactly once per app start; every later call reuses that result. Never throws.
export function detectInstalled() {
  if (!detecting) {
    detecting = tryInvoke('spotlight_detect_browsers').then((found) => {
      const ids = new Set(Array.isArray(found) ? found.map((f) => f.id) : []);
      return BROWSERS.filter((b) => ids.has(b.id));
    });
  }
  return detecting;
}

export function loadChoice() {
  try {
    return localStorage.getItem(STORE_KEY) || '';
  } catch {
    return '';
  }
}

export function saveChoice(id) {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    /* storage unavailable: the choice just won't persist */
  }
}
