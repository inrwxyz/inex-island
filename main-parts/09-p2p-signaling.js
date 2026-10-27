// ==================== 8. WEBRTC P2P (FIREBASE FOR HANDSHAKE ONLY, 5-MIN CODE TTL, MAX 5 PEERS) ====================
let p2pTimerInterval = null;

function updateP2PExpiryUI() {
  const timerEl = document.getElementById('p2p-expiry-timer');
  if (!timerEl) return;
  if (!appState.isCodeHost || !appState.roomCode || !appState.roomExpiresAt || appState.roomExpiresAt <= Date.now() || appState.peers.length > 0) {
    timerEl.classList.add('hidden');
    if (p2pTimerInterval) {
      clearInterval(p2pTimerInterval);
      p2pTimerInterval = null;
    }
    return;
  }
  const remSec = Math.max(0, Math.floor((appState.roomExpiresAt - Date.now()) / 1000));
  const m = Math.floor(remSec / 60);
  const s = String(remSec % 60).padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
  timerEl.classList.remove('hidden');
}

document.getElementById('btn-gen-code').addEventListener('click', async () => {
  appState.isCodeHost = true;
  appState.manuallyDisconnected.clear();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  document.getElementById('btn-gen-code').classList.add('hidden');
  const badge = document.getElementById('code-display-box');
  badge.classList.remove('hidden');
  document.getElementById('my-p2p-code').textContent = code;
  document.getElementById('btn-exit-room')?.classList.remove('hidden');
  await startFirebaseSignalingRoom(code, true);
});

document.getElementById('code-display-box').addEventListener('click', () => {
  const code = document.getElementById('my-p2p-code').textContent;
  navigator.clipboard?.writeText(code);
});

document.getElementById('btn-join-code').addEventListener('click', async () => {
  appState.isCodeHost = false;
  appState.manuallyDisconnected.clear();
  const code = document.getElementById('input-peer-code').value.trim();
  if (code.length < 4) return;
  document.getElementById('btn-exit-room')?.classList.remove('hidden');
  await startFirebaseSignalingRoom(code, false);
});

document.getElementById('btn-exit-room')?.addEventListener('click', () => {
  exitP2PRoom(true);
});

async function exitP2PRoom(isManual = true) {
  const code = appState.roomCode;
  const wasHost = appState.isCodeHost;

  // 1. Notify connected peers
  if (wasHost && isManual) {
    for (const entry of rtcPeers.values()) {
      try {
        if (entry.dc && entry.dc.readyState === 'open') {
          entry.dc.send(JSON.stringify({ type: 'room_closed' }));
        }
      } catch (_) {}
    }
    if (code) {
      try {
        await fetch(`${getFirebaseUrl()}/rooms/${code}.json`, { method: 'DELETE' });
      } catch (_) {}
    }
  } else if (!wasHost && isManual) {
    for (const entry of rtcPeers.values()) {
      try {
        if (entry.dc && entry.dc.readyState === 'open') {
          entry.dc.send(JSON.stringify({ type: 'bye', peerId: myPeerId }));
        }
      } catch (_) {}
    }
    if (code) {
      try {
        await fetch(`${getFirebaseUrl()}/rooms/${code}/peers/${myPeerId}.json`, { method: 'DELETE' });
        await fetch(`${getFirebaseUrl()}/rooms/${code}/signals/${myPeerId}.json`, { method: 'DELETE' });
      } catch (_) {}
    }
  }

  // 2. Disconnect all peers cleanly
  for (const id of Array.from(rtcPeers.keys())) {
    cleanupPeer(id);
  }

  // 3. Clear timers
  if (appState.pollSignalTimer) {
    clearInterval(appState.pollSignalTimer);
    appState.pollSignalTimer = null;
  }
  if (appState.roomExpiryTimer) {
    clearTimeout(appState.roomExpiryTimer);
    appState.roomExpiryTimer = null;
  }
  if (p2pTimerInterval) {
    clearInterval(p2pTimerInterval);
    p2pTimerInterval = null;
  }

  // 4. Reset state
  appState.roomCode = null;
  appState.roomExpiresAt = 0;
  appState.isCodeHost = false;
  appState.peers = [];
  appState.manuallyDisconnected.clear();

  // 5. Reset UI
  document.getElementById('code-display-box')?.classList.add('hidden');
  document.getElementById('btn-gen-code')?.classList.remove('hidden');
  document.getElementById('btn-exit-room')?.classList.add('hidden');
  const timerEl = document.getElementById('p2p-expiry-timer');
  if (timerEl) timerEl.classList.add('hidden');
  const myCodeEl = document.getElementById('my-p2p-code');
  if (myCodeEl) myCodeEl.textContent = '------';
  const inputEl = document.getElementById('input-peer-code');
  if (inputEl) inputEl.value = '';
  document.getElementById('p2p-status-pill').textContent = 'Standby';

  renderPeersUI();
  updateTrayUI();

  if (isManual) {
    showToast('unlock', 'Left P2P Room', 1500);
  }
}

