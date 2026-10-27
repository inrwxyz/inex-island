const DEV_SVG = (inner) => `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const DEV_ICONS = {
  headphones: DEV_SVG('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'),
  speaker: DEV_SVG('<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" y1="6" x2="12.01" y2="6"/>'),
  mouse: DEV_SVG('<rect x="6" y="3" width="12" height="18" rx="6"/><line x1="12" y1="7" x2="12" y2="11"/>'),
  keyboard: DEV_SVG('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  phone: DEV_SVG('<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
  computer: DEV_SVG('<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/>'),
  watch: DEV_SVG('<rect x="7" y="6" width="10" height="12" rx="3"/><path d="M9 6l1-4h4l1 4M9 18l1 4h4l1-4"/>'),
  gamepad: DEV_SVG('<line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/>'),
  bt: DEV_SVG('<polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>')
};

function battHtml(pct) {
  const w = Math.max(1, Math.round(pct * 0.12));
  const cls = pct <= 20 ? 'low' : 'ok';
  return `<span class="batt ${cls}"><svg viewBox="0 0 18 10" width="16" height="9"><rect x="0.5" y="0.5" width="14" height="9" rx="2" fill="none" stroke="currentColor"/><rect x="15.5" y="3" width="2" height="4" rx="1" fill="currentColor"/><rect x="2" y="2" width="${w}" height="6" rx="1" fill="currentColor"/></svg></span>${pct}%`;
}

// battery value for a device name (Windows names the battery node a bit differently)
function btBatteryFor(name) {
  const list = appState.btBatt || [];
  const n = name.toLowerCase();
  const hit = list.find((b) => { const x = b.name.toLowerCase(); return x === n || x.includes(n) || n.includes(x); });
  return hit ? hit.pct : null;
}

// ---- Bluetooth list: paired devices, nearby devices to pair, PIN questions ----
function showBtNote(text) {
  const btList = document.getElementById('bt-device-list');
  if (!btList) return;
  const note = document.createElement('div');
  note.className = 'wifi-hint';
  note.textContent = text;
  btList.prepend(note);
  setTimeout(() => note.remove(), 3500);
}

let selectedBtName = null;

async function loadBtList(soft) {
  const btList = document.getElementById('bt-device-list');
  const btn = document.getElementById('btn-refresh-bt');
  if (!appState.btRadio) {
    btList.innerHTML = `<div class="empty-hint">Bluetooth is off</div>`;
    return;
  }
  if (appState.btBusy) return; // a pairing question is on screen: do not wipe it
  if (!soft) {
    btn.classList.add('spin');
    btList.innerHTML = `<div class="empty-hint">Scanning…</div>`;
  }
  const devices = await invokeTauri('get_bt_devices');
  btn.classList.remove('spin');
  if (appState.currentView !== 'view-bt' || appState.btBusy) return;
  btList.innerHTML = '';
  const subs = [];
  if (!devices || devices.length === 0) {
    btList.innerHTML = `<div class="empty-hint">No paired devices found.</div>`;
  } else {
    setBtCaption(devices);
    devices.forEach((d) => {
      const isExpanded = selectedBtName === d.name;
      const row = document.createElement('div');
      row.className = 'list-row-item' + (d.connected ? ' on' : '') + (isExpanded ? ' expanded' : '');
      const ico = document.createElement('span');
      ico.className = 'dev-ico';
      ico.innerHTML = DEV_ICONS[d.kind] || DEV_ICONS.bt;
      const text = document.createElement('div');
      text.className = 'row-text';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = d.name;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = d.connected ? 'Connected' : 'Paired';
      text.append(name, sub);
      row.append(ico, text, rowAction(d.connected));
      if (d.connected) subs.push({ d, sub });

      if (isExpanded) {
        const drawer = document.createElement('div');
        drawer.className = 'inline-action-drawer';
        drawer.addEventListener('click', (e) => e.stopPropagation());
        drawer.addEventListener('contextmenu', (e) => e.stopPropagation());

        const actRow = document.createElement('div');
        actRow.className = 'drawer-row';

        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn ' + (d.connected ? 'danger' : 'primary');
        connBtn.textContent = d.connected ? 'Disconnect' : 'Connect';

        const unpairBtn = document.createElement('button');
        unpairBtn.className = 'drawer-btn ghost danger';
        unpairBtn.textContent = 'Remove';

        const errEl = document.createElement('div');
        errEl.className = 'drawer-err';

        connBtn.addEventListener('click', async () => {
          connBtn.disabled = unpairBtn.disabled = true;
          connBtn.textContent = d.connected ? 'Disconnecting…' : 'Connecting…';
          errEl.textContent = '';
          const r = await invokeTauri('bt_set_connection', { name: d.name, on: !d.connected });
          if (r !== 'ok') {
            connBtn.disabled = unpairBtn.disabled = false;
            connBtn.textContent = d.connected ? 'Disconnect' : 'Connect';
            errEl.textContent = 'Could not ' + (d.connected ? 'disconnect' : 'connect');
          } else {
            selectedBtName = null;
            setTimeout(() => { if (appState.currentView === 'view-bt') loadBtList(true); }, 500);
          }
        });

        unpairBtn.addEventListener('click', async () => {
          connBtn.disabled = unpairBtn.disabled = true;
          unpairBtn.textContent = 'Removing…';
          errEl.textContent = '';
          const r = await invokeTauri('bt_unpair', { name: d.name });
          if (r !== 'ok') {
            connBtn.disabled = unpairBtn.disabled = false;
            unpairBtn.textContent = 'Remove';
            errEl.textContent = 'Could not remove device';
          } else {
            selectedBtName = null;
            loadBtList(true);
          }
        });

        actRow.append(connBtn, unpairBtn);
        drawer.append(actRow, errEl);
        row.appendChild(drawer);
      }

      const toggleBtRow = (e) => {
        if (e.target.closest('.inline-action-drawer')) return;
        selectedBtName = selectedBtName === d.name ? null : d.name;
        loadBtList(true);
      };

      row.addEventListener('click', toggleBtRow);
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        toggleBtRow(e);
      });

      btList.appendChild(row);
    });
  }
  // new devices that can be paired (filled by the discovery watcher while this list is open)
  const near = document.createElement('div');
  near.id = 'bt-nearby';
  btList.appendChild(near);
  renderBtNearby();
  // battery of the connected devices (one lookup for all)
  if (subs.length && SET.overlays.btBattery) {
    const bl = await invokeTauri('get_bt_batteries');
    appState.btBatt = Array.isArray(bl) ? bl : [];
    subs.forEach(({ d, sub }) => {
      const pct = btBatteryFor(d.name);
      if (pct !== null && sub.isConnected) sub.innerHTML = `Connected <span style="opacity:.5">•</span> ${battHtml(pct)}`;
    });
    setBtCaption(devices);
  }
}

async function renderBtNearby() {
  const box = document.getElementById('bt-nearby');
  if (!box || appState.currentView !== 'view-bt' || appState.btBusy || appState.btPairing) return;
  const list = (await invokeTauri('get_bt_nearby')) || [];
  if (!box.isConnected || appState.btBusy || appState.btPairing) return;
  box.innerHTML = '';
  if (!list.length) return;
  const head = document.createElement('div');
  head.className = 'wifi-hint';
  head.textContent = 'Nearby: click to pair';
  box.append(head);
  list.forEach((n) => {
    const row = document.createElement('div');
    row.className = 'list-row-item';
    const ico = document.createElement('span');
    ico.className = 'dev-ico';
    ico.innerHTML = DEV_ICONS[n.kind] || DEV_ICONS.bt;
    const text = document.createElement('div');
    text.className = 'row-text';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = n.name;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = 'Click to pair';
    text.append(name, sub);
    row.append(ico, text, rowAction(false));
    row.addEventListener('click', () => startBtPair(n, row, sub));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      startBtPair(n, row, sub);
    });
    box.append(row);
  });
}

const BT_PAIR_ERR = {
  wrong_pin: 'Wrong PIN, try again',
  rejected: 'Pairing was declined',
  timeout: 'The device did not answer in time',
  busy: 'Windows is already pairing another device'
};

async function startBtPair(n, row, sub) {
  if (appState.btPairing) return;
  appState.btPairing = true;
  row.classList.add('busy');
  sub.textContent = 'Pairing…';
  const r = await invokeTauri('bt_pair', { id: n.id, name: n.name });
  appState.btPairing = false;
  appState.btBusy = false;
  appState.keepOpen = false;
  if (appState.currentView !== 'view-bt') return;
  await loadBtList(true);
  if (r !== 'ok') showBtNote(BT_PAIR_ERR[r] || 'Could not pair, try again');
}

// Windows asks a question while pairing: confirm a number / show a number / type a PIN
function showBtPrompt(p) {
  if (!p) return;
  if (appState.currentView !== 'view-bt') {
    // the user left the list: do not leave Windows waiting
    if (p.kind !== 'display_pin') invokeTauri('bt_pair_answer', { accept: false });
    return;
  }
  appState.btBusy = true;
  appState.keepOpen = true;
  invokeTauri('focus_island');
  const btList = document.getElementById('bt-device-list');
  btList.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'wifi-join';
  const title = document.createElement('div');
  title.className = 'wj-title';
  title.textContent = p.name;
  const msg = document.createElement('div');
  msg.className = 'wj-msg';
  box.append(title);

  const answer = (accept, pin) => invokeTauri('bt_pair_answer', { accept, pin: pin || null });
  const row = document.createElement('div');
  row.className = 'wj-row';

  if (p.kind === 'display_pin') {
    msg.textContent = 'Type this code on the device:';
    const code = document.createElement('div');
    code.className = 'wj-title';
    code.style.fontSize = '20px';
    code.style.letterSpacing = '4px';
    code.textContent = p.pin;
    box.append(msg, code);
  } else if (p.kind === 'confirm_pin') {
    msg.textContent = 'Does this code match the one on the device?';
    const code = document.createElement('div');
    code.className = 'wj-title';
    code.style.fontSize = '20px';
    code.style.letterSpacing = '4px';
    code.textContent = p.pin;
    const yes = document.createElement('button');
    yes.className = 'wj-btn';
    yes.textContent = 'Yes, pair';
    const no = document.createElement('button');
    no.className = 'wj-btn ghost';
    no.textContent = 'No';
    row.append(yes, no);
    yes.addEventListener('click', () => { yes.disabled = no.disabled = true; msg.textContent = 'Pairing…'; answer(true); });
    no.addEventListener('click', () => { yes.disabled = no.disabled = true; answer(false); });
    box.append(msg, code, row);
  } else {
    msg.textContent = 'Enter the PIN of the device (often 0000):';
    const pin = document.createElement('input');
    pin.className = 'wj-input';
    pin.placeholder = 'PIN';
    pin.maxLength = 16;
    pin.autocomplete = 'off';
    const go = document.createElement('button');
    go.className = 'wj-btn';
    go.textContent = 'Pair';
    const cancel = document.createElement('button');
    cancel.className = 'wj-btn ghost';
    cancel.textContent = 'Cancel';
    row.append(pin, go, cancel);
    const submit = () => { if (!pin.value.trim()) return; go.disabled = cancel.disabled = true; msg.textContent = 'Pairing…'; answer(true, pin.value.trim()); };
    go.addEventListener('click', submit);
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    cancel.addEventListener('click', () => { go.disabled = cancel.disabled = true; answer(false); });
    box.append(msg, row);
    setTimeout(() => pin.focus(), 120);
  }
  btList.append(box);
}

function openBtView() {
  switchView('view-bt', 'state-sub', 316, 208);
  invokeTauri('bt_discovery', { on: true });
  loadBtList();
}

// Windows tells us when a device connects / disconnects / is added / removed (no polling)
let btEvT = null, btNearT = null;
onTauriEvent('bluetooth-changed', () => {
  clearTimeout(btEvT);
  btEvT = setTimeout(() => {
    refreshBtCaption();
    if (appState.currentView === 'view-bt') loadBtList(true);
  }, 400);
});
onTauriEvent('bluetooth-nearby', () => { clearTimeout(btNearT); btNearT = setTimeout(renderBtNearby, 500); });
onTauriEvent('bt-pairing', (e) => showBtPrompt(e && e.payload));

document.getElementById('tile-bt').addEventListener('click', (e) => {
  if (e.target.closest('.chev')) return openBtView();
  toggleRadio('bt', !appState.btRadio);
});
document.getElementById('tile-bt').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openBtView();
});
document.getElementById('btn-refresh-bt').addEventListener('click', () => { invokeTauri('bt_discovery', { on: true }); loadBtList(); });
document.getElementById('btn-more-bt').addEventListener('click', () => invokeTauri('open_bt_settings'));

