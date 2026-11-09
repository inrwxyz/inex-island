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
    click: () => {
      switchView('view-notepad', 'state-sub', 316, 240);
      if (typeof focusNotepad === 'function') focusNotepad();
    }
  },
  drop: {
    el: 'tile-drop',
    start: () => {},
    stop: () => {},
    click: () => {
      if (typeof toggleInexDrop === 'function') toggleInexDrop();
      else switchView('view-inexdrop', 'state-sub', 316, 268);
    }
  },
  p2p: {
    el: 'tile-p2p',
    start: () => {},
    stop: () => {},
    click: () => switchView('view-p2p', 'state-sub', 316, 248)
  },
  tray: {
    el: 'tile-tray',
    start: () => { if (typeof updateTrayUI === 'function') updateTrayUI(); },
    stop: () => {},
    click: () => { if (typeof openTrayView === 'function') openTrayView(); }
  }
};

function applySlots() {
  let a = SET.slots && SET.slots.a;
  let b = SET.slots && SET.slots.b;
  let c = SET.slots && SET.slots.c;
  let d = SET.slots && SET.slots.d;
  if (!SLOT_DEFS[a]) a = 'wifi';
  if (!SLOT_DEFS[b]) b = 'drop';
  if (!SLOT_DEFS[c]) c = 'bt';
  if (!SLOT_DEFS[d]) d = 'tray';

  const used = new Set();
  const allDefs = Object.keys(SLOT_DEFS);
  const slots = [a, b, c, d];
  for (let i = 0; i < 4; i++) {
    if (used.has(slots[i])) {
      const alt = allDefs.find(k => !used.has(k)) || 'wifi';
      slots[i] = alt;
    }
    used.add(slots[i]);
  }
  [a, b, c, d] = slots;

  const slotMap = { [a]: 1, [b]: 2, [c]: 3, [d]: 4 };
  const want = new Set([a, b, c, d]);

  Object.entries(SLOT_DEFS).forEach(([id, def]) => {
    const tile = document.getElementById(def.el);
    if (!tile) return;
    const on = want.has(id);
    tile.classList.toggle('hidden', !on);
    if (on) {
      tile.style.order = slotMap[id];
      if (!slotRunning.has(id)) {
        slotRunning.add(id);
        def.start();
      }
    } else {
      if (slotRunning.has(id)) {
        slotRunning.delete(id);
        def.stop();
      }
    }
  });
}

// Microphone slot: real system mute of the default capture device
function renderMic(m) {
  const t = document.getElementById('tile-mic');
  if (!t) return;
  const none = m === null || m === undefined;
  t.classList.toggle('muted', m === true);
  t.classList.toggle('active', m === false);
  document.getElementById('mic-sub').textContent = none ? 'No mic' : m ? 'Muted' : 'On';
  document.getElementById('mic-cap').textContent = none ? 'No mic' : m ? 'Muted' : '';
}
async function refreshMic() {
  renderMic(await invokeTauri('get_mic_muted'));
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
  if (typeof syncLoadTimer === 'function') syncLoadTimer();
  if (typeof syncMediaTick === 'function') syncMediaTick();
  if (typeof eqKick === 'function') eqKick();

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

  if (viewId === 'view-compact' && appState.timerStartPending) {
    appState.timerStartPending = false;
    setTimeout(() => { if (appState.timerRunning && typeof showTimerStartHud === 'function') showTimerStartHud(); }, 450);
  }
}

function openMedia() {
  switchView('view-media', 'state-media', 316, appState.volOpen ? MEDIA_H_VOL : MEDIA_H);
  island.classList.toggle('vol-open', appState.volOpen);
  if (typeof renderMediaProgress === 'function') renderMediaProgress();
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
    const cClock = document.getElementById('c-clock');
    if (cClock && cClock.textContent !== str) cClock.textContent = str;
  }
  const ctrlClock = document.getElementById('ctrl-clock-tab');
  if (ctrlClock && ctrlClock.textContent !== str) ctrlClock.textContent = str;
  const calClock = document.getElementById('cal-top-clock');
  if (calClock && calClock.textContent !== str) calClock.textContent = str;
  const timerClock = document.getElementById('timer-top-clock');
  if (timerClock && timerClock.textContent !== str) timerClock.textContent = str;
}

