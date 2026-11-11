import { load as loadSettings, save as saveSettings, subscribe as onSettings, applyTheme } from './shared.js';

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

// WebRTC Connection Store: peerId -> { pc, dc, name, makingOffer, outgoingQueue }
const rtcPeers = new Map();

const ISLAND_WIN_W = 316;
const MEDIA_H = 166;
const MEDIA_H_VOL = 198;

async function invokeTauri(cmd, args = {}) {
  if (cmd === 'resize_island') {
    appState.lastWin = { width: args.width, height: args.height };
    const k = SET.appearance.scale / 100;
    args = { width: Math.round(args.width * k), height: Math.round(args.height * k) };
  }
  if (window.__TAURI__ && window.__TAURI__.core) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  return null;
}

