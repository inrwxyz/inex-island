// ==================== 08. P2P PEERS (WebRTC DATA CHANNEL, NO SERVER) ====================
// How a link is made (host code / reply code) lives in 09b. This part owns what happens once a peer
// exists: data channel, heartbeat, ordered message queue, cleanup. Nothing here runs until a peer connects.

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
  if (peerId === 'direct-peer') {
    closeDirectSessions();
    setDirectState({ phase: 'standby' });   // link is gone: back to the Generate / paste screen
  }
  syncConnectedPeersList();
  refreshTransferUI();
}

function disconnectPeer(peerId) {
  const entry = rtcPeers.get(peerId);
  if (entry && entry.dc && entry.dc.readyState === 'open') {
    try { entry.dc.send(JSON.stringify({ type: 'bye', peerId: myPeerId })); } catch (_) {}
  }
  cleanupPeer(peerId);
  showToast('unlock', 'Disconnected', 1400);
}

window.addEventListener('beforeunload', () => {
  for (const entry of rtcPeers.values()) {
    try { if (entry.dc && entry.dc.readyState === 'open') entry.dc.send('{"type":"bye"}'); } catch (_) {}
  }
});
