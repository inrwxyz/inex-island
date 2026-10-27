const BARS = ['▁', '▂▃', '▂▄▅', '▂▄▆█', '▂▄▆█'];
const ROW_ICON = {
  link: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  unlink: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>'
};

function rowAction(connected) {
  const b = document.createElement('span');
  b.className = 'row-act';
  b.title = connected ? 'Disconnect' : 'Connect';
  b.innerHTML = connected ? ROW_ICON.unlink : ROW_ICON.link;
  return b;
}

let selectedWifiSsid = null;
let wifiBusySsid = null;

async function loadWifiList(soft) {
  const netList = document.getElementById('wifi-network-list');
  const btn = document.getElementById('btn-refresh-wifi');
  if (!appState.wifiRadio) {
    netList.innerHTML = `<div class="empty-hint">Wi-Fi is off</div>`;
    return;
  }
  if (appState.keepOpen) return; // password panel is open
  btn.classList.add('spin');
  if (!soft) netList.innerHTML = `<div class="empty-hint">Scanning…</div>`;
  const res = await invokeTauri('get_wifi_networks');
  btn.classList.remove('spin');
  if (appState.currentView !== 'view-wifi' || appState.keepOpen) return;
  const networks = res && Array.isArray(res.networks) ? res.networks : [];
  const scanError = res && res.error ? res.error : '';
  const wn = appState.stats && appState.stats.wifi_name;
  const current = wn && wn !== 'Not connected' ? wn : '';
  const list = networks.map((n) => ({ ...n }));
  const sigPct = (appState.stats && appState.stats.wifi_signal) || 0;
  const sigBars = sigPct >= 75 ? 4 : sigPct >= 50 ? 3 : sigPct >= 25 ? 2 : 1;
  if (current && !list.some((n) => n.ssid === current)) {
    list.unshift({ ssid: current, bars: sigBars, signal: sigPct, saved: true, security: 'wpa2', connected: true });
  }
  list.sort((a, b) => (b.ssid === current) - (a.ssid === current));
  netList.innerHTML = '';
  if (list.length === 0) {
    netList.innerHTML = `<div class="empty-hint">${scanError === 'no_adapter' ? 'No Wi-Fi adapter found' : 'No networks found. Tap refresh.'}</div>`;
  }
  list.forEach((n) => {
    const isConnected = n.ssid === current;
    const isExpanded = selectedWifiSsid === n.ssid;
    const isBusy = wifiBusySsid === n.ssid;

    const row = document.createElement('div');
    row.className = 'list-row-item' + (isConnected ? ' on' : '') + (isExpanded ? ' expanded' : '') + (isBusy ? ' busy' : '');

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = n.ssid;

    const pct = document.createElement('small');
    pct.className = 'sig-pct';
    const displaySignal = isConnected ? (sigPct > 0 ? sigPct : (n.signal || 85)) : (n.signal || Math.min(100, Math.round((n.bars || 2) * 25)));
    pct.textContent = `${displaySignal}%`;
    row.append(rowAction(isConnected), name, pct);

    if (n.security && n.security !== 'open') {
      const lock = document.createElement('span');
      lock.className = 'row-lock';
      lock.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      row.insertBefore(lock, pct);
    }

    // Inline action drawer (click / context expand)
    if (isExpanded) {
      const drawer = document.createElement('div');
      drawer.className = 'inline-action-drawer';
      drawer.addEventListener('click', (e) => e.stopPropagation());

      const errEl = document.createElement('div');
      errEl.className = 'drawer-err';

      if (isConnected) {
        const btnRow = document.createElement('div');
        btnRow.className = 'drawer-row';
        const disBtn = document.createElement('button');
        disBtn.className = 'drawer-btn ghost';
        disBtn.textContent = 'Disconnect';
        disBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          disBtn.disabled = true;
          wifiBusySsid = n.ssid;
          await invokeTauri('disconnect_wifi');
          if (appState.stats) appState.stats.wifi_name = 'Not connected';
          document.getElementById('wifi-cap').textContent = '';
          selectedWifiSsid = null;
          wifiBusySsid = null;
          loadWifiList(true);
        });
        btnRow.appendChild(disBtn);

        if (n.saved) {
          const fBtn = document.createElement('button');
          fBtn.className = 'drawer-btn ghost';
          fBtn.textContent = 'Forget';
          fBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            fBtn.disabled = true;
            await invokeTauri('wifi_forget', { ssid: n.ssid });
            selectedWifiSsid = null;
            loadWifiList(true);
          });
          btnRow.appendChild(fBtn);
        }
        drawer.appendChild(btnRow);
      } else if (n.saved) {
        const btnRow = document.createElement('div');
        btnRow.className = 'drawer-row';
        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn';
        connBtn.textContent = 'Connect';
        connBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          connBtn.disabled = true;
          wifiBusySsid = n.ssid;
          connBtn.textContent = 'Connecting…';
          const ok = await invokeTauri('connect_wifi_network', { ssid: n.ssid });
          wifiBusySsid = null;
          if (ok === false) {
            n.saved = false;
            loadWifiList(true);
            return;
          }
          selectedWifiSsid = null;
          setTimeout(() => loadWifiList(true), 2500);
        });
        const fBtn = document.createElement('button');
        fBtn.className = 'drawer-btn ghost';
        fBtn.textContent = 'Forget';
        fBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          fBtn.disabled = true;
          await invokeTauri('wifi_forget', { ssid: n.ssid });
          selectedWifiSsid = null;
          loadWifiList(true);
        });
        btnRow.append(connBtn, fBtn);
        drawer.appendChild(btnRow);
      } else if (n.security === 'open') {
        const btnRow = document.createElement('div');
        btnRow.className = 'drawer-row';
        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn';
        connBtn.textContent = 'Connect';
        connBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          connBtn.disabled = true;
          wifiBusySsid = n.ssid;
          connBtn.textContent = 'Connecting…';
          await invokeTauri('wifi_join', { ssid: n.ssid, password: '', security: 'open', hidden: false });
          wifiBusySsid = null;
          selectedWifiSsid = null;
          setTimeout(() => loadWifiList(true), 2500);
        });
        btnRow.appendChild(connBtn);
        drawer.appendChild(btnRow);
      } else {
        // Needs password
        const inpRow = document.createElement('div');
        inpRow.className = 'drawer-row';
        const passIn = document.createElement('input');
        passIn.type = 'password';
        passIn.className = 'drawer-input';
        passIn.placeholder = 'Password (8-63 chars)';
        passIn.autocomplete = 'off';
        const connBtn = document.createElement('button');
        connBtn.className = 'drawer-btn';
        connBtn.textContent = 'Connect';

        const doJoin = async () => {
          const key = passIn.value;
          if (!key || key.length < 8) {
            errEl.textContent = 'Password must be 8 to 63 characters';
            return;
          }
          connBtn.disabled = passIn.disabled = true;
          connBtn.textContent = 'Connecting…';
          errEl.textContent = '';
          const res = await invokeTauri('wifi_join', { ssid: n.ssid, password: key, security: n.security || 'wpa2', hidden: false });
          if (res === 'ok') {
            selectedWifiSsid = null;
            loadWifiList(true);
          } else {
            connBtn.disabled = passIn.disabled = false;
            connBtn.textContent = 'Connect';
            errEl.textContent = res === 'wrong-password' || res === 'badkey' ? 'Wrong password' : 'Could not connect';
          }
        };

        connBtn.addEventListener('click', doJoin);
        passIn.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') doJoin();
          if (e.key === 'Escape') { selectedWifiSsid = null; loadWifiList(true); }
        });

        inpRow.append(passIn, connBtn);
        drawer.append(inpRow, errEl);
        setTimeout(() => passIn.focus(), 60);
      }

      row.appendChild(drawer);
    }

    const toggleRow = (e) => {
      e.stopPropagation();
      if (isBusy) return;
      if (isConnected) {
        selectedWifiSsid = selectedWifiSsid === n.ssid ? null : n.ssid;
        loadWifiList(true);
      } else if (n.saved) {
        if (e.type === 'contextmenu') {
          selectedWifiSsid = selectedWifiSsid === n.ssid ? null : n.ssid;
          loadWifiList(true);
        } else {
          row.classList.add('busy');
          invokeTauri('connect_wifi_network', { ssid: n.ssid }).then((ok) => {
            row.classList.remove('busy');
            if (ok === false) {
              selectedWifiSsid = n.ssid;
              loadWifiList(true);
            }
          });
        }
      } else {
        selectedWifiSsid = selectedWifiSsid === n.ssid ? null : n.ssid;
        loadWifiList(true);
      }
    };

    row.addEventListener('click', toggleRow);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      toggleRow(e);
    });

    netList.appendChild(row);
  });

  const hid = document.createElement('div');
  hid.className = 'list-row-item add-hidden';
  hid.textContent = '+ Add Network';
  hid.addEventListener('click', () => showWifiJoin({ ssid: '', hidden: true }));
  netList.appendChild(hid);
  if (scanError === 'location_off') {
    const hint = document.createElement('div');
    hint.className = 'wifi-hint';
    hint.innerHTML = 'Windows blocks Wi-Fi scanning while Location is off. Turn on "Let desktop apps access your location". <button id="wifi-loc-btn">Open Location settings</button>';
    netList.appendChild(hint);
    hint.querySelector('button').addEventListener('click', () => invokeTauri('open_location_settings'));
  }
}

