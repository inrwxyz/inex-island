// ==================== 8b. DIRECT SERVERLESS P2P (ZERO-SERVER CODE HANDSHAKE) ====================
// 1-on-1 direct link without Firebase. WebRTC handshake is done via compact copy-paste codes.

let directHostSession = null;
let directJoinSession = null;

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

function broadcastDirectState(state) {
  try {
    if (window.__TAURI__?.event?.emit) {
      window.__TAURI__.event.emit('direct-p2p-state', state);
    }
  } catch (_) {}
}

function getDirectP2PCurrentState() {
  const directPeer = rtcPeers.get('direct-peer');
  if (directPeer && directPeer.dc && directPeer.dc.readyState === 'open') {
    return { phase: 'connected', peerName: directPeer.name || 'Direct Partner' };
  }
  if (directHostSession && directHostSession.code) {
    return { phase: 'offer-ready', code: directHostSession.code, expiresAt: directHostSession.expiresAt };
  }
  if (directJoinSession && directJoinSession.replyCode) {
    return { phase: 'reply-ready', replyCode: directJoinSession.replyCode };
  }
  return { phase: 'standby' };
}

async function handleDirectGenOffer() {
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P Codec module not loaded.');

    if (directHostSession && directHostSession.pc) {
      try { directHostSession.pc.close(); } catch (_) {}
      directHostSession = null;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('inex-p2p', { ordered: true });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await waitCandidatesGathered(pc, 4500);

    const sdp = pc.localDescription.sdp;
    const info = C.parseSdp(sdp);
    const code = C.randomCode ? C.randomCode() : 'ABCDEFGH';
    const minutes = C.nowMinutes();
    const offerCode = C.encode({ type: 'offer', code, minutes, info });

    const expiresAt = Date.now() + 15 * 60 * 1000;
    directHostSession = { pc, dc, code: offerCode, expiresAt };

    broadcastDirectState({ phase: 'offer-ready', code: offerCode, expiresAt });
  } catch (err) {
    broadcastDirectState({ phase: 'error', message: err.message || 'Failed to create host code' });
  }
}

async function handleDirectAcceptReply(replyCode) {
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P Codec module not loaded.');
    if (!directHostSession || !directHostSession.pc) throw new Error('Host session not found. Generate a code first.');

    const dec = C.decode(replyCode);
    if (dec.type !== 'answer') throw new Error('This is not a valid reply code. Paste the reply code from your friend.');

    const sdp = C.toSdp(dec.info, 'answer');
    await directHostSession.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));

    const entry = {
      pc: directHostSession.pc,
      dc: directHostSession.dc,
      name: 'Direct Partner',
      rx: Promise.resolve(),
      lastSeen: Date.now(),
      hb: null, graceTimer: null, connTimer: null, offerTimer: null,
      pendingIce: [], send: null, recv: null,
      isDirect: true
    };
    rtcPeers.set('direct-peer', entry);
    setupDataChannel('direct-peer', directHostSession.dc);
    directHostSession.dc.addEventListener('open', () => {
      broadcastDirectState({ phase: 'connected', peerName: 'Direct Partner' });
    });
    directHostSession.dc.addEventListener('close', () => {
      broadcastDirectState({ phase: 'standby' });
    });

    broadcastDirectState({ phase: 'connecting' });
  } catch (err) {
    broadcastDirectState({ phase: 'error', message: err.message || 'Failed to accept reply code' });
  }
}

async function handleDirectJoinOffer(hostCode) {
  try {
    const C = window.inexIslandCodec;
    if (!C) throw new Error('P2P Codec module not loaded.');

    if (directJoinSession && directJoinSession.pc) {
      try { directJoinSession.pc.close(); } catch (_) {}
      directJoinSession = null;
    }

    const dec = C.decode(hostCode);
    if (dec.type !== 'offer') throw new Error('This is not a host offer code.');

    const sdp = C.toSdp(dec.info, 'offer');
    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.ondatachannel = (e) => {
      const entry = {
        pc,
        dc: e.channel,
        name: 'Direct Host',
        rx: Promise.resolve(),
        lastSeen: Date.now(),
        hb: null, graceTimer: null, connTimer: null, offerTimer: null,
        pendingIce: [], send: null, recv: null,
        isDirect: true
      };
      rtcPeers.set('direct-peer', entry);
      setupDataChannel('direct-peer', e.channel);
      e.channel.addEventListener('open', () => {
        broadcastDirectState({ phase: 'connected', peerName: 'Direct Host' });
      });
      e.channel.addEventListener('close', () => {
        broadcastDirectState({ phase: 'standby' });
      });
    };

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await waitCandidatesGathered(pc, 4500);

    const answerInfo = C.parseSdp(pc.localDescription.sdp);
    const replyCode = C.encode({ type: 'answer', code: dec.code, info: answerInfo });

    directJoinSession = { pc, replyCode };
    broadcastDirectState({ phase: 'reply-ready', replyCode, hostCode });
  } catch (err) {
    broadcastDirectState({ phase: 'error', message: err.message || 'Failed to join host code' });
  }
}

function handleDirectDisconnect() {
  if (rtcPeers.has('direct-peer')) {
    cleanupPeer('direct-peer');
  }
  if (directHostSession) {
    try { directHostSession.pc?.close(); } catch (_) {}
    directHostSession = null;
  }
  if (directJoinSession) {
    try { directJoinSession.pc?.close(); } catch (_) {}
    directJoinSession = null;
  }
  broadcastDirectState({ phase: 'standby' });
}

onTauriEvent('direct-p2p-cmd', (e) => {
  const p = e.payload || {};
  if (p.action === 'gen-offer') handleDirectGenOffer();
  else if (p.action === 'accept-reply') handleDirectAcceptReply(p.replyCode);
  else if (p.action === 'join-offer') handleDirectJoinOffer(p.hostCode);
  else if (p.action === 'disconnect') handleDirectDisconnect();
  else if (p.action === 'clear-error') broadcastDirectState({ phase: 'standby' });
  else if (p.action === 'get-state') broadcastDirectState(getDirectP2PCurrentState());
});
