// Spotlight Search feature entry. Self-contained: owns its DOM, styles (spotlight.css) and Tauri commands
// (src-tauri/src/spotlight.rs). Nothing else in the app depends on it.
import { mountSpotlight } from './ui.js';

export function initSpotlight() {
  if (!mountSpotlight()) {
    document.addEventListener('DOMContentLoaded', mountSpotlight, { once: true });
  }
}
