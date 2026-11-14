document.getElementById('tile-p2p')?.addEventListener('click', () => {
  openP2PView();
});
document.getElementById('tile-tray').addEventListener('click', openTrayView);

document.querySelectorAll('.back-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    openControlMenu();
  });
});

function applyRadio(kind, on) {
  if (kind === 'wifi') {
    appState.wifiRadio = on;
    document.getElementById('tile-wifi').classList.toggle('active', on);
    if (!on) document.getElementById('wifi-sub').textContent = 'Off';
    document.getElementById('wifi-master-toggle').checked = on;
    const macTile = document.getElementById('mac-tile-wifi');
    const macSub = document.getElementById('mac-wifi-sub');
    if (macTile) macTile.classList.toggle('active', on);
    if (macSub) {
      if (!on) macSub.textContent = 'Off';
      else if (appState.stats && appState.stats.wifi_name && appState.stats.wifi_name !== 'Not connected') macSub.textContent = appState.stats.wifi_name;
      else macSub.textContent = 'On';
    }
  } else {
    appState.btRadio = on;
    document.getElementById('tile-bt').classList.toggle('active', on);
    document.getElementById('bt-sub').textContent = on ? 'On' : 'Off';
    document.getElementById('bt-master-toggle').checked = on;
    const macTile = document.getElementById('mac-tile-bt');
    const macSub = document.getElementById('mac-bt-sub');
    if (macTile) macTile.classList.toggle('active', on);
    if (macSub && !on) macSub.textContent = 'Off';
    else if (macSub && on && macSub.textContent === 'Off') macSub.textContent = 'On';
  }
}

async function toggleRadio(kind, on) {
  applyRadio(kind, on);
  try {
    await invokeTauri('set_radio_state', { kind, on });
  } catch (err) {
    console.warn('radio toggle failed', err);
  }
  const real = await invokeTauri('get_radio_state', { kind });
  if (typeof real === 'boolean') applyRadio(kind, real);
  if (kind === 'wifi' && appState.currentView === 'view-wifi') setTimeout(loadWifiList, on ? 2000 : 0);
}

document.getElementById('wifi-master-toggle').addEventListener('change', (e) => toggleRadio('wifi', e.target.checked));
document.getElementById('bt-master-toggle').addEventListener('change', async (e) => {
  await toggleRadio('bt', e.target.checked);
  if (appState.currentView === 'view-bt') setTimeout(loadBtList, e.target.checked ? 1500 : 0);
});

// 5. Dynamic Quick Action Row
const ACTION_TILE_ICONS = {
  awake: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  snip: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  timer: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><line x1="9" y1="2" x2="15" y2="2"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83 2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  alarm: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  calc: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M8 18h.01M12 18h.01"/></svg>',
  restart: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  notepad: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8z"/><path d="M15 3v5h5"/><path d="M8 13h8M8 17h5"/></svg>',
  drop: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M12 2v10M8 8l4-4 4 4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>'
};

const ACTION_TILE_TITLES = {
  awake: 'Keep screen awake: off',
  snip: 'Screenshot Snip',
  calendar: 'Monthly Calendar',
  timer: 'Focus Timer',
  clipboard: 'Clipboard History',
  lock: 'Lock PC',
  settings: 'Open Settings',
  alarm: 'Alarm',
  calc: 'Calculator',
  restart: 'Restart Inex Island',
  notepad: 'Quick Notes',
  drop: 'Inex Drop'
};

let awakeState = false;

// Keep-awake button exists in both menus (Classic tile row + Mac top bar): keep both in step
function syncAwakeUi() {
  const title = awakeState ? 'Keep screen awake: ON' : 'Keep screen awake: off';
  ['act-awake', 'mac-awake-btn'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active', awakeState);
    el.title = title;
  });
}

