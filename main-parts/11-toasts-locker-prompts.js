// ---- Short status popups: charger, low battery, unlock ----
const SVG_A = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">';
const TOAST_ICONS = {
  unlock: SVG_A + '<rect x="4" y="11" width="16" height="10" rx="2"/><path class="lock-shackle" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  lock: SVG_A + '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  face: SVG_A + '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><path d="M10 15c.8.7 1.8 1 2 1s1.2-.3 2-1"/></svg>',
  fingerprint: SVG_A + '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .13-5.35 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/><path d="M17 19a10 10 0 0 1-5 2"/><path d="M18.7 18.2a12 12 0 0 0 1.3-4.2"/></svg>',
  phone: SVG_A + '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
  unphone: SVG_A + '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/><line x1="3" y1="3" x2="21" y2="21"/></svg>',
  bolt: SVG_A + '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  battery: SVG_A + '<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/></svg>',
  low: SVG_A + '<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="10" x2="6" y2="14"/></svg>',
  done: SVG_A + '<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9"/></svg>',
  mic: SVG_A + '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
};
function showToast(kind, text, ms) {
  const isXfer = appState.transferring;
  const duration = isXfer ? Math.min(ms || 1400, 1400) : (ms || 2200);
  const box = document.getElementById('c-toast');
  box.className = 'c-transfer-inline c-toast t-' + kind;
  document.getElementById('c-toast-ico').innerHTML = TOAST_ICONS[kind] || '';
  document.getElementById('c-toast-text').textContent = text;
  appState.toast = true;
  renderCenter();
  clearTimeout(appState.toastTimer);
  appState.toastTimer = setTimeout(() => {
    appState.toast = false;
    renderCenter();
    updateClocks();
    refreshMedia();
  }, duration);
  return true;
}

// ---- Biometric morph (Face ID / Touch ID style) ----
// pill -> drops down into a rounded square -> scan -> green tick -> back to pill
let bioTimer = null;
let bioAnimPhaseTimer = null;
let bioStartTimer = null;
let bioEndTimer = null;

