// ==================== P2P FILE TRANSFER (offer lives in P2P list, streamed to disk, no RAM blow-up) ====================
const CHUNK = 128 * 1024;           // one WebRTC message
const READ_BLOCK = 4 * 1024 * 1024; // read from disk in big blocks
const HIGH_WATER = 4 * 1024 * 1024; // pause sending above this
const LOW_WATER = 1024 * 1024;      // resume below this
const FLUSH_BYTES = 4 * 1024 * 1024; // receiver writes to disk in 4MB blocks

async function tryInvoke(cmd, args) {
  try { return await invokeTauri(cmd, args); } catch (e) { console.warn(cmd, e); return null; }
}

// Binary (raw) command call: file bytes go to Rust without base64
async function invokeRaw(cmd, bytes, headers) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return await window.__TAURI__.core.invoke(cmd, bytes, { headers });
  }
  return null;
}

function toArrayBuffer(b) {
  if (b instanceof ArrayBuffer) return b;
  if (ArrayBuffer.isView(b)) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  if (Array.isArray(b)) return new Uint8Array(b).buffer;
  return null;
}

function waitBuffered(dc, limit) {
  return new Promise((resolve) => {
    if (dc.readyState !== 'open' || dc.bufferedAmount <= limit) return resolve();
    dc.bufferedAmountLowThreshold = limit;
    let t = null;
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      clearInterval(t);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    t = setInterval(() => {
      if (dc.readyState !== 'open' || dc.bufferedAmount <= limit) done();
    }, 200);
  });
}

function offerFilesToPeer(peerId, files) {
  const entry = rtcPeers.get(peerId);
  if (!entry || !entry.dc || entry.dc.readyState !== 'open' || files.length === 0) return;
  if (entry.send || entry.recv) return; // this peer is busy

  entry.send = {
    files: [...files], accepted: false, active: false, cancelled: false, completed: false,
    sent: 0, total: files.reduce((a, f) => a + (f.size || 0), 0)
  };
  entry.dc.send(JSON.stringify({
    type: 'file-offer',
    files: files.map((f) => ({ name: f.name, size: f.size })),
    fromName: myDeviceName
  }));
  // nobody answered for 2 minutes -> withdraw the offer
  entry.offerTimer = setTimeout(() => {
    if (entry.send && !entry.send.active) abortTransfer(peerId, true);
  }, 120000);
  refreshTransferUI();
}

function acceptPeerFileOffer(peerId) {
  const entry = rtcPeers.get(peerId);
  const r = entry && entry.recv;
  if (!r || r.accepted || !entry.dc || entry.dc.readyState !== 'open') return;
  r.accepted = true;
  r.active = true;
  beginTransferStats(entry);
  entry.dc.send('{"type":"file-accept"}');
  refreshTransferUI();
}

function declinePeerFileOffer(peerId) {
  const entry = rtcPeers.get(peerId);
  if (entry && entry.dc && entry.dc.readyState === 'open') {
    try { entry.dc.send('{"type":"file-decline"}'); } catch (_) {}
  }
  if (entry) entry.recv = null;
  refreshTransferUI();
}

// Stop a transfer (either side) and tell the other PC
function abortTransfer(peerId, notify) {
  const entry = rtcPeers.get(peerId);
  if (entry) {
    if (notify && entry.dc && entry.dc.readyState === 'open') {
      try { entry.dc.send('{"type":"cancel"}'); } catch (_) {}
    }
    clearTimeout(entry.offerTimer);
    dropTransferState(entry);
  }
  refreshTransferUI();
}

function cancelAllActiveTransfers(notify = true) {
  let cancelledAny = false;
  for (const [peerId, entry] of rtcPeers.entries()) {
    if ((entry.send && entry.send.active) || (entry.recv && entry.recv.active)) {
      abortTransfer(peerId, notify);
      cancelledAny = true;
    }
  }
  if (cancelledAny) {
    showToast('unlock', 'Transfer cancelled', 1500);
  }
  refreshTransferUI();
}

document.getElementById('c-transfer-cancel-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  cancelAllActiveTransfers(true);
});