function renderQuickActionTiles() {
  const row = document.getElementById('quick-icons-row');
  if (!row) return;
  const list = (SET.menu && Array.isArray(SET.menu.actionTiles) && SET.menu.actionTiles.length)
    ? SET.menu.actionTiles
    : ['awake', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'settings'];

  row.innerHTML = '';
  list.slice(0, 7).forEach((id) => {   // the row fits 7 circles at most
    const ico = ACTION_TILE_ICONS[id];
    const title = ACTION_TILE_TITLES[id] || id;
    if (!ico) return;

    const btn = document.createElement('button');
    btn.className = 'q-icon-btn';
    btn.id = `act-${id}`;
    btn.title = title;
    btn.innerHTML = ico;

    if (id === 'awake') {
      btn.classList.toggle('active', awakeState);
      btn.title = awakeState ? 'Keep screen awake: ON' : 'Keep screen awake: off';
      btn.addEventListener('click', async () => {
        const want = !awakeState;
        const on = await invokeTauri('set_keep_awake', { on: want });
        awakeState = on === true;
        syncAwakeUi();
      });
    } else if (id === 'snip') {
      btn.addEventListener('click', () => {
        goCompact();
        invokeTauri('take_snip');
      });
    } else if (id === 'calendar') {
      btn.addEventListener('click', () => {
        switchView('view-calendar', 'state-sub', 316, 225);
        if (typeof renderCalendarGrid === 'function') renderCalendarGrid();
      });
    } else if (id === 'timer') {
      btn.addEventListener('click', () => {
        switchView('view-timer', 'state-sub', 316, 200);
      });
    } else if (id === 'alarm') {
      btn.addEventListener('click', () => {
        switchView('view-alarm', 'state-sub', 316, 238);
        if (typeof openAlarmView === 'function') openAlarmView();
      });
    } else if (id === 'clipboard') {
      btn.addEventListener('click', () => {
        switchView('view-clipboard', 'state-sub', ISLAND_WIN_W, 260);
        if (typeof openClipboardView === 'function') openClipboardView();
      });
    } else if (id === 'lock') {
      btn.addEventListener('click', () => invokeTauri('lock_screen'));
    } else if (id === 'settings') {
      btn.addEventListener('click', () => invokeTauri('open_settings'));
    } else if (id === 'restart') {
      btn.addEventListener('click', () => invokeTauri('restart_app'));
    } else if (id === 'notepad') {
      btn.addEventListener('click', () => {
        switchView('view-notepad', 'state-sub', 316, 240);
        if (typeof focusNotepad === 'function') focusNotepad();
      });
    } else if (id === 'drop') {
      btn.addEventListener('click', () => {
        if (typeof openDropView === 'function') openDropView();
      });
    } else {
      btn.addEventListener('click', () => {
        invokeTauri('launch_quick_action', { id });
      });
    }

    row.appendChild(btn);
  });
}

// 6. Volume & Brightness Sliders
function setVolumeUI(level) {
  const valEl = document.getElementById('val-vol');
  if (valEl) valEl.textContent = `${level}%`;
  const s = document.getElementById('slider-vol');
  if (s) {
    s.value = level;
    s.style.setProperty('--val', `${level}%`);
  }
  const ms = document.getElementById('m-vol-slider');
  if (ms) {
    ms.value = level;
    ms.style.setProperty('--val', `${level}%`);
  }
  const macVal = document.getElementById('mac-val-vol');
  if (macVal) macVal.textContent = `${level}%`;
  const macSlider = document.getElementById('mac-slider-vol');
  if (macSlider) macSlider.value = level;
  appState.lastVolume = level;
}
function handleVolumeChange(newVal) {
  const level = parseInt(newVal, 10);
  setVolumeUI(level);
  invokeTauri('set_system_volume', { level });
}
document.getElementById('m-vol-toggle').addEventListener('click', () => {
  appState.volOpen = !appState.volOpen;
  island.classList.toggle('vol-open', appState.volOpen);
  document.getElementById('m-vol-toggle').classList.toggle('muted-ico', !appState.volOpen);
  reportIslandSize({ width: ISLAND_WIN_W, height: appState.volOpen ? MEDIA_H_VOL : MEDIA_H });
});
document.getElementById('m-bt-btn').addEventListener('click', () => openAudioView());
invokeTauri('get_system_volume').then((v) => { if (typeof v === 'number') setVolumeUI(v); });

document.getElementById('slider-vol').addEventListener('input', (e) => handleVolumeChange(e.target.value));
document.getElementById('mac-slider-vol')?.addEventListener('input', (e) => handleVolumeChange(e.target.value));
document.getElementById('m-vol-slider').addEventListener('input', (e) => handleVolumeChange(e.target.value));

