// ==================== 09b. P2P LINK: DIRECT 1-ON-1, NO SERVER ====================
// Nothing runs (no RTCPeerConnection, no timer, no network) until you press Generate or paste a code.
// Handshake = two short copy-paste codes:
//   HOST   : Generate -> host code (click it to copy) -> send it to the friend
//   FRIEND : paste / drop it in the box -> a reply code is made (and copied) -> send it back
//   HOST   : paste / drop the reply code in the same box -> connected
// A code is valid for 3 minutes (CODE_TTL_MS) and is dead as soon as the link is up.
// (var + functions on purpose: other parts call these before this part has run)

var directHostSession = null;   // { pc, dc, sid, code, expiresAt }
var directJoinSession = null;   // { pc, replyCode, expiresAt }
var directTimer = null;         // 3-minute expiry of the code that is waiting
var directTick = null;          // 1 s countdown in the header
var directGenSeq = 0;           // Cancel bumps it, so a half-made code is thrown away
var directUi = { phase: 'standby' };   // standby | generating | offer-ready | joining | reply-ready | connecting | connected

function waitCandidatesGathered(pc, maxWaitMs = 4500) {
  return new Promise((resolve) => {
    let resolved = false;
    let softTimer = null;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (softTimer) clearTimeout(softTimer);
      resolve();
    };
    if (pc.iceGatheringState === 'complete') return resolve();

    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        finish();
      } else {
        // Once we get a public candidate, wait 600ms more for extra candidates
        if (!softTimer) softTimer = setTimeout(finish, 600);
      }
    };
    setTimeout(finish, maxWaitMs);
  });
}

function directSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- state + sessions ----------
function setDirectState(state) {
  directUi = state || { phase: 'standby' };
  renderP2PView();
}

function clearDirectExpiry() {
  clearTimeout(directTimer);
  directTimer = null;
}

function armDirectExpiry(expiresAt) {
  clearDirectExpiry();
  directTimer = setTimeout(() => {
    directTimer = null;
    if (rtcPeers.has('direct-peer')) return;
    closeDirectSessions();
    setDirectState({ phase: 'standby' });
    showToast('lock', 'Code expired', 1800);
  }, Math.max(1000, expiresAt - Date.now()));
}

// throw the waiting code away and close its connection
function closeDirectSessions() {
  clearDirectExpiry();
  if (directHostSession) { try { directHostSession.pc.close(); } catch (_) {} directHostSession = null; }
  if (directJoinSession) { try { directJoinSession.pc.close(); } catch (_) {} directJoinSession = null; }
}

// the connection moved into rtcPeers: forget the code but keep the connection
function releaseDirectSessions() {
  clearDirectExpiry();
  directHostSession = null;
  directJoinSession = null;
}

function directPhaseLabel() {
  switch (directUi.phase) {
    case 'generating': return 'Generating…';
    case 'offer-ready': return 'Waiting for friend';
    case 'joining': return 'Joining…';
    case 'reply-ready': return 'Send reply back';
    case 'connecting': return 'Connecting…';
    default: return 'Standby';
  }
}

function p2pHintText() {
  switch (directUi.phase) {
    case 'generating': return 'Creating your code…';
    case 'offer-ready': return 'Click the code to copy it and send it to your friend. Then paste their reply code above.';
    case 'joining': return 'Joining…';
    case 'reply-ready': return 'Reply code copied. Send it back to your friend (valid 3 minutes).';
    case 'connecting': return 'Connecting…';
    default: return 'Generate a code, or paste a code from your friend.';
  }
}

function directCodePreview(code) {
  const flat = String(code || '').replace(/[\s-]/g, '');
  return flat.length > 14 ? `${flat.slice(0, 9)} … ${flat.slice(-4)}` : flat;
}

