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
  low: SVG_A + '<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="10" x2="6" y2="14"/></svg>'
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

// Inex App Locker / Biometric Unlock Pipe Listener
let lockerWrongTimer = null;
let lockerGlowTimer = null;
let lockerPromptSafetyTimer = null;
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
    const kind = payload.type === 'face' ? 'face' : payload.type === 'fingerprint' ? 'fingerprint' : 'unlock';
    const targetName = payload.target ? `${payload.target} Unlocked` : 'Unlocked';

    renderCenter();
    showToast(kind, targetName, 1400);

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

function startCompactTransferUI() {
  appState.transferring = true;
  document.getElementById('c-transfer-pct').textContent = '0%';
  renderCenter();
}

function updateCompactTransferPct(pct) {
  document.getElementById('c-transfer-pct').textContent = `${pct}%`;
}

function finishCompactTransferUI() {
  appState.transferring = false;
  endTransferStats();
  renderCenter();
  updateClocks();
  refreshMedia();
}

// Windows password / PIN / credential prompts -> lock animation in the notch
async function pollNativePrompt() {
  const r = await tryInvoke('native_prompt', {});
  const on = r === 'password';
  if (on !== appState.prompting) {
    appState.prompting = on;
    renderCenter();
    if (!on) {
      updateClocks();
      // the prompt closed (if an explicit locker-unlock toast is already showing, don't overwrite it)
      if (SET.general.lockToast && !appState.toast && !appState.lockerPrompting) showToast('unlock', 'Done', 1500);
    }
  }
}
setInterval(pollNativePrompt, 400);

// Windows lock screen (Win+L, Dynamic Lock, idle lock): when the PC is unlocked, play the unlock animation
let lockPrev = null;
async function pollLock() {
  const r = await tryInvoke('is_session_locked', {});
  if (typeof r !== 'boolean') return;
  if (lockPrev === true && r === false && SET.general.lockToast) showToast('unlock', 'Unlocked', 1900);
  lockPrev = r;
}
setInterval(pollLock, 1200);


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