function syncBrightTextAndApply(level, commit) {
  const n = parseInt(level, 10);
  const vEl = document.getElementById('val-bright');
  if (vEl) vEl.textContent = `${n}%`;
  const s = document.getElementById('slider-bright');
  if (s) {
    s.value = n;
    s.style.setProperty('--val', `${n}%`);
  }
  const mvEl = document.getElementById('mac-val-bright');
  if (mvEl) mvEl.textContent = `${n}%`;
  const ms = document.getElementById('mac-slider-bright');
  if (ms) ms.value = n;
  if (commit) invokeTauri('set_system_brightness', { level: n });
}

document.getElementById('slider-bright').addEventListener('change', (e) => syncBrightTextAndApply(e.target.value, true));
document.getElementById('slider-bright').addEventListener('input', (e) => syncBrightTextAndApply(e.target.value, false));
document.getElementById('mac-slider-bright')?.addEventListener('change', (e) => syncBrightTextAndApply(e.target.value, true));
document.getElementById('mac-slider-bright')?.addEventListener('input', (e) => syncBrightTextAndApply(e.target.value, false));
// Brightness follows Windows (Fn keys, quick settings, auto-brightness) through an event, no polling
function setBrightUI(level) {
  if (typeof level !== 'number') return;
  const s = document.getElementById('slider-bright');
  if (s) {
    if (s.dataset.drag !== '1') s.value = level;
    s.style.setProperty('--val', `${level}%`);
  }
  const valEl = document.getElementById('val-bright');
  if (valEl) valEl.textContent = `${level}%`;
  const ms = document.getElementById('mac-slider-bright');
  if (ms && ms.dataset.drag !== '1') ms.value = level;
  const mvEl = document.getElementById('mac-val-bright');
  if (mvEl) mvEl.textContent = `${level}%`;
}
document.getElementById('slider-bright').addEventListener('pointerdown', (e) => { e.target.dataset.drag = '1'; });
document.getElementById('mac-slider-bright')?.addEventListener('pointerdown', (e) => { e.target.dataset.drag = '1'; });
window.addEventListener('pointerup', () => {
  const s = document.getElementById('slider-bright'); if (s) s.dataset.drag = '';
  const ms = document.getElementById('mac-slider-bright'); if (ms) ms.dataset.drag = '';
});
onTauriEvent('brightness-changed', (e) => setBrightUI(e && e.payload));
invokeTauri('get_system_brightness').then(setBrightUI);
setTimeout(() => invokeTauri('get_system_brightness').then(setBrightUI), 5000);

// Mac in-place subview management (keeps 500x210 locked, zero window resize or jitter)
currentMacSubTarget = null;
function openMacSub(viewId, title, from) {
  if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
  closeMacSub();
  const src = document.getElementById(viewId);
  const mount = document.getElementById('mac-sub-mount');
  const actionsSlot = document.getElementById('mac-sub-actions');
  if (!src || !mount) return;
  currentMacSubTarget = { id: viewId, parent: src.parentNode, next: src.nextSibling };
  mount.appendChild(src);
  src.classList.add('active', 'in-mac-sub');
  const titleEl = document.getElementById('mac-sub-title');
  if (titleEl) titleEl.textContent = title;

  if (actionsSlot) {
    actionsSlot.innerHTML = '';
    const headerRight = src.querySelector('.bt-header-right, .panel-top-right, .qs-header-right, .cal-nav-bar, .top-tool-btn');
    if (headerRight) {
      currentMacSubTarget.actions = headerRight;
      currentMacSubTarget.actionsParent = headerRight.parentNode;
      currentMacSubTarget.actionsNext = headerRight.nextSibling;
      actionsSlot.appendChild(headerRight);
    }
    if (viewId === 'view-p2p') mountP2PBarItems(actionsSlot);   // Generate / code / Cancel / status sit in the Back line, like Wi-Fi / Bluetooth
  }

  document.getElementById('mac-right-home')?.classList.add('hidden');
  const subPanel = document.getElementById('mac-right-sub');
  if (subPanel) {
    subPanel.classList.remove('from-bottom');
    subPanel.classList.remove('hidden');
    if (from === 'bottom') {
      const host = subPanel.parentElement;
      host.classList.add('mx-clip');                       // the panel slides in from under the bottom edge
      void subPanel.offsetWidth;
      subPanel.classList.add('from-bottom');
      setTimeout(() => host.classList.remove('mx-clip'), 420);
    }
  }

  if (viewId === 'view-wifi') {
    invokeTauri('wifi_backend', { on: true }).catch(() => {});
    if (typeof loadWifiList === 'function') loadWifiList();
  }
  if (viewId === 'view-bt') {
    invokeTauri('bt_backend', { on: true }).catch(() => {});
    invokeTauri('bt_discovery', { on: true }).catch(() => {});
    if (typeof loadBtList === 'function') loadBtList();
  }
  if (viewId === 'view-tray' && typeof updateTrayUI === 'function') updateTrayUI();
  if (viewId === 'view-calendar' && typeof renderCalendarGrid === 'function') renderCalendarGrid();
  if (viewId === 'view-notepad' && typeof focusNotepad === 'function') focusNotepad();
  if (viewId === 'view-clipboard' && typeof openClipboardView === 'function') openClipboardView();
  if (viewId === 'view-alarm' && typeof openAlarmView === 'function') openAlarmView();
  if (viewId === 'view-inexdrop' && typeof refreshDropUI === 'function') refreshDropUI();
  if (typeof syncDropRail === 'function') syncDropRail(viewId);   // Quick Share <-> P2P side rail (only for those two views)
}