function updateDirectCountdown() {
  const el = document.getElementById('p2p-expiry-timer');
  if (!el || !directUi.expiresAt) return;
  const rem = Math.max(0, Math.floor((directUi.expiresAt - Date.now()) / 1000));
  el.textContent = `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
}

// ---------- the P2P view (everything in it is decided from directUi + connected peers) ----------
function renderP2PView() {
  const $ = (id) => document.getElementById(id);
  const gen = $('btn-gen-code');
  if (!gen) return;
  const ph = directUi.phase;
  const connected = appState.peers.length > 0;
  const hosting = !connected && ph === 'offer-ready';
  const replying = !connected && ph === 'reply-ready';

  gen.classList.toggle('hidden', connected || !(ph === 'standby' || ph === 'generating'));
  gen.classList.toggle('busy', ph === 'generating');
  gen.textContent = ph === 'generating' ? 'Generating…' : 'Generate';

  const box = $('code-display-box');
  const codeEl = $('my-p2p-code');
  const code = hosting ? directUi.code : (replying ? directUi.replyCode : '');
  box.classList.toggle('hidden', !code);
  if (code) {
    if (box.dataset.shown !== code) {          // a new code: small pop-in animation
      box.dataset.shown = code;
      box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop');
    }
    if (!box.classList.contains('copied')) codeEl.textContent = directCodePreview(code);
  } else {
    box.dataset.shown = '';
    box.classList.remove('copied');
  }

  const joinBox = $('p2p-join-box');
  joinBox.classList.toggle('hidden', connected || !(ph === 'standby' || ph === 'offer-ready'));
  const inp = $('input-peer-code');
  if (inp) inp.placeholder = hosting ? 'Paste friend\u2019s reply code' : 'Paste or drop code';
  const joinBtn = $('btn-join-code');
  if (joinBtn) joinBtn.textContent = hosting ? 'Connect' : 'Join';

  $('btn-exit-room')?.classList.toggle('hidden', connected || ph === 'standby');

  const timerEl = $('p2p-expiry-timer');
  const showTimer = hosting || replying;
  timerEl.classList.toggle('hidden', !showTimer);
  if (showTimer) {
    updateDirectCountdown();
    if (!directTick) directTick = setInterval(updateDirectCountdown, 1000);
  } else if (directTick) {
    clearInterval(directTick);
    directTick = null;
  }

  if (!connected) {
    const hint = document.querySelector('#p2p-peers-list .empty-hint');
    if (hint) hint.textContent = p2pHintText();
  }
  refreshStatusPill();
}

// ---------- link steps ----------
function registerDirectPeer(pc, dc, name) {
  const entry = {
    pc, dc, name,
    rx: Promise.resolve(), lastSeen: Date.now(),
    hb: null, graceTimer: null, connTimer: null, offerTimer: null,
    pendingIce: [], send: null, recv: null,
    isDirect: true
  };
  rtcPeers.set('direct-peer', entry);
  setupDataChannel('direct-peer', dc);

  // never stay half-connected forever
  entry.connTimer = setTimeout(() => {
    if (rtcPeers.get('direct-peer') === entry && dc.readyState !== 'open') {
      cleanupPeer('direct-peer');
      showToast('lock', 'Connection failed', 2200);
    }
  }, 30000);

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    } else if (st === 'disconnected') {
      // short Wi-Fi blips recover by themselves; only give up after 5s
      if (!entry.graceTimer) {
        entry.graceTimer = setTimeout(() => {
          if (rtcPeers.get('direct-peer') === entry && pc.connectionState !== 'connected') cleanupPeer('direct-peer');
        }, 5000);
      }
    } else if (st === 'failed' || st === 'closed') {
      if (rtcPeers.get('direct-peer') === entry) cleanupPeer('direct-peer');
    }
  };

  dc.addEventListener('open', () => {
    if (rtcPeers.get('direct-peer') === entry) setDirectState({ phase: 'connected', peerName: entry.name });
  });

  releaseDirectSessions();   // the code is used up from now on
  setDirectState({ phase: 'connecting' });
  return entry;
}

async function handleDirectGenOffer() {
  if (rtcPeers.has('direct-peer')) return;
  if (directUi.phase === 'generating' || directUi.phase === 'joining') return;
  closeDirectSessions();
  const tok = ++directGenSeq;
  setDirectState({ phase: 'generating' });
  let pc = null;
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P codec not loaded.');
    pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('inex-p2p', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await Promise.all([waitCandidatesGathered(pc, 4500), directSleep(450)]);   // 450 ms minimum: the animation is always seen
    if (tok !== directGenSeq) { try { pc.close(); } catch (_) {} return; }

    const info = C.parseSdp(pc.localDescription.sdp);
    const sid = C.randomCode();
    const code = C.encode({ type: 'offer', code: sid, minutes: C.nowMinutes(), info });
    const expiresAt = Date.now() + CODE_TTL_MS;
    directHostSession = { pc, dc, sid, code, expiresAt };
    armDirectExpiry(expiresAt);
    setDirectState({ phase: 'offer-ready', code, expiresAt });
  } catch (err) {
    try { if (pc) pc.close(); } catch (_) {}
    if (tok === directGenSeq) {
      setDirectState({ phase: 'standby' });
      showToast('lock', (err && err.message) || 'Could not create code', 2400);
    }
  }
}

async function handleDirectJoinOffer(hostCode) {
  if (rtcPeers.has('direct-peer')) return;
  closeDirectSessions();
  const tok = ++directGenSeq;
  setDirectState({ phase: 'joining' });
  let pc = null;
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P codec not loaded.');
    const dec = C.decode(hostCode);
    if (dec.type !== 'offer') throw new Error('This is not a host code.');
    if (C.nowMinutes() - dec.minutes > Math.ceil(CODE_TTL_MS / 60000)) throw new Error('Code expired. Ask for a new one.');

    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.ondatachannel = (e) => registerDirectPeer(pc, e.channel, 'Direct Host');
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: C.toSdp(dec.info, 'offer') }));
    await pc.setLocalDescription(await pc.createAnswer());
    await Promise.all([waitCandidatesGathered(pc, 4500), directSleep(450)]);
    if (tok !== directGenSeq) { try { pc.close(); } catch (_) {} return; }

    const replyCode = C.encode({ type: 'answer', code: dec.code, info: C.parseSdp(pc.localDescription.sdp) });
    const expiresAt = Date.now() + CODE_TTL_MS;
    directJoinSession = { pc, replyCode, expiresAt };
    armDirectExpiry(expiresAt);
    setDirectState({ phase: 'reply-ready', replyCode, expiresAt });
    try {
      await navigator.clipboard.writeText(replyCode);
      showToast('done', 'Reply code copied', 1600);
    } catch (_) {}
  } catch (err) {
    try { if (pc) pc.close(); } catch (_) {}
    if (tok === directGenSeq) {
      setDirectState({ phase: 'standby' });
      showToast('lock', (err && err.message) || 'Could not join', 2600);
    }
  }
}

async function handleDirectAcceptReply(replyCode) {
  const s = directHostSession;
  if (!s) { showToast('lock', 'Generate a code first', 2200); return; }
  let dec;
  try {
    const C = window.inexIslandCodec;
    dec = C.decode(replyCode);
    if (dec.type !== 'answer') throw new Error('Paste the reply code from your friend.');
    if (dec.code !== s.sid) throw new Error('This reply is for a different code.');
  } catch (err) {
    showToast('lock', (err && err.message) || 'Invalid reply code', 2600);
    return;
  }
  directHostSession = null;   // one reply only: this code is used up now
  clearDirectExpiry();
  try {
    const C = window.inexIslandCodec;
    await s.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: C.toSdp(dec.info, 'answer') }));
    registerDirectPeer(s.pc, s.dc, 'Direct Partner');
  } catch (err) {
    try { s.pc.close(); } catch (_) {}
    setDirectState({ phase: 'standby' });
    showToast('lock', 'Could not connect. Try a new code', 2600);
  }
}

// one box for everything: a host code joins, a reply code connects
function handleDirectCodeInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  const ph = directUi.phase;
  if (ph === 'generating' || ph === 'joining' || ph === 'connecting') return false;
  const C = window.inexIslandCodec;
  if (!C) { showToast('lock', 'P2P codec not loaded', 2200); return false; }
  let dec;
  try { dec = C.decode(text); } catch (err) { showToast('lock', err.message || 'Invalid code', 2400); return false; }
  if (dec.type === 'offer') {
    if (ph === 'offer-ready') { showToast('lock', 'You made a code. Paste the reply code, or Cancel first', 3000); return false; }
    handleDirectJoinOffer(text);
  } else {
    handleDirectAcceptReply(text);
  }
  return true;
}

// Cancel (while a code is waiting)
function handleDirectDisconnect() {
  directGenSeq++;
  closeDirectSessions();
  if (rtcPeers.has('direct-peer')) { disconnectPeer('direct-peer'); return; }   // cleanupPeer resets the state
  setDirectState({ phase: 'standby' });
}

// ---------- wiring ----------
(function wireP2PView() {
  const $ = (id) => document.getElementById(id);
  $('btn-gen-code')?.addEventListener('click', handleDirectGenOffer);
  $('btn-exit-room')?.addEventListener('click', handleDirectDisconnect);

  const inp = $('input-peer-code');
  const submit = () => { if (inp && handleDirectCodeInput(inp.value)) inp.value = ''; };
  $('btn-join-code')?.addEventListener('click', submit);
  inp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  inp?.addEventListener('paste', (e) => {          // pasting a code starts it straight away
    const t = ((e.clipboardData || window.clipboardData).getData('text') || '').trim();
    if (!t) return;
    e.preventDefault();
    inp.value = handleDirectCodeInput(t) ? '' : t;
  });

  // click the code = copy it
  const box = $('code-display-box');
  box?.addEventListener('animationend', () => box.classList.remove('pop'));
  box?.addEventListener('click', async () => {
    const code = directUi.phase === 'reply-ready' ? directUi.replyCode : directUi.code;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); } catch (_) { showToast('lock', 'Copy failed', 1500); return; }
    box.classList.add('copied');
    $('my-p2p-code').textContent = 'Copied ✓';
    clearTimeout(box._copyT);
    box._copyT = setTimeout(() => { box.classList.remove('copied'); renderP2PView(); }, 1200);
  });

  // drop a text code anywhere on the view (files keep going to the tray)
  const body = $('p2p-body');
  const hasText = (e) => {
    const t = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    return t.includes('text/plain') && !t.includes('Files');
  };
  ['dragenter', 'dragover'].forEach((n) => body?.addEventListener(n, (e) => {
    if (!hasText(e)) return;
    e.preventDefault(); e.stopPropagation();
    body.classList.add('drop-over');
  }));
  body?.addEventListener('dragleave', () => body.classList.remove('drop-over'));
  body?.addEventListener('drop', (e) => {
    body.classList.remove('drop-over');
    if (!hasText(e)) return;
    e.preventDefault(); e.stopPropagation();
    handleDirectCodeInput(e.dataTransfer.getData('text/plain'));
  });
})();