// Password / hidden-network panel, inside the island
function showWifiJoin({ ssid, hidden, security }) {
  appState.keepOpen = true;
  invokeTauri('focus_island');
  const netList = document.getElementById('wifi-network-list');
  netList.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'wifi-join';
  const title = document.createElement('div');
  title.className = 'wj-title';
  const ssidIn = document.createElement('input');
  ssidIn.className = 'wj-input';
  ssidIn.placeholder = 'Network name (SSID)';
  ssidIn.maxLength = 32;
  ssidIn.autocomplete = 'off';
  if (hidden) box.append(ssidIn); else { title.textContent = ssid; box.append(title); }

  const passRow = document.createElement('div');
  passRow.className = 'wj-row';
  const pass = document.createElement('input');
  pass.className = 'wj-input';
  pass.type = 'password';
  pass.placeholder = 'Password';
  pass.maxLength = 64;
  pass.autocomplete = 'off';
  const eye = document.createElement('button');
  eye.className = 'wj-mini';
  eye.textContent = '👁';
  eye.title = 'Show / hide';
  eye.addEventListener('click', () => { pass.type = pass.type === 'password' ? 'text' : 'password'; });
  passRow.append(pass, eye);

  const row2 = document.createElement('div');
  row2.className = 'wj-row';
  const sec = document.createElement('select');
  sec.className = 'wj-input';
  [
    ['wpa2', 'WPA2-Personal (AES)'],
    ['wpa3', 'WPA3-Personal (SAE)'],
    ['wpa2_wpa3', 'WPA2/WPA3-Personal'],
    ['wpa', 'WPA-Personal (TKIP)'],
    ['open', 'Open (No password)']
  ].forEach(([v, t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t; sec.append(o);
  });
  if (security && ['wpa2', 'wpa3', 'wpa', 'open'].includes(security)) sec.value = security;
  const go = document.createElement('button');
  go.className = 'wj-btn';
  go.textContent = 'Connect';
  const cancel = document.createElement('button');
  cancel.className = 'wj-btn ghost';
  cancel.textContent = 'Cancel';
  row2.append(sec, go, cancel);

  const msg = document.createElement('div');
  msg.className = 'wj-msg';
  box.append(passRow, row2, msg);
  netList.append(box);

  sec.addEventListener('change', () => { pass.disabled = sec.value === 'open'; });
  cancel.addEventListener('click', () => { appState.keepOpen = false; loadWifiList(); });
  const submit = async () => {
    const name = hidden ? ssidIn.value.trim() : ssid;
    if (!name) { msg.className = 'wj-msg err'; msg.textContent = 'Enter the network name'; return; }
    go.disabled = true; cancel.disabled = true;
    msg.className = 'wj-msg'; msg.textContent = 'Connecting…';
    const r = await invokeTauri('wifi_join', { ssid: name, password: pass.value, security: sec.value, hidden });
    if (r === 'ok') {
      msg.textContent = 'Connected';
      if (appState.stats) appState.stats.wifi_name = name;
      appState.keepOpen = false;
      setTimeout(() => { if (appState.currentView === 'view-wifi') loadWifiList(); }, 700);
      return;
    }
    go.disabled = false; cancel.disabled = false;
    msg.className = 'wj-msg err';
    msg.textContent = r === 'badkey' ? 'Password must be 8 to 63 characters'
      : r === 'badssid' ? 'Network name is not valid'
      : r === 'failed' ? 'Could not connect. Wrong password or security type?'
      : 'Something went wrong, try again';
  };
  go.addEventListener('click', submit);
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => (hidden ? ssidIn : pass).focus(), 120);
}

function openWifiView() {
  switchView('view-wifi', 'state-sub', 316, 208);
  loadWifiList();
}
document.getElementById('tile-wifi').addEventListener('click', (e) => {
  if (e.target.closest('.chev')) return openWifiView();
  toggleRadio('wifi', !appState.wifiRadio);
});
document.getElementById('tile-wifi').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openWifiView();
});
document.getElementById('btn-refresh-wifi').addEventListener('click', loadWifiList);
document.getElementById('btn-more-wifi').addEventListener('click', () => invokeTauri('open_wifi_settings'));