async function handlePeerMessage(peerId, entry, msg) {
  switch (msg.type) {
    case 'ping':
      return;
    case 'hello':
      if (msg.name) { entry.name = msg.name; syncConnectedPeersList(); }
      return;
    case 'bye':
      if (msg.peerId) appState.manuallyDisconnected.add(msg.peerId);
      appState.manuallyDisconnected.add(peerId);
      cleanupPeer(peerId);
      return;
    case 'room_closed':
      showToast('lock', 'Room closed by host', 2200);
      exitP2PRoom(false);
      return;
    case 'file-offer': {
      const files = Array.isArray(msg.files) ? msg.files.filter((f) => f && f.name).slice(0, 200) : [];
      if (files.length === 0) return;
      if (entry.recv || entry.send) {
        try { entry.dc.send('{"type":"file-decline"}'); } catch (_) {}
        return;
      }
      entry.recv = {
        files, fromName: msg.fromName || entry.name, accepted: false, active: false,
        total: files.reduce((a, f) => a + (Number(f.size) || 0), 0), got: 0, cur: null
      };
      refreshTransferUI(); // peer badge glows + row shows tick/cross (no notch popup)
      return;
    }
    case 'file-accept':
      if (entry.send && !entry.send.active) {
        clearTimeout(entry.offerTimer);
        entry.send.accepted = true;
        streamFiles(peerId);
      }
      return;
    case 'file-decline':
      if (entry.send && !entry.send.active) {
        clearTimeout(entry.offerTimer);
        entry.send = null;
        refreshTransferUI();
      }
      return;
    case 'cancel':
      abortTransfer(peerId, false);
      return;
    case 'file-start': {
      const r = entry.recv;
      if (!r || !r.accepted) return;
      const id = await tryInvoke('recv_begin', { fileName: String(msg.name || 'Shared_File') });
      if (entry.recv !== r) { if (id) tryInvoke('recv_abort', { id }); return; } // cancelled meanwhile
      if (!id) { abortTransfer(peerId, true); return; }
      r.cur = { id, buf: [], bufBytes: 0 };
      return;
    }
    case 'file-end': {
      const r = entry.recv;
      if (!r || !r.cur) return;
      const cur = r.cur;
      const ok = await flushCur(cur);
      if (entry.recv !== r) return;
      if (!ok) { abortTransfer(peerId, true); return; }
      r.cur = null;
      const saved = await tryInvoke('recv_end', { id: cur.id });
      if (!saved && entry.recv === r) abortTransfer(peerId, true);
      return;
    }
    case 'all-done':
      if (entry.recv && entry.recv.accepted) {
        entry.recv = null;
        refreshTransferUI();
      }
      return;
    default:
  }
}

async function flushCur(cur) {
  if (cur.bufBytes === 0) return true;
  const out = new Uint8Array(cur.bufBytes);
  let p = 0;
  for (const b of cur.buf) { out.set(b, p); p += b.byteLength; }
  cur.buf = [];
  cur.bufBytes = 0;
  try {
    await invokeRaw('recv_chunk', out, { 'x-id': String(cur.id) });
    return true;
  } catch (e) {
    console.warn('recv_chunk failed', e);
    return false;
  }
}

async function handleIncomingChunk(peerId, entry, ab) {
  const r = entry.recv;
  if (!r || !r.accepted || !r.cur) return;
  const cur = r.cur;
  const u8 = new Uint8Array(ab);
  cur.buf.push(u8);
  cur.bufBytes += u8.byteLength;
  r.got += u8.byteLength;
  noteProgress(r.got, r.total);
  if (cur.bufBytes >= FLUSH_BYTES) {
    const ok = await flushCur(cur);
    if (!ok && entry.recv === r) abortTransfer(peerId, true);
  }
}

