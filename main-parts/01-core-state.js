import { load as loadSettings, save as saveSettings, subscribe as onSettings, applyTheme, menuSurface } from './shared.js';

let SET = loadSettings();
applyTheme(SET);

const CODE_TTL_MS = 3 * 60 * 1000; // a host / reply code stays valid for 3 minutes
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const island = document.getElementById('island');

const myPeerId = 'PC-' + Math.floor(10000 + Math.random() * 89999);
let myDeviceName = SET.share.deviceName || localStorage.getItem('island_pc_name') || myPeerId;

const appState = {
  currentView: 'view-compact',
  lastVolume: 75,
  trayFiles: [],
  peers: [], // Connected WebRTC peers: [{ id, name }]
  traySelect: null, // { peerId, picked:Set } while choosing which tray files to send
  draggingOut: false,
  xfer: null,
  prompting: false,
  transferring: false,
  mediaPlaying: false,
  mediaProgressSec: 0,
  mediaDuration: 0,
  mediaSeeking: false,
  mediaTitleKey: '',
  timerPresetMins: 25,
  timerSeconds: 25 * 60,
  timerRunning: false,
  timerInterval: null,
  volOpen: false,
  wifiRadio: true,
  btRadio: true
};

let currentMacSubTarget = null;
function isBtViewOpen() {
  return appState.currentView === 'view-bt' || (currentMacSubTarget && currentMacSubTarget.id === 'view-bt');
}
function isWifiViewOpen() {
  return appState.currentView === 'view-wifi' || (currentMacSubTarget && currentMacSubTarget.id === 'view-wifi');
}

// WebRTC Connection Store: peerId -> { pc, dc, name, makingOffer, outgoingQueue }
const rtcPeers = new Map();

// Nominal island width of the wide views (Mac menu, compact bar with ears): 500px menu + 2×17px ears + safety margin.
// Only used as the size reported to Rust (clickable area); the OS window itself is fixed.
const ISLAND_WIN_W = 548;
const MEDIA_H = 166;
const MEDIA_H_VOL = 198;

// The OS window is made ONE big transparent size by Rust at startup and is never resized again; the island
// animates purely in CSS. reportIslandSize() only tells Rust how big the island is (logical px x UI scale), and
// Rust uses that rectangle to let clicks pass through to the apps underneath everywhere else.
async function invokeTauri(cmd, args = {}) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  return null;
}

function reportIslandSize(size) {
  appState.islandSize = { width: size.width, height: size.height };
  const k = SET.appearance.scale / 100;
  return invokeTauri('set_island_hit', { width: Math.round(size.width * k), height: Math.round(size.height * k) }).catch(() => {});
}

function playStatusSound(category, kind) {
  const s = SET.sounds;
  if (s && s.enabled === false) return;
  if (s && category && s[category] === false) return;
  invokeTauri('play_status_sound', { kind: kind || category }).catch(() => {});
}