async function expireSignalingCode() {
  await exitP2PRoom(false);
}

async function startFirebaseSignalingRoom(code, isCreator) {
  const fbUrl = getFirebaseUrl();
  if (!fbUrl) {
    document.getElementById('p2p-status-pill').textContent = 'Set Firebase URL';
    showToast('lock', 'Set Firebase URL in Settings', 2500);
    return;
  }
  try {
    const res = await fetch(`${fbUrl}/rooms/${code}.json`);
    const room = await res.json();
    const now = Date.now();

    if (!isCreator) {
      if (!room || !room.createdAt || now - room.createdAt > CODE_TTL_MS) {
        document.getElementById('p2p-status-pill').textContent = 'Code Expired';
        return;
      }
    }

    const existingPeers = (room && room.peers) || {};
    const count = Object.keys(existingPeers).length;
    if (count >= 5 && !existingPeers[myPeerId]) {
      document.getElementById('p2p-status-pill').textContent = 'Full (5/5)';
      return;
    }

    const createdAt = isCreator ? now : (room.createdAt || now);
    appState.roomCode = code;
    appState.roomExpiresAt = createdAt + CODE_TTL_MS;

    if (isCreator) {
      await fetch(`${getFirebaseUrl()}/rooms/${code}/createdAt.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createdAt)
      });
    }

    await fetch(`${getFirebaseUrl()}/rooms/${code}/peers/${myPeerId}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: myPeerId, name: myDeviceName, joinedAt: now })
    });

    document.getElementById('p2p-status-pill').textContent = `Code ${code}`;

    updateP2PExpiryUI();
    if (p2pTimerInterval) clearInterval(p2pTimerInterval);
    p2pTimerInterval = setInterval(() => {
      updateP2PExpiryUI();
      if (Date.now() >= appState.roomExpiresAt) {
        expireSignalingCode();
      }
    }, 1000);

    if (appState.roomExpiryTimer) clearTimeout(appState.roomExpiryTimer);
    const remainingMs = Math.max(1000, appState.roomExpiresAt - Date.now());
    appState.roomExpiryTimer = setTimeout(expireSignalingCode, remainingMs);

    if (appState.pollSignalTimer) clearInterval(appState.pollSignalTimer);
    pollFirebaseSignaling();
    appState.pollSignalTimer = setInterval(pollFirebaseSignaling, 1200);
  } catch (err) {
    console.error('Signaling room error:', err);
  }
}