async function streamFiles(peerId) {
  const entry = rtcPeers.get(peerId);
  const s = entry && entry.send;
  if (!s || s.active || !entry.dc) return;
  const dc = entry.dc;
  s.active = true;
  beginTransferStats(entry);
  refreshTransferUI();

  let failed = false;
  try {
    for (const f of s.files) {
      if (s.cancelled || dc.readyState !== 'open') break;
      dc.send(JSON.stringify({ type: 'file-start', name: f.name, size: f.size }));
      let offset = 0;
      while (offset < f.size) {
        if (s.cancelled || dc.readyState !== 'open') break;
        const want = Math.min(READ_BLOCK, f.size - offset);
        let buf = null;
        try { buf = await invokeTauri('read_file_chunk', { path: f.path, offset, len: want }); } catch (_) {}
        if (!buf || buf.byteLength === 0) { failed = true; break; } // file moved/deleted/locked
        for (let p = 0; p < buf.byteLength; p += CHUNK) {
          if (s.cancelled || dc.readyState !== 'open') break;
          if (dc.bufferedAmount > HIGH_WATER) await waitBuffered(dc, LOW_WATER);
          dc.send(new Uint8Array(buf, p, Math.min(CHUNK, buf.byteLength - p)));
          s.sent += Math.min(CHUNK, buf.byteLength - p);
          noteProgress(Math.max(0, s.sent - dc.bufferedAmount), s.total);
          if (((p / CHUNK) & 3) === 0) {
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        offset += buf.byteLength;
      }
      if (failed || s.cancelled || dc.readyState !== 'open') break;
      dc.send('{"type":"file-end"}');
    }
    if (!failed && !s.cancelled && dc.readyState === 'open') {
      await waitBuffered(dc, 0); // wait until every byte really left this PC
      if (!s.cancelled && dc.readyState === 'open') {
        dc.send('{"type":"all-done"}');
        s.completed = true;
      }
    }
  } catch (e) {
    console.warn('P2P send error:', e);
    failed = true;
  }

  if (entry.send !== s) return; // already cancelled / peer gone (state was reset)
  if (failed || !s.completed) {
    abortTransfer(peerId, true);
    return;
  }
  entry.send = null;
  appState.trayFiles = appState.trayFiles.filter((t) => !s.files.includes(t));
  updateTrayUI();
  refreshTransferUI();
}

// ---- speed / route (shown in the P2P status pill while sending/receiving) ----
async function getRouteLabel(pc) {
  try {
    const stats = await pc.getStats();
    const byId = {};
    let pairId = null;
    stats.forEach((r) => {
      byId[r.id] = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    let pair = pairId ? byId[pairId] : null;
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return '';
    const types = [byId[pair.localCandidateId], byId[pair.remoteCandidateId]].map((c) => c && c.candidateType);
    if (types.includes('relay')) return 'Relay';
    if (types.every((t) => t === 'host')) return 'LAN';
    return 'Internet';
  } catch (_) { return ''; }
}

function beginTransferStats(entry) {
  if (appState.xfer) return;
  const x = { bytes: 0, lastBytes: 0, lastT: Date.now(), route: '', speed: 0, pctT: 0, timer: null };
  appState.xfer = x;
  getRouteLabel(entry.pc).then((l) => { x.route = l; });
  x.timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - x.lastT) / 1000 || 1;
    x.speed = Math.max(0, (x.bytes - x.lastBytes) / dt / 1048576);
    x.lastBytes = x.bytes;
    x.lastT = now;
    document.getElementById('p2p-status-pill').textContent =
      `${x.route ? x.route + ' · ' : ''}${x.speed.toFixed(1)} MB/s`;
  }, 1000);
}

function endTransferStats() {
  if (appState.xfer) {
    clearInterval(appState.xfer.timer);
    appState.xfer = null;
  }
}

let lastReportedPct = -1;
function noteProgress(done, total) {
  const x = appState.xfer;
  if (!x) return;
  x.bytes = done;
  const now = Date.now();
  if (now - x.pctT < 120 && done < total) return;
  x.pctT = now;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
  if (pct !== lastReportedPct) {
    lastReportedPct = pct;
    updateCompactTransferPct(pct);
  }
}

function anyTransferActive() {
  for (const e of rtcPeers.values()) {
    if ((e.send && e.send.active) || (e.recv && e.recv.active)) return true;
  }
  return false;
}

function updateOfferGlow() {
  let pending = false;
  for (const e of rtcPeers.values()) if (e.recv && !e.recv.accepted) pending = true;
  document.getElementById('c-peer-badge').classList.toggle('offer', pending);
  document.getElementById('tile-p2p').classList.toggle('offer', pending);
}

function refreshStatusPill() {
  if (anyTransferActive()) return;
  const pill = document.getElementById('p2p-status-pill');
  if (appState.roomCode) pill.textContent = `Code ${appState.roomCode}`;
  else pill.textContent = appState.peers.length > 0 ? `${appState.peers.length} Connected` : 'Standby';
}

// One place that decides if the notch shows the transfer animation: only while data is really moving
function refreshTransferUI() {
  if (anyTransferActive()) {
    if (!appState.transferring) startCompactTransferUI();
  } else if (appState.transferring) {
    finishCompactTransferUI();
  }
  updateOfferGlow();
  renderPeersUI();
  refreshStatusPill();
}

function renderPeersUI() {
  updateP2PExpiryUI();
  const exitBtn = document.getElementById('btn-exit-room');
  if (exitBtn) {
    exitBtn.classList.toggle('hidden', !appState.roomCode);
  }
  const count = appState.peers.length;
  const listEl = document.getElementById('p2p-peers-list');
  const badge = document.getElementById('c-peer-badge');
  const countSpan = document.getElementById('c-peer-count');
  const tileP2P = document.getElementById('tile-p2p');

  document.getElementById('tile-p2p-sub').textContent = `${count}/5 Peers`;
  document.getElementById('p2p-cap').textContent = count > 0 ? `${count} peer${count > 1 ? 's' : ''}` : '';
  tileP2P.classList.toggle('active', count > 0);

  if (count > 0) {
    badge.classList.remove('hidden');
    countSpan.textContent = count;
  } else {
    badge.classList.add('hidden');
  }
  updateCompactStateClasses();

  listEl.innerHTML = '';
  if (count === 0) {
    const msg = appState.roomCode
      ? `Waiting for peers to join code ${appState.roomCode} (5m valid)...`
      : 'Generate a code or enter partner code (Max 5 PCs)';
    listEl.innerHTML = `<div class="empty-hint">${msg}</div>`;
    return;
  }

  appState.peers.forEach((peer) => {
    const entry = rtcPeers.get(peer.id);
    const r = entry && entry.recv;
    const s = entry && entry.send;
    const row = document.createElement('div');
    row.className = 'list-row-item on';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'row-name';
    nameSpan.textContent = `🖥️ ${peer.name}`;
    row.appendChild(nameSpan);

    if (r && !r.accepted) {
      // incoming offer: tick / cross right next to the PC (only place where the offer is shown)
      const label = r.files.length === 1 ? r.files[0].name : `${r.files.length} files`;
      const actBox = document.createElement('div');
      actBox.className = 'peer-file-actions';
      actBox.innerHTML = `
        <span class="peer-file-tag" title="${escHtml(label)}">${escHtml(label)}</span>
        <button class="inc-icon-btn accept" title="Accept">
          <svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <button class="inc-icon-btn decline" title="Decline">
          <svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;
      actBox.querySelector('.accept').addEventListener('click', (e) => { e.stopPropagation(); acceptPeerFileOffer(peer.id); });
      actBox.querySelector('.decline').addEventListener('click', (e) => { e.stopPropagation(); declinePeerFileOffer(peer.id); });
      row.appendChild(actBox);
    } else if (r || s) {
      // sending / receiving / waiting for the other side: Cancel instead of Disconnect
      const cancel = document.createElement('small');
      cancel.style.color = '#f87171';
      cancel.textContent = s && !s.active ? 'Waiting… Cancel' : 'Cancel';
      cancel.addEventListener('click', (e) => { e.stopPropagation(); abortTransfer(peer.id, true); });
      row.appendChild(cancel);
    } else {
      const actionsWrap = document.createElement('div');
      actionsWrap.style.display = 'flex';
      actionsWrap.style.alignItems = 'center';
      actionsWrap.style.gap = '8px';

      const sendBtn = document.createElement('button');
      sendBtn.className = 'peer-send-btn';
      sendBtn.title = `Send tray files to ${peer.name}`;
      sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2.2" fill="none"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg><span>Send</span>`;
      sendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        let toSend = appState.trayFiles.filter((f) => appState.traySelectedIds && appState.traySelectedIds.has(f.id));
        if (toSend.length === 0 && appState.trayFiles.length > 0) toSend = [...appState.trayFiles];
        if (toSend.length > 0) {
          sendTrayFiles(peer.id, toSend);
        } else {
          showToast('info', 'Drop files into tray first');
        }
      });

      const disc = document.createElement('small');
      disc.style.color = '#f87171';
      disc.style.cursor = 'pointer';
      disc.textContent = 'Disconnect';
      disc.addEventListener('click', (e) => { e.stopPropagation(); disconnectPeer(peer.id); });

      actionsWrap.append(sendBtn, disc);
      row.appendChild(actionsWrap);
    }

    listEl.appendChild(row);
  });
}

// Notch center: clock <-> transfer animation <-> Windows password-prompt animation
function renderCenter() {
  const toast = !!appState.toast;
  const isPrompt = !!(appState.prompting || appState.lockerPrompting);
  const busy = appState.transferring || isPrompt || toast;
  island.classList.toggle('transferring', busy);
  document.getElementById('c-clock').classList.toggle('hidden', busy);
  document.getElementById('c-transfer-anim').classList.toggle('hidden', !(appState.transferring && !isPrompt && !toast));
  document.getElementById('c-prompt-anim').classList.toggle('hidden', !(isPrompt && !toast));
  document.getElementById('c-toast').classList.toggle('hidden', !toast);
  updateCompactStateClasses();
}

