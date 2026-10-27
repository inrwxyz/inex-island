document.getElementById('tile-p2p').addEventListener('click', () => {
  switchView('view-p2p', 'state-sub', 316, 208);
});
document.getElementById('tile-tray').addEventListener('click', openTrayView);

document.querySelectorAll('.back-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchView('view-control', 'state-control', 316, 256);
  });
});

function applyRadio(kind, on) {
  if (kind === 'wifi') {
    appState.wifiRadio = on;
    document.getElementById('tile-wifi').classList.toggle('active', on);
    if (!on) document.getElementById('wifi-sub').textContent = 'Off';
    document.getElementById('wifi-master-toggle').checked = on;
  } else {
    appState.btRadio = on;
    document.getElementById('tile-bt').classList.toggle('active', on);
    document.getElementById('bt-sub').textContent = on ? 'On' : 'Off';
    document.getElementById('bt-master-toggle').checked = on;
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

// 5. Quick Action Row
document.getElementById('act-settings').addEventListener('click', () => invokeTauri('open_settings'));
// Keep screen awake (replaces the old Do Not Disturb button). One parked thread in Rust, 0 % CPU.
document.getElementById('act-awake').addEventListener('click', async () => {
  const btn = document.getElementById('act-awake');
  const want = !btn.classList.contains('active');
  const on = await invokeTauri('set_keep_awake', { on: want });
  btn.classList.toggle('active', on === true);
  btn.title = on === true ? 'Keep screen awake: ON' : 'Keep screen awake: off';
});
document.getElementById('act-timer').addEventListener('click', () => {
  switchView('view-calendar', 'state-calendar', 346, 210);
});
document.getElementById('act-snip').addEventListener('click', () => {
  goCompact();
  invokeTauri('take_snip');
});
document.getElementById('act-lock').addEventListener('click', () => invokeTauri('lock_screen'));

// 6. Volume & Brightness Sliders
function setVolumeUI(level) {
  document.getElementById('val-vol').textContent = `${level}%`;
  document.getElementById('slider-vol').value = level;
  document.getElementById('m-vol-slider').value = level;
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
  invokeTauri('resize_island', { width: 316, height: appState.volOpen ? MEDIA_H_VOL : MEDIA_H });
});
document.getElementById('m-bt-btn').addEventListener('click', () => openBtView());
invokeTauri('get_system_volume').then((v) => { if (typeof v === 'number') setVolumeUI(v); });

document.getElementById('slider-vol').addEventListener('input', (e) => handleVolumeChange(e.target.value));
document.getElementById('m-vol-slider').addEventListener('input', (e) => handleVolumeChange(e.target.value));

document.getElementById('slider-bright').addEventListener('change', (e) => {
  const level = parseInt(e.target.value, 10);
  document.getElementById('val-bright').textContent = `${level}%`;
  invokeTauri('set_system_brightness', { level });
});
document.getElementById('slider-bright').addEventListener('input', (e) => {
  document.getElementById('val-bright').textContent = `${e.target.value}%`;
});
// Brightness follows Windows (Fn keys, quick settings, auto-brightness) through an event, no polling
function setBrightUI(level) {
  if (typeof level !== 'number') return;
  const s = document.getElementById('slider-bright');
  if (!s || s.dataset.drag === '1') return;
  s.value = level;
  document.getElementById('val-bright').textContent = `${level}%`;
}
document.getElementById('slider-bright').addEventListener('pointerdown', (e) => { e.target.dataset.drag = '1'; });
window.addEventListener('pointerup', () => { const s = document.getElementById('slider-bright'); if (s) s.dataset.drag = ''; });
onTauriEvent('brightness-changed', (e) => setBrightUI(e && e.payload));
invokeTauri('get_system_brightness').then(setBrightUI);
setTimeout(() => invokeTauri('get_system_brightness').then(setBrightUI), 5000);