// P2P: move its option controls into the Back line (right side) and put them back on close
function mountP2PBarItems(slot) {
  const wrap = document.createElement('div');
  wrap.className = 'mx-p2p-actions';
  currentMacSubTarget.moved = [];
  ['btn-gen-code', 'code-display-box', 'p2p-expiry-timer', 'btn-exit-room', 'p2p-status-pill'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    currentMacSubTarget.moved.push({ el, parent: el.parentNode, next: el.nextSibling });
    wrap.appendChild(el);
  });
  slot.appendChild(wrap);
}

function closeMacSub() {
  if (!currentMacSubTarget) return;
  const el = document.getElementById(currentMacSubTarget.id);
  if (currentMacSubTarget.moved) {
    for (let i = currentMacSubTarget.moved.length - 1; i >= 0; i--) {
      const m = currentMacSubTarget.moved[i];
      if (m.parent) m.parent.insertBefore(m.el, m.next);
    }
  }
  if (currentMacSubTarget.actions && currentMacSubTarget.actionsParent) {
    currentMacSubTarget.actionsParent.insertBefore(currentMacSubTarget.actions, currentMacSubTarget.actionsNext);
  }
  const actionsSlot = document.getElementById('mac-sub-actions');
  if (actionsSlot) actionsSlot.innerHTML = '';
  if (el && currentMacSubTarget.parent) {
    el.classList.remove('active', 'in-mac-sub');
    currentMacSubTarget.parent.insertBefore(el, currentMacSubTarget.next);
  }
  if (currentMacSubTarget.id === 'view-bt') {
    invokeTauri('bt_discovery', { on: false });
  }
  if (currentMacSubTarget.id === 'view-clipboard' && typeof closeClipboardView === 'function') {
    closeClipboardView();
  }
  currentMacSubTarget = null;
  island.classList.remove('has-rail');
  document.getElementById('mac-right-sub')?.classList.add('hidden');
  document.getElementById('mac-right-home')?.classList.remove('hidden');
}

document.getElementById('mac-sub-back')?.addEventListener('click', () => {
  const sp = document.getElementById('mac-right-sub');
  if (sp && sp.classList.contains('from-bottom') && !sp.classList.contains('sinking')) {
    const host = sp.parentElement;
    host.classList.add('mx-clip');
    sp.classList.add('sinking');                           // goes back down the same way it came
    setTimeout(() => { sp.classList.remove('sinking'); host.classList.remove('mx-clip'); closeMacSub(); }, 210);
  } else closeMacSub();
});

// Mac 2x2 Control Center tiles
// Clicking tile body toggles power directly (just like normal mode); clicking chevron or right-click opens in-place subpanel
document.getElementById('mac-tile-wifi')?.addEventListener('click', (e) => {
  if (e.target.closest('.mx-tile-chev')) openMacSub('view-wifi', 'Wi-Fi');
  else toggleRadio('wifi', !appState.wifiRadio);
});
document.getElementById('mac-tile-wifi')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMacSub('view-wifi', 'Wi-Fi');
});

document.getElementById('mac-tile-bt')?.addEventListener('click', (e) => {
  if (e.target.closest('.mx-tile-chev')) openMacSub('view-bt', 'Bluetooth');
  else toggleRadio('bt', !appState.btRadio);
});
document.getElementById('mac-tile-bt')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMacSub('view-bt', 'Bluetooth');
});

