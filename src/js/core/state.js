// Central state store for Inex Island
import { bus } from './bus.js';

export const appState = {
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
  btRadio: true,
  wifiPresent: true,
  btPresent: true,
  alarmOpts: null,
  biometricActive: false,
  dropActive: false,
  keepOpen: false,
  deckSubId: null, // view id shown in the deck menu's in-place sub panel (null = home)
  deckTrayByDrag: false
};

export function setAppState(key, val) {
  if (appState[key] !== val) {
    const oldVal = appState[key];
    appState[key] = val;
    bus.emit(`state:${key}`, { value: val, oldValue: oldVal });
    bus.emit('state:change', { key, value: val, oldValue: oldVal });
  }
}