const BIO_SVGS = {
  // generic scan (Windows unlock, password unlock in Locker Pro): viewfinder corners + sweeping line, no face features
  scan: `<svg class="bio-scan-svg" viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path class="bio-br" d="M5 15v-4a6 6 0 0 1 6-6h4"/>
    <path class="bio-br" d="M39 15v-4a6 6 0 0 0-6-6h-4"/>
    <path class="bio-br" d="M5 29v4a6 6 0 0 0 6 6h4"/>
    <path class="bio-br" d="M39 29v4a6 6 0 0 1-6 6h-4"/>
    <rect class="bio-core" x="14" y="14" width="16" height="16" rx="5"/>
    <rect class="bio-scan" x="9" y="9" width="26" height="2.2" rx="1.1" stroke="none"/>
  </svg>`,
  face: `<svg class="bio-face-svg" viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path class="bio-br" d="M5 15v-4a6 6 0 0 1 6-6h4"/>
    <path class="bio-br" d="M39 15v-4a6 6 0 0 0-6-6h-4"/>
    <path class="bio-br" d="M5 29v4a6 6 0 0 0 6 6h4"/>
    <path class="bio-br" d="M39 29v4a6 6 0 0 1-6 6h-4"/>
    <path class="bio-ft" d="M16 17v3.5"/>
    <path class="bio-ft" d="M28 17v3.5"/>
    <path class="bio-ft" d="M22 17v6.5a1.5 1.5 0 0 1-1.5 1.5H19"/>
    <path class="bio-ft" d="M16 29.5c3.5 3 8.5 3 12 0"/>
    <rect class="bio-scan" x="9" y="9" width="26" height="2.2" rx="1.1" stroke="none"/>
  </svg>`,
  fingerprint: `<svg class="bio-finger-svg" viewBox="0 0 38 38" width="42" height="42" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path class="fp-ridge" d="M19 9a10 10 0 0 0-7 2.9"/>
    <path class="fp-ridge" d="M19 6a13 13 0 0 0-11 5.9"/>
    <path class="fp-ridge" d="M19 13a6 6 0 0 0-5.8 4.5"/>
    <path class="fp-ridge" d="M19 16a3 3 0 0 0-3 3c0 3.5-.8 5-1.5 6.5"/>
    <path class="fp-ridge" d="M22 17.5a3 3 0 0 1 0 3c-.5 2-.5 4.5-.5 6.5"/>
    <path class="fp-ridge" d="M25 13a7 7 0 0 1 0 7.5c-1 3-1 6-1 8.5"/>
    <path class="fp-ridge" d="M19 3a16 16 0 0 1 12 5.5c3 3.5 3 8 3 12"/>
    <path class="fp-ridge" d="M11 23.5c.5 3.5 2 6.5 4 8.5"/>
    <path class="fp-ridge" d="M6 20c0 5 2 9 5 12"/>
  </svg>`,
  check: `<svg class="bio-check-svg" viewBox="0 0 44 44" width="44" height="44" fill="none">
    <circle class="fillc" cx="22" cy="22" r="17" fill="rgba(48,209,88,0.16)"/>
    <circle class="ring" cx="22" cy="22" r="17" stroke="#30d158" stroke-width="2.4" stroke-linecap="round" transform="rotate(-90 22 22)"/>
    <path class="tick" d="M14 22.5l6 6 11-12.5" stroke="#30d158" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
};

function triggerBiometricMorph(type, label) {
  if (appState.currentView !== 'view-compact' || appState.alarmActive) return;     // never fight an open menu
  const kind = (type === 'fingerprint') ? 'fingerprint' : 'scan';   // face is gone: everything except a real fingerprint is a plain scan
  const box = document.getElementById('c-biometric-box');
  const glyph = document.getElementById('bio-glyph-wrap');
  const txt = document.getElementById('bio-label');
  if (!box || !glyph || !txt) return;

  clearTimeout(bioTimer); clearTimeout(bioAnimPhaseTimer); clearTimeout(bioStartTimer); clearTimeout(bioEndTimer);
  // a device HUD may be open: close it instantly
  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT);
  island.classList.remove('bt-hud-active', 'hud-out', 'hud-back');
  island.classList.add('bio-hud');   // biometric flow keeps its original animation timings (see styles.css)
  document.getElementById('c-bt-hud').classList.add('hidden');

  txt.textContent = label ? String(label) : 'Unlocked';
  glyph.innerHTML = BIO_SVGS[kind];
  box.classList.remove('hidden');

  // 1) window big enough, 2) old content blurs away, 3) island springs into the rounded square
  tryInvoke('resize_island', { width: 265, height: 112 });
  island.classList.add('hud-pre');
  bioStartTimer = setTimeout(() => {
    island.classList.remove('hud-pre');
    island.classList.add('biometric-active');
  }, 130);

  // scan, then the glyph blurs out and the tick springs in
  bioAnimPhaseTimer = setTimeout(() => {
    const cur = glyph.firstElementChild;
    if (cur) cur.classList.add('bio-leave');
    setTimeout(() => { glyph.innerHTML = BIO_SVGS.check; }, 150);
  }, 1150);

  // fade content, shrink back to the pill, restore the normal window
  bioTimer = setTimeout(() => {
    island.classList.add('hud-out');
    bioEndTimer = setTimeout(() => {
      island.classList.remove('biometric-active', 'hud-out');
      island.classList.add('hud-back');
      setTimeout(() => {
        box.classList.add('hidden');
        glyph.innerHTML = '';
        island.classList.remove('hud-back', 'bio-hud');
        hudRestoreWindow();
        renderCenter(); updateClocks(); refreshMedia();
      }, 560);
    }, 170);
  }, 2350);
}

// Inex App Locker / Biometric Unlock Pipe Listener
let lockerWrongTimer = null;
let lockerGlowTimer = null;
let lockerPromptSafetyTimer = null;
let testTransferTimer = null;
let lastLockerTs = 0;
let lastLockToast = { target: '', at: 0 };
// The locker sends a `locker_prompt` heartbeat every ~3 s for as long as its popup is open.
// The island keeps the lock status for exactly that long: every heartbeat renews this lease, and it
// only runs out (8 s) if the locker disappeared without telling us (crash / killed process).
const LOCKER_LEASE_MS = 8000;
function armLockerLease() {
  clearTimeout(lockerPromptSafetyTimer);
  lockerPromptSafetyTimer = setTimeout(() => {
    if (appState.lockerPrompting) {
      appState.lockerPrompting = false;
      renderCenter();
      updateClocks();
      refreshMedia();
    }
  }, LOCKER_LEASE_MS);
}

onTauriEvent('locker-unlock', (event) => {
  let payload = event.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) {}
  }
  if (!payload || typeof payload !== 'object') payload = {};

  // Locker events carry a millisecond `ts`. Drop one that is older than an event we already handled
  // (out-of-order delivery); a big backwards jump (clock change / locker restart) is treated as a new session.
  const evTs = Number(payload.ts) || 0;
  if (evTs) {
    if (evTs < lastLockerTs && lastLockerTs - evTs < 60000) return;
    lastLockerTs = evTs;
  }

  const evName = payload.event || (payload.type ? 'locker_unlock' : '');

  if (evName === 'locker_prompt') {
    // heartbeat while the prompt is already showing: just renew the lease, no re-render
    // (a heartbeat that finds no open prompt is ignored, so a late keep-alive can never re-open the status)
    if (payload.hb) { if (appState.lockerPrompting) armLockerLease(); return; }
    // 1. Password prompt appears -> Island shows Locked with lock icon
    appState.lockerPrompting = true;
    island.classList.remove('island-locker-glow', 'island-locker-wrong');
    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.remove('prompt-wrong');
    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) icoEl.classList.remove('lock-shake');
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = payload.target ? payload.target : 'Locked';
    renderCenter();

    armLockerLease();
  }
  else if (evName === 'locker_wrong') {
    // 2. Wrong password -> Red border on island, notch lock icon shakes
    appState.lockerPrompting = true;
    island.classList.remove('island-locker-glow');
    island.classList.add('island-locker-wrong');

    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.add('prompt-wrong');

    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) {
      icoEl.classList.remove('lock-shake');
      void icoEl.offsetWidth; // force reflow
      icoEl.classList.add('lock-shake');
    }
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = 'Wrong Password';
    renderCenter();
    armLockerLease();

    clearTimeout(lockerWrongTimer);
    lockerWrongTimer = setTimeout(() => {
      island.classList.remove('island-locker-wrong');
      if (promptEl) promptEl.classList.remove('prompt-wrong');
      if (icoEl) icoEl.classList.remove('lock-shake');
      if (txtEl && appState.lockerPrompting) {
        txtEl.textContent = payload.target ? payload.target : 'Locked';
      }
    }, 1200);
  }
  else if (evName === 'locker_cancel') {
    // 3. Prompt cancelled/closed -> Reset to normal
    appState.lockerPrompting = false;
    clearTimeout(lockerPromptSafetyTimer);
    island.classList.remove('island-locker-glow', 'island-locker-wrong');
    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.remove('prompt-wrong');
    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) icoEl.classList.remove('lock-shake');
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = 'Locked';
    renderCenter();
    updateClocks();
    refreshMedia();
  }
  else if (evName === 'locker_unlock') {
    // 4. Unlocked! Immediately clear prompting so user is NOT stuck on lock while browsing folder!
    appState.lockerPrompting = false;
    clearTimeout(lockerPromptSafetyTimer);
    clearTimeout(lockerWrongTimer);
    island.classList.remove('island-locker-wrong');
    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.remove('prompt-wrong');
    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) icoEl.classList.remove('lock-shake');
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = 'Locked';

    // Soft subtle green glow border
    island.classList.add('island-locker-glow');

    // Kind: face / fingerprint / unlock
    const kind = payload.type === 'fingerprint' ? 'fingerprint' : payload.type === 'charging' ? 'charging' : payload.type === 'low_battery' ? 'low_battery' : payload.type === 'alarm' ? 'alarm' : payload.type === 'transfer' ? 'transfer' : payload.type === 'bluetooth' ? 'bluetooth' : payload.type === 'caps' ? 'caps' : payload.type === 'num' ? 'num' : payload.type === 'download' ? 'download' : payload.type === 'download_done' ? 'download_done' : 'scan';
    const targetName = payload.target ? `${payload.target}` : 'Unlocked';

    renderCenter();
    if (kind === 'alarm') {
      if (typeof triggerTimerAlarm === 'function') triggerTimerAlarm();
    } else if (kind === 'scan' || kind === 'fingerprint') {
      triggerBiometricMorph(kind, targetName);
    } else if (kind === 'charging') {
      showDeviceHud({ iconHTML: BOLT_SVG, battery: true, plain: true, accent: 'green', name: 'Charging', tag: `${payload.target || '85%'} • MagSafe Power`, pct: parseInt(payload.target, 10) || 85, ms: 3200 });
    } else if (kind === 'low_battery') {
      showDeviceHud({ iconHTML: LOW_BATT_SVG, battery: true, plain: true, accent: 'amber', name: 'Low Battery', tag: `${payload.target || '18%'} • Connect Power`, pct: parseInt(payload.target, 10) || 18, ms: 3800 });
    } else if (kind === 'bluetooth') {
      if (typeof showBtConnectHud === 'function') {
        showBtConnectHud(payload.target || 'AirPods Pro', payload.kind || 'headphones', parseInt(payload.pct, 10) || 90);
      }
    } else if (kind === 'caps') {
      const capsSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 5 12h4v4h6v-4h4z"/><line x1="9" y1="20" x2="15" y2="20"/></svg>';
      showDeviceHud({ iconHTML: capsSvg, plain: false, accent: 'blue', name: 'Caps Lock', tag: 'On', ms: 2200 });
    } else if (kind === 'num') {
      const numSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M9 8v4M9 8l-1 1M14.5 8h1.5v8"/><path d="M8 16h2"/></svg>';
      showDeviceHud({ iconHTML: numSvg, plain: false, accent: 'blue', name: 'Num Lock', tag: 'On', ms: 2200 });
    } else if (kind === 'download') {
      const dlSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';
      showDeviceHud({ iconHTML: dlSvg, plain: true, accent: 'blue', name: payload.target || 'Inex-Island-Setup.exe', tag: 'Downloading • 3.5 MB', ms: 2500 });
    } else if (kind === 'download_done') {
      const dlDoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
      showDeviceHud({ iconHTML: dlDoneSvg, plain: true, accent: 'ok', name: payload.target || 'Inex-Island-Setup.exe', tag: 'Download Complete • 3.5 MB', ms: 4000 });
    } else if (kind === 'transfer') {
      clearInterval(testTransferTimer);
      appState.xferDir = payload.dir === 'recv' ? 'recv' : 'send';
      startCompactTransferUI();
      let p = 0;
      testTransferTimer = setInterval(() => {
        p += 10;
        if (p >= 100) {
          p = 100;
          clearInterval(testTransferTimer);
          updateCompactTransferPct(100);
          lastReportedPct = 100;
          setTimeout(() => {
            finishCompactTransferUI();
          }, 600);
        } else {
          updateCompactTransferPct(p);
        }
      }, 200);
    } else {
      showToast(kind, `${targetName} Unlocked`, 1400);
    }

    clearTimeout(lockerGlowTimer);
    lockerGlowTimer = setTimeout(() => {
      island.classList.remove('island-locker-glow');
    }, 1400);
  }
  else if (evName === 'locker_pair' || evName === 'locker_unpair' || evName === 'locker_remove') {
    // Locker Pro status signals: phone paired / unpaired, folder or app removed from the locker.
    // The on/off switch lives ONLY in Locker Pro: if it is off, the locker sends nothing, so the island just shows what it receives.
    appState.lockerPrompting = false;
    clearTimeout(lockerPromptSafetyTimer);
    island.classList.remove('island-locker-wrong', 'island-locker-glow');
    const tgt = payload.target ? String(payload.target) : '';
    renderCenter();
    if (evName === 'locker_pair') showToast('phone', tgt ? `${tgt} Paired` : 'Phone Paired', 1800);
    else if (evName === 'locker_unpair') showToast('unphone', 'Phone Unpaired', 1800);
    else showToast('unlock', tgt ? `${tgt} Removed` : 'Removed', 1600);
  }
  else if (evName === 'locker_lock') {
    // Folder/app got locked (Add folder, tray "Lock Now", auto re-lock). There was NO handler for this
    // event before: the "Master Password" status then hung around until the old 12 s timer, and
    // "Lock Now" showed nothing at all.
    appState.lockerPrompting = false;
    clearTimeout(lockerPromptSafetyTimer);
    clearTimeout(lockerWrongTimer);
    island.classList.remove('island-locker-wrong', 'island-locker-glow');
    const promptEl = document.getElementById('c-prompt-anim');
    if (promptEl) promptEl.classList.remove('prompt-wrong');
    const icoEl = document.getElementById('c-prompt-ico');
    if (icoEl) icoEl.classList.remove('lock-shake');
    const txtEl = document.getElementById('c-prompt-text');
    if (txtEl) txtEl.textContent = 'Locked';

    const tgt = payload.target ? String(payload.target) : '';
    const nowMs = Date.now();
    // "password accepted" and "lock finished" can both arrive for one folder: show one toast
    if (lastLockToast.target === tgt && nowMs - lastLockToast.at < 3000) {
      renderCenter();
      updateClocks();
      refreshMedia();
      return;
    }
    lastLockToast = { target: tgt, at: nowMs };
    renderCenter();
    showToast('lock', tgt ? `${tgt} Locked` : 'Locked', 1400);
  }
});

// ---- File transfer in the notch (same animation for the P2P link and for direct sharing) ----
const XFER_UP = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';
const XFER_DOWN = '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="5 12 12 19 19 12"/>';

function xferDirection() {
  let send = false, recv = false;
  for (const e of rtcPeers.values()) {
    if (e.send && e.send.active) send = true;
    if (e.recv && e.recv.active) recv = true;
  }
  return send && recv ? 'both' : recv ? 'recv' : 'send';
}

function setXferDirectionUI() {
  const box = document.getElementById('c-transfer-anim');
  if (!box) return;
  const dir = appState.xferDir || xferDirection();
  if (box.dataset.dir === dir) return;
  box.dataset.dir = dir;
  appState.xferDir = dir;
  box.classList.toggle('recv', dir === 'recv');
  const label = document.getElementById('c-xfer-label');
  if (label) label.textContent = dir === 'recv' ? 'Receiving' : dir === 'both' ? 'Transferring' : 'Sending';
  const glyph = document.getElementById('c-xfer-glyph');
  if (glyph) glyph.innerHTML = dir === 'recv' ? XFER_DOWN : XFER_UP;
}

function setXferRing(pct) {
  const ring = document.getElementById('c-xfer-ring-fg');
  if (ring) ring.style.strokeDashoffset = String(66 * (1 - Math.max(0, Math.min(100, pct)) / 100));
}

function startCompactTransferUI() {
  appState.transferring = true;
  lastReportedPct = -1;
  const box = document.getElementById('c-transfer-anim');
  if (box) { box.dataset.dir = ''; box.classList.add('indeterminate'); }
  setXferDirectionUI();
  setXferRing(0);
  document.getElementById('c-transfer-pct').textContent = '0%';
  renderCenter();
}

function updateCompactTransferPct(pct, speed) {
  document.getElementById('c-transfer-pct').textContent = speed ? `${pct}% • ${speed}` : `${pct}%`;
  const box = document.getElementById('c-transfer-anim');
  if (box && pct > 0) box.classList.remove('indeterminate');
  setXferDirectionUI();
  setXferRing(pct);
}

function finishCompactTransferUI() {
  const completed = lastReportedPct >= 100;     // 100% reached = really finished (a cancel never gets there)
  const dir = appState.xferDir;
  appState.transferring = false;
  lastReportedPct = -1;
  endTransferStats();
  renderCenter();
  updateClocks();
  refreshMedia();
  if (completed) showToast('done', dir === 'recv' ? 'Received' : 'Sent', 1500);
}

// Windows password / PIN / credential prompts -> lock animation in the notch
// Native Credential / PIN prompt event (from WinEventHook)
onTauriEvent('native-prompt-changed', (event) => {
  const on = !!(event && event.payload && event.payload.active);
  if (on !== appState.prompting) {
    appState.prompting = on;
    renderCenter();
    if (!on) {
      updateClocks();
      // the prompt closed (if an explicit locker-unlock toast is already showing, don't overwrite it)
      if (SET.general && SET.general.lockToast && !appState.toast && !appState.lockerPrompting) showToast('unlock', 'Done', 1500);
    }
  }
});

// Windows lock screen (Win+L, Dynamic Lock, idle lock): when the PC is unlocked (password, PIN, fingerprint, face),
// Windows kernel notifies us natively via WTSRegisterSessionNotification (0% polling).
let lockPrev = null;
let lockUnlockT = null;
onTauriEvent('session-lock-changed', (event) => {
  if (SET.general && !SET.general.lockToast) { lockPrev = null; return; }
  const locked = event && event.payload && event.payload.locked;
  if (typeof locked !== 'boolean') return;
  if (lockPrev === true && locked === false && SET.general && SET.general.lockToast) {
    // let the desktop finish appearing before the island starts to move
    clearTimeout(lockUnlockT);
    lockUnlockT = setTimeout(() => triggerBiometricMorph('scan', 'Unlocked'), 450);
  }
  lockPrev = locked;
});


// 9. Media Transport Controls
document.getElementById('m-play').addEventListener('click', async () => {
  await invokeTauri('media_play_pause');
  setTimeout(pollSystemAndMedia, 250);
});
document.getElementById('m-next').addEventListener('click', async () => {
  await invokeTauri('media_next');
  setTimeout(pollSystemAndMedia, 250);
});
document.getElementById('m-prev').addEventListener('click', async () => {
  await invokeTauri('media_prev');
  setTimeout(pollSystemAndMedia, 250);
});