async function sendFirebaseSignal(targetPeerId, payload) {
  if (!appState.roomCode) return;
  try {
    await fetch(`${getFirebaseUrl()}/rooms/${appState.roomCode}/signals/${targetPeerId}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: myPeerId, fromName: myDeviceName, ...payload })
    });
  } catch (_) {}
}


async function pollFirebaseSignaling() {
  if (!appState.roomCode) return;
  if (Date.now() > appState.roomExpiresAt) {
    await expireSignalingCode();
    return;
  }
  if (appState.polling) return; // never run two polls at once (double-handled offers broke connections)
  appState.polling = true;

  try {
    const code = appState.roomCode;
    const res = await fetch(`${getFirebaseUrl()}/rooms/${code}.json`);
    const room = await res.json();
    if (!room || !room.createdAt) {
      if (!appState.isCodeHost && appState.roomCode) {
        showToast('lock', 'Room closed by host', 2000);
        await exitP2PRoom(false);
      }
      return;
    }
    if (!room.peers) return;

    // 1. Discover peers in room (up to 5) & initiate WebRTC handshake if lexicographically smaller
    const roomPeers = Object.values(room.peers).filter((p) => p && p.id !== myPeerId).slice(0, 5);
    for (const rp of roomPeers) {
      if (appState.manuallyDisconnected.has(rp.id)) continue;
      if (rtcPeers.has(rp.id) || !(myPeerId < rp.id)) continue;
      const last = appState.lastTry[rp.id] || 0;
      if (Date.now() - last < 8000) continue; // do not hammer a dead/stale peer
      appState.lastTry[rp.id] = Date.now();
      createPeerConnection(rp.id, rp.name, true);
    }

    // 2. Process incoming WebRTC SDP / ICE signals addressed to myPeerId
    const mine = room.signals && room.signals[myPeerId];
    if (mine) {
      const keys = Object.keys(mine).sort();
      // delete ONLY what we just read (deleting the whole node could erase ICE candidates that arrived meanwhile)
      await Promise.all(keys.map((k) =>
        fetch(`${getFirebaseUrl()}/rooms/${code}/signals/${myPeerId}/${k}.json`, { method: 'DELETE' }).catch(() => {})
      ));
      for (const k of keys) {
        const sig = mine[k];
        if (sig && sig.from) await handleIncomingSignal(sig);
      }
    }
  } catch (err) {
    console.warn('Signaling poll error:', err);
  } finally {
    appState.polling = false;
  }
}

function createPeerConnection(peerId, peerName, initiator) {
  if (appState.manuallyDisconnected.has(peerId)) return null;
  if (rtcPeers.has(peerId)) return rtcPeers.get(peerId);
  if (rtcPeers.size >= 5) return null;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const entry = {
    pc, dc: null, name: peerName || peerId,
    rx: Promise.resolve(), lastSeen: Date.now(),
    hb: null, graceTimer: null, connTimer: null, offerTimer: null,
    pendingIce: [], send: null, recv: null
  };
  rtcPeers.set(peerId, entry);

  // never stay half-connected forever
  entry.connTimer = setTimeout(() => {
    if (rtcPeers.get(peerId) === entry && !(entry.dc && entry.dc.readyState === 'open')) cleanupPeer(peerId);
  }, 30000);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendFirebaseSignal(peerId, { type: 'ice', candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    } else if (st === 'disconnected') {
      // short Wi-Fi blips recover by themselves; only give up after 5s
      if (!entry.graceTimer) {
        entry.graceTimer = setTimeout(() => {
          if (rtcPeers.get(peerId) === entry && pc.connectionState !== 'connected') cleanupPeer(peerId);
        }, 5000);
      }
    } else if (st === 'failed' || st === 'closed') {
      if (rtcPeers.get(peerId) === entry) cleanupPeer(peerId);
    }
  };

  if (initiator) {
    const dc = pc.createDataChannel('inex-p2p', { ordered: true });
    setupDataChannel(peerId, dc);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        sendFirebaseSignal(peerId, { type: 'offer', sdp: pc.localDescription });
      })
      .catch((e) => console.warn('Offer error', e));
  } else {
    pc.ondatachannel = (e) => setupDataChannel(peerId, e.channel);
  }

  return entry;
}

async function flushPendingIce(entry) {
  const list = entry.pendingIce.splice(0);
  for (const c of list) {
    try { await entry.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
  }
}

async function handleIncomingSignal(sig) {
  const peerId = sig.from;
  if (sig.type === 'room_closed') {
    showToast('lock', 'Room closed by host', 2200);
    exitP2PRoom(false);
    return;
  }
  if (sig.type === 'disconnect') {
    appState.manuallyDisconnected.add(peerId);
    cleanupPeer(peerId);
    return;
  }
  if (appState.manuallyDisconnected.has(peerId)) return;

  let entry = rtcPeers.get(peerId);
  if (!entry) {
    entry = createPeerConnection(peerId, sig.fromName, false);
  }
  if (!entry) return;
  if (sig.fromName) entry.name = sig.fromName;

  const { pc } = entry;
  try {
    if (sig.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
      await flushPendingIce(entry);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendFirebaseSignal(peerId, { type: 'answer', sdp: pc.localDescription });
    } else if (sig.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
      await flushPendingIce(entry);
    } else if (sig.type === 'ice' && sig.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
      else entry.pendingIce.push(sig.candidate); // candidate came before the offer/answer: keep it, do not lose it
    }
  } catch (e) {
    console.warn('WebRTC signal handle error:', e);
  }
}

function setupDataChannel(peerId, dc) {
  const entry = rtcPeers.get(peerId);
  if (!entry) return;
  entry.dc = dc;
  dc.binaryType = 'arraybuffer';

  dc.onopen = () => {
    entry.lastSeen = Date.now();
    clearTimeout(entry.connTimer);
    dc.send(JSON.stringify({ type: 'hello', name: myDeviceName }));
    // heartbeat: if the other PC vanishes (power off, app killed, Wi-Fi gone) we notice in ~9s
    entry.hb = setInterval(() => {
      if (dc.readyState !== 'open') return;
      if (Date.now() - entry.lastSeen > 9000) {
        cleanupPeer(peerId);
        return;
      }
      try { dc.send('{"type":"ping"}'); } catch (_) {}
    }, 2000);
    syncConnectedPeersList();
  };

  dc.onclose = () => {
    if (rtcPeers.get(peerId) === entry) cleanupPeer(peerId);
  };

  // every message (text and file bytes) goes through ONE ordered queue, so chunks can never be reordered
  dc.onmessage = (e) => {
    entry.lastSeen = Date.now();
    const data = e.data;
    entry.rx = entry.rx
      .then(() => onPeerData(peerId, entry, data))
      .catch((err) => console.warn('P2P rx error:', err));
  };
}

async function onPeerData(peerId, entry, data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    await handlePeerMessage(peerId, entry, msg);
  } else {
    await handleIncomingChunk(peerId, entry, data);
  }
}

function syncConnectedPeersList() {
  const list = [];
  for (const [id, entry] of rtcPeers.entries()) {
    if (entry.dc && entry.dc.readyState === 'open') {
      list.push({ id, name: entry.name || id });
    }
  }
  appState.peers = list.slice(0, 5);

  const sel = appState.traySelect;
  if (sel && !appState.peers.some((p) => p.id === sel.peerId)) {
    appState.traySelect = null;
    if (appState.currentView === 'view-tray') { updateTrayUI(); renderPeerPicker(); }
  }
  renderPeersUI();
}

// Forget everything about an in-flight transfer (partial file is deleted)
function dropTransferState(entry) {
  if (entry.send) {
    entry.send.cancelled = true;
    entry.send = null;
  }
  if (entry.recv) {
    if (entry.recv.cur) tryInvoke('recv_abort', { id: entry.recv.cur.id });
    entry.recv = null;
  }
}

function cleanupPeer(peerId) {
  const entry = rtcPeers.get(peerId);
  if (entry) {
    rtcPeers.delete(peerId);
    clearInterval(entry.hb);
    clearTimeout(entry.graceTimer);
    clearTimeout(entry.connTimer);
    clearTimeout(entry.offerTimer);
    dropTransferState(entry);
    try { if (entry.dc) { entry.dc.onclose = null; entry.dc.close(); } } catch (_) {}
    try { if (entry.pc) entry.pc.close(); } catch (_) {}
  }
  syncConnectedPeersList();
  refreshTransferUI();
}

function disconnectPeer(peerId) {
  appState.manuallyDisconnected.add(peerId);
  const entry = rtcPeers.get(peerId);
  if (entry && entry.dc && entry.dc.readyState === 'open') {
    try { entry.dc.send(JSON.stringify({ type: 'bye', peerId: myPeerId })); } catch (_) {}
  }
  if (appState.roomCode) {
    try {
      sendFirebaseSignal(peerId, { type: 'disconnect' });
    } catch (_) {}
  }
  cleanupPeer(peerId);
  showToast('unlock', 'Disconnected', 1400);
}

window.addEventListener('beforeunload', () => {
  for (const entry of rtcPeers.values()) {
    try { if (entry.dc && entry.dc.readyState === 'open') entry.dc.send('{"type":"bye"}'); } catch (_) {}
  }
});