// Same as the classic tile: Quick Share selected = left click anywhere on the tile turns it on / off.
// Only the chevron, an incoming offer / running transfer, or P2P mode (no on/off) goes inside. Right click always goes inside.
document.getElementById('mac-tile-drop')?.addEventListener('click', (e) => {
  if (currentOffer || inTransfer || e.target.closest('.mx-tile-chev')) {
    openMacDrop();
  } else {
    dropTileClick();
  }
});
document.getElementById('mac-tile-drop')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMacDrop();
});

document.getElementById('mac-tray-btn')?.addEventListener('click', () => {
  if (macTrayPaneOpen()) closeMacTrayPane();   // tray icon again = back to the menu
  else openMacTrayView(false);
});

// Mac Quick Actions strip: open right in place inside Control Deck
document.querySelectorAll('#mac-quick-row .mx-q').forEach((btn) => {
  btn.addEventListener('click', () => {
    const act = btn.dataset.action;
    if (act === 'notepad') openMacSub('view-notepad', 'Quick Notes', 'bottom');
    else if (act === 'clipboard') openMacSub('view-clipboard', 'Clipboard', 'bottom');
    else if (act === 'timer') openMacSub('view-timer', 'Focus Timer', 'bottom');
    else if (act === 'alarm') openMacSub('view-alarm', 'Alarm', 'bottom');
    else if (act === 'calendar') openMacSub('view-calendar', 'Calendar', 'bottom');
  });
});

// 7. Audio Output Switcher (Headphones / Speakers)
let lastAudioOrigin = 'view-media';

function openAudioView() {
  lastAudioOrigin = (appState.currentView === 'view-media') ? 'view-media' : 'view-control';
  switchView('view-audio', 'state-sub', 316, 215);
  loadAudioDeviceList();
}

document.getElementById('audio-back-btn')?.addEventListener('click', () => {
  if (lastAudioOrigin === 'view-media' && appState.mediaPlaying) {
    openMedia();
  } else {
    openControlMenu();
  }
});

document.getElementById('btn-refresh-audio')?.addEventListener('click', () => loadAudioDeviceList(true));
document.getElementById('btn-more-audio')?.addEventListener('click', () => invokeTauri('open_sound_settings'));

async function loadAudioDeviceList(spin) {
  const listEl = document.getElementById('audio-device-list');
  const refBtn = document.getElementById('btn-refresh-audio');
  if (!listEl) return;
  if (spin && refBtn) refBtn.classList.add('spin');
  listEl.innerHTML = '<div class="empty-hint">Scanning audio outputs…</div>';

  try {
    const devices = await invokeTauri('get_audio_devices');
    if (spin && refBtn) setTimeout(() => refBtn.classList.remove('spin'), 400);

    if (!Array.isArray(devices) || devices.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">No audio outputs detected</div>';
      return;
    }

    listEl.innerHTML = '';
    devices.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'list-row-item' + (d.is_default ? ' on active-audio' : '');

      const lower = d.name.toLowerCase();
      let icoSvg = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      if (lower.includes('headphone') || lower.includes('buds') || lower.includes('airpod') || lower.includes('headset') || lower.includes('earphone')) {
        icoSvg = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
      }

      const ico = document.createElement('span');
      ico.className = 'dev-ico';
      ico.innerHTML = icoSvg;

      const text = document.createElement('div');
      text.className = 'row-text';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = d.name;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = d.is_default ? 'Active Output' : 'Tap to switch';
      text.append(name, sub);

      const statusBadge = document.createElement('div');
      statusBadge.className = 'audio-check-badge';
      statusBadge.innerHTML = d.is_default
        ? '<svg viewBox="0 0 24 24" width="13" height="13" stroke="#22c55e" stroke-width="2.5" fill="none"><polyline points="20 6 9 17 4 12"/></svg>'
        : '';

      row.append(ico, text, statusBadge);

      row.addEventListener('click', async () => {
        if (d.is_default) return;
        sub.textContent = 'Switching…';
        await invokeTauri('set_default_audio_device', { id: d.id });
        setTimeout(() => {
          if (appState.currentView === 'view-audio') loadAudioDeviceList();
        }, 200);
      });

      listEl.appendChild(row);
    });
  } catch (err) {
    if (spin && refBtn) refBtn.classList.remove('spin');
    listEl.innerHTML = '<div class="empty-hint">Failed to load audio devices</div>';
  }
}

