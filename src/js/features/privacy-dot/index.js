// Privacy Dot Feature
// Watches Windows Core Audio capture sessions and displays the mic-in-use dot
import { $ } from '../../core/dom.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { loadSettings, onSettings } from '../../core/settings.js';

let privMic = null;
let privLast = null;

export function renderPrivacyDot() {
  const el = $('c-priv');
  if (!el) return;
  const SET = loadSettings();
  const on = !!(SET.overlays && SET.overlays.privacyDot);
  const mic = on ? privMic : null;
  const micEl = el.querySelector('.mic');
  if (micEl) micEl.classList.toggle('hidden', !mic);
  el.classList.toggle('hidden', !mic);
  el.title = mic ? `Microphone: ${mic}` : '';
}

export async function applyPrivacy() {
  const SET = loadSettings();
  const on = !!(SET.overlays && SET.overlays.privacyDot);
  if (on !== privLast) {
    privLast = on;
    try {
      const r = await invokeTauri('privacy_watch_start', { enabled: on });
      privMic = typeof r === 'string' ? r : (Array.isArray(r) ? (r[0] || null) : null);
    } catch {
      privLast = null;
    }
  }
  renderPrivacyDot();
}

export function initPrivacyDot() {
  listenTauri('privacy-changed', (event) => {
    const p = (event && event.payload !== undefined) ? event.payload : (event || {});
    if (p.kind === 'mic') privMic = p.app || null;
    renderPrivacyDot();
  });

  onSettings(() => {
    applyPrivacy();
  });

  applyPrivacy();
}
