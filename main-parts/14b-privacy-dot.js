// Mic in-use dot. Rust (privacy.rs) watches Windows Core Audio capture sessions and sends
//   "privacy-changed" {kind: "mic", app: "<app name>" | null}
// This part only draws the dot. Setting: overlays.privacyDot
let privMic = null;                          // name of the app using it, or null
let privLast = null;                         // last on/off value sent to Rust

function renderPrivacyDot() {
  const el = document.getElementById('c-priv');
  if (!el) return;
  const on = !!(SET.overlays && SET.overlays.privacyDot);
  const mic = on ? privMic : null;
  const micEl = el.querySelector('.mic');
  if (micEl) micEl.classList.toggle('hidden', !mic);
  el.classList.toggle('hidden', !mic);
  el.title = mic ? `Microphone: ${mic}` : '';
}

onTauriEvent('privacy-changed', (event) => {
  const p = event.payload || {};
  if (p.kind === 'mic') privMic = p.app || null;
  renderPrivacyDot();
});

// Tell Rust when the setting turns on or off (the first call also starts the watcher thread).
async function applyPrivacy() {
  const on = !!(SET.overlays && SET.overlays.privacyDot);
  if (on !== privLast) {
    privLast = on;
    try {
      const r = await invokeTauri('privacy_watch_start', { enabled: on });
      privMic = typeof r === 'string' ? r : (Array.isArray(r) ? (r[0] || null) : null);
    } catch (_) { privLast = null; }
  }
  renderPrivacyDot();
}
