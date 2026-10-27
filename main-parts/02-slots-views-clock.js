// ---------------------------------------------------------------------------------------
// Control-panel slots (small registry). The settings choose what sits in the two slots.
//   id      -> { el: tile element id, start(): called when the slot becomes visible,
//                stop(): called when it is swapped away }
// A slot that is not shown has its whole backend stopped (Wi-Fi: WLAN watcher closed,
// Bluetooth: all commands idle, no timers, no events).
// To add an item: add it to SLOT_OPTIONS in shared.js, add a tile in index.html and an entry here.
// ---------------------------------------------------------------------------------------
const slotRunning = new Set();
const SLOT_DEFS = {
  wifi: {
    el: 'tile-wifi',
    start: async () => { await invokeTauri('wifi_backend', { on: true }); refreshRadios(); refreshWifiNow(); },
    stop: async () => {
      await invokeTauri('wifi_backend', { on: false });
      document.getElementById('wifi-cap').textContent = '';
    }
  },
  bt: {
    el: 'tile-bt',
    start: async () => { await invokeTauri('bt_backend', { on: true }); refreshRadios(); refreshBtCaption(); },
    stop: async () => {
      await invokeTauri('bt_backend', { on: false });
      document.getElementById('bt-cap').textContent = '';
    }
  },
  mic: {
    el: 'tile-mic',
    start: () => refreshMic(),
    stop: () => {},
    click: () => toggleMic()
  },
  notepad: {
    el: 'tile-notepad',
    start: () => {},
    stop: () => {},
    click: () => invokeTauri('launch_notepad')
  }
};

function applySlots() {
  let a = SET.slots && SET.slots.a;
  let b = SET.slots && SET.slots.b;
  if (!SLOT_DEFS[a]) a = 'wifi';
  if (!SLOT_DEFS[b]) b = 'bt';
  if (a === b) b = a === 'bt' ? 'wifi' : 'bt';
  const want = new Set([a, b]);
  // grid order: slot A, P2P, slot B, Tray  (same 2x2 layout as before)
  document.getElementById('tile-p2p').style.order = 2;
  document.getElementById('tile-tray').style.order = 4;
  Object.entries(SLOT_DEFS).forEach(([id, def]) => {
    const tile = document.getElementById(def.el);
    const on = want.has(id);
    tile.classList.toggle('hidden', !on);
    if (on) tile.style.order = id === a ? 1 : 3;
    if (on && !slotRunning.has(id)) { slotRunning.add(id); def.start(); }
    if (!on && slotRunning.has(id)) { slotRunning.delete(id); def.stop(); }
  });
}

// Microphone slot: real system mute of the default capture device
async function refreshMic() {
  const m = await invokeTauri('get_mic_muted');
  const t = document.getElementById('tile-mic');
  const none = m === null || m === undefined;
  t.classList.toggle('muted', m === true);
  t.classList.toggle('active', m === false);
  document.getElementById('mic-sub').textContent = none ? 'No mic' : m ? 'Muted' : 'On';
  document.getElementById('mic-cap').textContent = none ? 'No mic' : m ? 'Muted' : '';
}
async function toggleMic() {
  const muted = document.getElementById('tile-mic').classList.contains('muted');
  await invokeTauri('set_mic_muted', { muted: !muted });
  refreshMic();
}
document.getElementById('tile-mic').addEventListener('click', () => SLOT_DEFS.mic.click());
document.getElementById('tile-notepad').addEventListener('click', () => SLOT_DEFS.notepad.click());

function updateCompactStateClasses() {
  const isPrompt = !!(appState.prompting || appState.lockerPrompting);
  const isBusy = appState.transferring || isPrompt || appState.toast;
  const hasBadges = appState.trayFiles.length > 0 || appState.peers.length > 0;
  island.classList.toggle('has-toast', !!appState.toast);
  island.classList.toggle('has-badges', hasBadges && !appState.mediaPlaying && !isBusy);
  island.classList.toggle('media-active', !!appState.mediaPlaying && !isBusy);
}

function switchView(viewId, stateClass, winWidth, winHeight) {
  appState.keepOpen = false;
  if (appState.currentView === 'view-bt' && viewId !== 'view-bt') {
    appState.btBusy = false;
    invokeTauri('bt_discovery', { on: false }); // new-device discovery only runs while the list is open
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const target = document.getElementById(viewId);
  if (target) target.classList.add('active');

  island.classList.remove(
    'state-compact', 'state-drop', 'state-control',
    'state-tray', 'state-sub', 'state-media', 'state-calendar'
  );
  island.classList.add(stateClass);
  appState.currentView = viewId;
  updateCompactStateClasses();

  const isFloating = SET.notch && SET.notch.style === 'floating';
  let effH = winHeight;
  if (isFloating) {
    if (viewId === 'view-compact') {
      effH = 48;
    } else {
      effH = winHeight + 12;
    }
  }

  invokeTauri('resize_island', { width: winWidth, height: effH });
}

function openMedia() {
  switchView('view-media', 'state-media', 316, appState.volOpen ? MEDIA_H_VOL : MEDIA_H);
  island.classList.toggle('vol-open', appState.volOpen);
  invokeTauri('get_system_volume').then((v) => { if (typeof v === 'number') setVolumeUI(v); });
}

function goCompact() {
  island.classList.remove('vol-open');
  document.getElementById('tray-peer-picker').classList.add('hidden');
  switchView('view-compact', 'state-compact', 265, 36);
}

// 1. Live Clock + Media Progress Tick
function updateClocks() {
  const now = new Date();
  let hrs = now.getHours();
  const mins = String(now.getMinutes()).padStart(2, '0');
  const ampm = hrs >= 12 ? 'pm' : 'am';
  let str;
  if (SET.general.hour24) {
    str = `${String(hrs).padStart(2, '0')}:${mins}`;
  } else {
    hrs = hrs % 12 || 12;
    str = `${String(hrs).padStart(2, '0')}:${mins} ${ampm}`;
  }

  if (!appState.timerRunning && !appState.transferring && !appState.prompting && !appState.lockerPrompting) {
    document.getElementById('c-clock').textContent = str;
  }
  document.getElementById('ctrl-clock-tab').textContent = `‹ ${str} ›`;
  document.getElementById('cal-back-clock').textContent = `‹ ${str} ›`;
}

