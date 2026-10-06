const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');

if (!roomId) {
  window.location.href = '/';
}

// ======== Error Reporting ========
function reportError(message, stack, context) {
  try {
    fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'viewer',
        level: 'error',
        message: String(message).slice(0, 2000),
        stack: stack ? String(stack).slice(0, 5000) : null,
        context: context || null,
        room_id: roomId,
        app_version: '1.6.0',
        user_agent: navigator.userAgent
      })
    }).catch(() => {});
  } catch {}
}

window.onerror = (msg, src, line, col, err) => {
  reportError(`${msg} at ${src}:${line}:${col}`, err?.stack);
};
window.onunhandledrejection = (e) => {
  const err = e.reason;
  reportError(err?.message || String(err), err?.stack, { type: 'unhandledrejection' });
};

document.getElementById('room-code').textContent = roomId;

const socket = io();
const viewerCount = document.getElementById('viewer-count');
const remoteVideo = document.getElementById('remote-video');
const placeholder = document.getElementById('placeholder');
const statusText = document.getElementById('status-text');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnMute = document.getElementById('btn-mute');
const videoArea = document.getElementById('video-area');

const FALLBACK_ICE = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};
let iceCache = { config: null, fetchedAt: 0 };

async function getIceConfig() {
  if (iceCache.config && Date.now() - iceCache.fetchedAt < 3600000) return iceCache.config;
  try {
    const res = await fetch('/api/ice-servers');
    const data = await res.json();
    iceCache = { config: { iceServers: data.iceServers }, fetchedAt: Date.now() };
    return iceCache.config;
  } catch {
    return FALLBACK_ICE;
  }
}
getIceConfig();

async function iceDiagnostics(peer) {
  const out = { local: [], remote: [], pairs: [] };
  try {
    const stats = await peer.getStats();
    for (const r of stats.values()) {
      if (r.type === 'local-candidate') out.local.push(`${r.candidateType}/${r.protocol}`);
      else if (r.type === 'remote-candidate') out.remote.push(`${r.candidateType}/${r.protocol}`);
      else if (r.type === 'candidate-pair') out.pairs.push(r.state);
    }
  } catch {}
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
  out.hasTurn = !!iceCache.config?.iceServers.some(s => [].concat(s.urls).some(u => u.startsWith('turn')));
  return out;
}

// The connection of the stream on stage (stats and the info panel read it); see the channels below
let pc = null;

// Main first: it's the only H264 profile the host's GPU encoder accepts; others fall back to CPU
function preferH264(sdp) {
  const lines = sdp.split('\r\n');
  const videoMLine = lines.findIndex(l => l.startsWith('m=video'));
  if (videoMLine === -1) return sdp;
  let end = lines.length;
  const h264Payloads = [];
  for (let i = videoMLine + 1; i < lines.length; i++) {
    if (lines[i].startsWith('m=')) { end = i; break; }
    const match = lines[i].match(/^a=rtpmap:(\d+)\s+H264\//i);
    if (match) h264Payloads.push(match[1]);
  }
  if (h264Payloads.length === 0) return sdp;
  const rank = {};
  for (const pt of h264Payloads) rank[pt] = 2;
  for (let i = videoMLine + 1; i < end; i++) {
    const f = lines[i].match(/^a=fmtp:(\d+) .*profile-level-id=([0-9a-f]{2})/i);
    if (f && f[1] in rank) {
      const profile = f[2].toLowerCase();
      rank[f[1]] = profile === '4d' ? 0 : profile === '64' ? 1 : 2;
    }
  }
  h264Payloads.sort((a, b) => rank[a] - rank[b]);
  const parts = lines[videoMLine].split(' ');
  const header = parts.slice(0, 3);
  const payloads = parts.slice(3);
  const reordered = [...h264Payloads, ...payloads.filter(p => !h264Payloads.includes(p))];
  lines[videoMLine] = [...header, ...reordered].join(' ');
  return lines.join('\r\n');
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// A mistyped or expired code would otherwise wait forever: check the room exists before joining.
// (Joining also creates it, so the check has to come first.) The server may have just woken up with
// the host still reconnecting, so a missing room gets a few tries before the page says so, and keeps
// being checked afterwards in case the host comes back.
let roomConfirmed = false;
let roomWatch = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function roomExists() {
  try {
    const res = await fetch(`/api/room/${encodeURIComponent(roomId)}`, { cache: 'no-store' });
    if (res.status === 404) return false;
    return true;
  } catch {
    return true; // network trouble is not proof the room is gone
  }
}

function showRoomNotFound() {
  statusText.textContent = 'Essa sala não existe ou já foi fechada';
  const form = document.getElementById('room-retry');
  form.hidden = false;
  clearInterval(roomWatch);
  roomWatch = setInterval(async () => {
    if (!(await roomExists())) return;
    clearInterval(roomWatch);
    form.hidden = true;
    roomConfirmed = true;
    statusText.textContent = 'Esperando o host compartilhar a tela…';
    socket.emit('join-room', { roomId, asHost: false });
  }, 5000);
}

document.getElementById('room-retry').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = document.getElementById('retry-code').value.trim().toLowerCase();
  if (code) window.location.href = `/room.html?room=${encodeURIComponent(code)}`;
});

// Join room as viewer (re-joins automatically on reconnection)
socket.on('connect', async () => {
  if (!roomConfirmed) {
    let found = false;
    for (let i = 0; i < 4 && !found; i++) {
      found = await roomExists();
      if (!found && i < 3) await sleep(2500);
    }
    if (!found) { showRoomNotFound(); return; }
    roomConfirmed = true;
  }
  socket.emit('join-room', { roomId, asHost: false });
});

const hostNotice = document.getElementById('host-notice');
let hostNoticeDismissed = false;
document.getElementById('host-notice-close').addEventListener('click', () => {
  hostNoticeDismissed = true;
  hostNotice.style.display = 'none';
});

// ======== Streams: one channel per streamer ========
// A room has its owner and, in group mode, up to 3 more streamers. Each gets a channel with its own
// connection (direct or through the SFU). The stage shows the selected channel; the others keep
// playing their sound (each can be muted on its own) and are asked not to send video meanwhile.
const channels = new Map();
let selectedId = null;
let hostsInfo = [];
let groupOpen = false;
const streamList = document.getElementById('stream-list');

function channelFor(hostId) {
  let ch = channels.get(hostId);
  if (!ch) {
    ch = { hostId, pc: null, paused: false, stream: null, audioEl: null, muted: false, offerToken: 0, sfuToken: 0, earlyIce: [], status: 'Abrindo a tela…' };
    channels.set(hostId, ch);
  }
  return ch;
}

const infoFor = (hostId) => hostsInfo.find(h => h.id === hostId) || null;

function closeChannelPc(ch) {
  if (ch.pc) { try { ch.pc.close(); } catch {} }
  ch.pc = null;
  ch.stream = null;
}

function dropChannel(hostId) {
  const ch = channels.get(hostId);
  if (!ch) return;
  closeChannelPc(ch);
  ch.sfuToken++;
  ch.offerToken++;
  if (ch.audioEl) { ch.audioEl.srcObject = null; ch.audioEl.remove(); }
  channels.delete(hostId);
}

// The stream that goes on stage when the current one ends: anything that's playing, owner first
function pickPlayable() {
  const playable = [...channels.values()].filter(c => c.stream && !c.paused);
  playable.sort((a, b) => (infoFor(a.hostId)?.slot ?? 9) - (infoFor(b.hostId)?.slot ?? 9));
  return playable[0]?.hostId || null;
}

function select(hostId) {
  selectedId = hostId;
  renderStage();
  updateWatching();
  syncSfuVideo();
  renderStreamList();
}

// Viewers tell each streamer whether they want its video right now (audio always flows)
function updateWatching() {
  for (const ch of channels.values()) {
    if (!ch.pc || ch.pc.isSfu) continue;
    const video = ch.hostId === selectedId;
    if (ch.pc.watchSent === video) continue;
    ch.pc.watchSent = video;
    socket.emit('watch', { hostId: ch.hostId, video });
  }
}

function renderStage() {
  const ch = selectedId ? channels.get(selectedId) : null;
  pc = ch?.pc || null; // stats and the info panel follow the stream on stage
  syncSfuVideo();
  // A stream that only brought its sound (media server, off stage) waits for its video here
  if (ch && ch.stream && !ch.paused && ch.stream.getVideoTracks().length) {
    const isNewStream = remoteVideo.srcObject !== ch.stream;
    remoteVideo.srcObject = ch.stream;
    remoteVideo.style.display = 'block';
    placeholder.style.display = 'none';
    btnFullscreen.style.display = '';
    btnInfo.style.display = '';
    volumeControl.style.display = '';
    statusText.textContent = '';
    if (isNewStream) { applyInitialAudio(); setInfoOpen(infoWanted); resetAgg(); }
  } else {
    remoteVideo.style.display = 'none';
    remoteVideo.srcObject = null;
    placeholder.style.display = '';
    btnFullscreen.style.display = 'none';
    btnInfo.style.display = 'none';
    setInfoOpen(false);
    volumeControl.style.display = 'none';
    statusText.textContent = ch ? ch.status : (hostsInfo.length ? 'Host conectado, abrindo a tela…' : 'Esperando o host entrar…');
  }
  routeAudio();
}

// The stage's sound plays through the video element (volume, mute and autoplay rules live there).
// Other channels play through their own hidden audio element that copies the stage's volume.
function routeAudio() {
  for (const ch of channels.values()) {
    for (const t of ch.stream?.getAudioTracks() || []) t.enabled = !ch.muted;
    const offStage = ch.stream && !ch.paused && ch.stream !== remoteVideo.srcObject && ch.stream.getAudioTracks().length;
    if (offStage) {
      if (!ch.audioEl) {
        ch.audioEl = document.createElement('audio');
        ch.audioEl.autoplay = true;
        ch.audioEl.hidden = true;
        document.body.appendChild(ch.audioEl);
      }
      if (ch.audioEl.srcObject?.getAudioTracks()[0] !== ch.stream.getAudioTracks()[0]) {
        ch.audioEl.srcObject = new MediaStream(ch.stream.getAudioTracks());
      }
      ch.audioEl.volume = remoteVideo.volume;
      ch.audioEl.muted = remoteVideo.muted;
      ch.audioEl.play().catch(() => {});
    } else if (ch.audioEl) {
      ch.audioEl.srcObject = null;
    }
  }
}
remoteVideo.addEventListener('volumechange', routeAudio);

function showStream(ch, stream, peer) {
  ch.stream = stream;
  ch.paused = false;
  for (const receiver of peer.getReceivers()) {
    if (receiver.jitterBufferTarget !== undefined) receiver.jitterBufferTarget = 0;
  }
  const current = selectedId && channels.get(selectedId);
  if (!current || !current.stream || current.paused) selectedId = ch.hostId;
  renderStage();
  updateWatching();
  renderStreamList();
}

function setChannelStatus(ch, text) {
  ch.status = text;
  if (ch.hostId === selectedId && !(ch.stream && !ch.paused)) statusText.textContent = text;
  renderStreamList();
}

// Ask one streamer for a fresh connection, leaving the other channels alone
function requestNewOffer(ch, message) {
  closeChannelPc(ch);
  if (ch.paused) return;
  setChannelStatus(ch, message);
  if (ch.hostId === selectedId) renderStage();
  socket.emit('request-offer', { hostId: ch.hostId });
}

socket.on('room-update', ({ hasHost, viewerCount: count, hostOutdated, group, hosts }) => {
  viewerCount.textContent = `${count} assistindo`;
  hostsInfo = Array.isArray(hosts) ? hosts : [];
  groupOpen = !!group;
  // Channels of streamers no longer in the room
  if (Array.isArray(hosts)) {
    for (const id of [...channels.keys()]) if (!hostsInfo.some(h => h.id === id)) dropChannel(id);
  }
  if (selectedId && !channels.has(selectedId)) selectedId = pickPlayable();
  if (!hasHost && !channels.size) statusText.textContent = 'Esperando o host entrar…';
  hostNotice.style.display = hostOutdated && !hostNoticeDismissed ? '' : 'none';
  renderStage();
  renderStreamList();
});

socket.on('host-joined', ({ hostId } = {}) => {
  if (!hostId) return;
  const ch = channelFor(hostId);
  ch.paused = false;
  setChannelStatus(ch, 'Host conectado, abrindo a tela…');
  if (!selectedId) { selectedId = hostId; renderStage(); }
});

socket.on('host-left', ({ hostId } = {}) => {
  const wasSelected = hostId === selectedId;
  dropChannel(hostId);
  if (wasSelected) {
    selectedId = pickPlayable();
    if (!selectedId && !channels.size) statusText.textContent = 'O host desconectou';
  }
  renderStage();
  updateWatching();
  renderStreamList();
});

socket.on('host-paused', ({ hostId } = {}) => {
  const ch = channels.get(hostId);
  if (!ch) return;
  closeChannelPc(ch);
  ch.paused = true;
  ch.sfuToken++;
  ch.offerToken++;
  setChannelStatus(ch, 'O host pausou a transmissão');
  // Keep watching someone else if there is anyone
  if (hostId === selectedId) selectedId = pickPlayable() || hostId;
  renderStage();
  updateWatching();
  renderStreamList();
});

// ======== SFU mode ========
// With 3+ viewers a streamer publishes once to a media server and everyone pulls from it.
async function sfuFetch(method, path, body) {
  const res = await fetch(`/api/sfu${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, ...body })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errorCode) throw new Error(data.errorDescription || data.errorCode || `SFU HTTP ${res.status}`);
  return data;
}

function waitConnected(peer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    const check = () => {
      if (peer.connectionState === 'connected') { clearTimeout(timer); resolve(); }
      else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        clearTimeout(timer);
        reject(new Error(peer.connectionState));
      }
    };
    peer.addEventListener('connectionstatechange', check);
    check();
  });
}

socket.on('sfu-start', ({ hostId, sessionId, tracks } = {}) => {
  if (!hostId || !Array.isArray(tracks)) return;
  const ch = channelFor(hostId);
  ch.sfuInfo = { sessionId, tracks };
  pullSfu(ch);
});

// The media server bills every track it sends out, so a stream that isn't on stage pulls only
// its sound; picking it pulls again with the video (the old connection plays until the new one is up)
function sfuWantsVideo(ch) {
  return !selectedId || ch.hostId === selectedId;
}

function syncSfuVideo() {
  for (const ch of channels.values()) {
    if (!ch.pc?.isSfu || !ch.sfuInfo || ch.paused) continue;
    const want = sfuWantsVideo(ch);
    if (want === ch.pc.hasVideo) { clearTimeout(ch.sfuDropTimer); ch.sfuDropTimer = null; continue; }
    if (ch.sfuPulling === want) continue;
    if (want) { clearTimeout(ch.sfuDropTimer); ch.sfuDropTimer = null; pullSfu(ch); }
    // Dropping the video waits a little, in case the viewer flips straight back
    else if (!ch.sfuDropTimer) {
      ch.sfuDropTimer = setTimeout(() => {
        ch.sfuDropTimer = null;
        if (ch.pc?.isSfu && ch.pc.hasVideo && !sfuWantsVideo(ch)) pullSfu(ch);
      }, 8000);
    }
  }
}

async function pullSfu(ch) {
  const { sessionId, tracks } = ch.sfuInfo;
  const withVideo = sfuWantsVideo(ch) || !tracks.includes('audio');
  const wanted = withVideo ? tracks : tracks.filter(t => t !== 'video');
  const myToken = ++ch.sfuToken;
  ch.sfuPulling = wanted.includes('video');
  ch.offerToken++;
  ch.paused = false;
  let sfuPc = null;
  try {
    const iceConfig = await getIceConfig();
    const session = await sfuFetch('POST', '/sessions');
    if (myToken !== ch.sfuToken) return;

    sfuPc = new RTCPeerConnection({ ...iceConfig, bundlePolicy: 'max-bundle' });
    sfuPc.isSfu = true;
    sfuPc.hasVideo = wanted.includes('video');
    sfuPc.pendingIce = [];
    const stream = new MediaStream();
    sfuPc.ontrack = (e) => {
      stream.addTrack(e.track);
      if (ch.pc === sfuPc) showStream(ch, stream, sfuPc);
    };

    const pulled = await sfuFetch('POST', `/sessions/${session.sessionId}/tracks`, {
      tracks: wanted.map(trackName => ({ location: 'remote', sessionId, trackName }))
    });
    const ok = (pulled.tracks || []).filter(t => !t.errorCode);
    if (ok.length === 0) throw new Error(pulled.tracks?.[0]?.errorDescription || 'no tracks');
    if (pulled.requiresImmediateRenegotiation) {
      await sfuPc.setRemoteDescription(pulled.sessionDescription);
      const answer = await sfuPc.createAnswer();
      await sfuPc.setLocalDescription(answer);
      await sfuFetch('PUT', `/sessions/${session.sessionId}/renegotiate`, {
        sessionDescription: { type: 'answer', sdp: answer.sdp }
      });
    }
    await waitConnected(sfuPc, 10000);
    if (myToken !== ch.sfuToken) { sfuPc.close(); return; }

    // The previous direct connection kept playing until now, so the swap has no black gap
    const previous = ch.pc;
    ch.pc = sfuPc;
    if (previous) { try { previous.close(); } catch {} }
    if (stream.getTracks().length) showStream(ch, stream, sfuPc);

    // The host sends H264 Main through an SFU that advertises baseline. A decoder that can't
    // take it shows a connected stream with no picture, so check that frames really decode.
    setTimeout(async () => {
      if (ch.pc !== sfuPc || ch.paused) return;
      let decoded = 0;
      try {
        for (const r of (await sfuPc.getStats()).values()) {
          if (r.type === 'inbound-rtp' && r.kind === 'video') decoded = r.framesDecoded || 0;
        }
      } catch {}
      // Off-stage channels may legitimately not decode video; only the one being watched counts
      if (decoded === 0 && sfuPc.hasVideo && ch.pc === sfuPc && ch.hostId === selectedId) {
        reportError('SFU video not decoding', null, { sessionId });
        ch.sfuToken++;
        socket.emit('sfu-fallback', { hostId: ch.hostId });
      }
    }, 8000);

    sfuPc.onconnectionstatechange = () => {
      if (ch.pc !== sfuPc || ch.paused) return;
      const state = sfuPc.connectionState;
      if (state === 'failed') {
        reportError('SFU connection failed', null, { sessionId });
        requestNewOffer(ch, 'Conexão perdida. Reconectando…');
      } else if (state === 'disconnected') {
        setTimeout(() => {
          if (ch.pc === sfuPc && sfuPc.connectionState === 'disconnected') requestNewOffer(ch, 'Reconectando…');
        }, 3000);
      }
    };
  } catch (err) {
    if (sfuPc) sfuPc.close();
    if (myToken !== ch.sfuToken) return;
    reportError('SFU pull failed: ' + err.message, err.stack, { sessionId });
    // Ask the streamer for a direct connection instead; the 'offer' handler takes it from there
    socket.emit('sfu-fallback', { hostId: ch.hostId });
  } finally {
    if (myToken === ch.sfuToken) ch.sfuPulling = undefined;
  }
}

socket.on('sfu-stop', ({ hostId } = {}) => {
  const ch = channels.get(hostId);
  if (!ch) return;
  ch.sfuToken++;
  ch.sfuInfo = null;
  if (ch.pc && ch.pc.isSfu) requestNewOffer(ch, 'Reconectando…');
});

socket.on('offer', async ({ from, offer, sid }) => {
  const ch = channelFor(from);
  if (ch.pc) {
    try { ch.pc.close(); } catch {}
  }

  ch.paused = false;
  ch.pc = null;
  ch.sfuToken++;
  const myToken = ++ch.offerToken;
  const iceConfig = await getIceConfig();
  if (myToken !== ch.offerToken) return;

  const thisPc = new RTCPeerConnection(iceConfig);
  ch.pc = thisPc;
  thisPc.pendingIce = ch.earlyIce.filter(e => e.sid === sid).map(e => e.candidate);
  ch.earlyIce = [];
  thisPc.sid = sid;

  setTimeout(async () => {
    if (ch.pc === thisPc && thisPc.connectionState !== 'connected') {
      const diag = await iceDiagnostics(thisPc);
      reportError('ICE timeout 10s', null, { state: thisPc.connectionState, sid, ...diag });
      if (ch.pc === thisPc) requestNewOffer(ch, 'A conexão está demorando, tentando de novo…');
    }
  }, 10000);

  thisPc.ontrack = (e) => showStream(ch, e.streams[0], thisPc);

  thisPc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: from, candidate: e.candidate, sid });
    }
  };

  thisPc.onconnectionstatechange = () => {
    if (ch.pc !== thisPc) return;
    const state = thisPc.connectionState;
    if (state === 'connected') {
      setChannelStatus(ch, 'Abrindo a tela…');
      updateWatching();
    } else if (state === 'disconnected') {
      if (ch.paused) return;
      setChannelStatus(ch, 'Reconectando…');
      setTimeout(() => {
        if (ch.pc === thisPc && thisPc.connectionState === 'disconnected') {
          requestNewOffer(ch, 'Reconectando…');
        }
      }, 3000);
    } else if (state === 'failed') {
      iceDiagnostics(thisPc).then(diag => reportError('PeerConnection failed', null, { sid, ...diag }));
      requestNewOffer(ch, 'Conexão perdida. Reconectando…');
    }
  };

  try {
    await thisPc.setRemoteDescription(offer);
    for (const c of thisPc.pendingIce.splice(0)) thisPc.addIceCandidate(c).catch(() => {});
    const answer = await thisPc.createAnswer();
    const h264Answer = { type: answer.type, sdp: preferH264(answer.sdp) };
    await thisPc.setLocalDescription(h264Answer);
    if (ch.pc !== thisPc) return;
    socket.emit('answer', { to: from, answer: h264Answer, sid });
  } catch (err) {
    console.error('Negotiation failed', err);
    reportError('Negotiation failed: ' + err.message, err.stack, { from });
  }
});

socket.on('ice-candidate', ({ from, candidate, sid }) => {
  const ch = channelFor(from);
  if (!ch.pc) {
    if (ch.earlyIce.length < 100) ch.earlyIce.push({ sid, candidate });
    return;
  }
  if (sid !== undefined && sid !== ch.pc.sid) return;
  if (ch.pc.remoteDescription) ch.pc.addIceCandidate(candidate).catch(() => {});
  else ch.pc.pendingIce.push(candidate);
});

// ======== Stream list (group rooms) ========
// One row per streamer with its frog colour; picking one puts it on stage. The speaker button
// mutes just that streamer. With the group open and a free slot, viewers can join in from here.
const SHARE_URL = () => `frogshare://share?room=${encodeURIComponent(roomId)}`;

function streamState(info) {
  const ch = channels.get(info.id);
  if (info.paused || ch?.paused) return 'pausado';
  if (ch?.stream) return 'ao vivo';
  return 'conectando…';
}

function renderStreamList() {
  if (!streamList) return;
  const show = hostsInfo.length > 1 || groupOpen;
  streamList.hidden = !show;
  document.body.classList.toggle('has-stream-list', show);
  if (!show) {
    // Without the list there's no way to undo a per-stream mute: the player's volume is the only control
    if ([...channels.values()].some(c => c.muted)) {
      for (const c of channels.values()) c.muted = false;
      routeAudio();
    }
    return;
  }
  const items = hostsInfo.slice().sort((a, b) => a.slot - b.slot).map((info, i) => {
    const ch = channels.get(info.id);
    const row = document.createElement('div');
    row.className = `stream-item slot-${info.slot}` + (info.id === selectedId ? ' selected' : '');
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'stream-pick';
    pick.setAttribute('aria-pressed', String(info.id === selectedId));
    pick.title = `Assistir ${info.name} (tecla ${i + 1})`;
    const frog = Object.assign(document.createElement('img'), { src: '/brand/frog-head.svg', alt: '', className: 'stream-frog' });
    const text = document.createElement('span');
    text.className = 'stream-text';
    text.append(
      Object.assign(document.createElement('span'), { className: 'stream-name', textContent: info.name + (info.owner ? ' · dono' : '') }),
      Object.assign(document.createElement('span'), { className: 'stream-state', textContent: streamState(info) })
    );
    pick.append(frog, text);
    pick.addEventListener('click', () => { if (ch?.stream && !ch.paused) select(info.id); else { selectedId = info.id; renderStage(); renderStreamList(); } });
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'btn btn-ghost btn-icon stream-mute';
    const muted = !!ch?.muted;
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', (muted ? 'Ativar o som de ' : 'Mutar ') + info.name);
    mute.title = muted ? 'Ativar o som' : 'Mutar só esta transmissão';
    mute.innerHTML = muted
      ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"/><path d="M16 10l4 4m0 -4l-4 4"/></svg>'
      : '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"/><path d="M15 8a5 5 0 0 1 0 8"/></svg>';
    mute.addEventListener('click', () => {
      const c = channelFor(info.id);
      c.muted = !c.muted;
      routeAudio();
      renderStreamList();
    });
    row.append(pick, mute);
    return row;
  });
  const children = [
    Object.assign(document.createElement('p'), { className: 'stream-list-title', textContent: hostsInfo.length > 1 ? 'Transmissões' : 'Transmissão em grupo' }),
    ...items
  ];
  if (groupOpen && hostsInfo.length < 4) {
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'btn btn-secondary stream-share';
    share.textContent = 'Compartilhar minha tela aqui';
    share.addEventListener('click', openShareInApp);
    children.push(share);
  }
  streamList.replaceChildren(...children);
}

// Opens the FrogShare app straight into this room. If nothing takes the link (app not installed),
// the page is still in focus a moment later: offer the download instead.
function openShareInApp() {
  let left = false;
  const onBlur = () => { left = true; };
  window.addEventListener('blur', onBlur, { once: true });
  window.location.href = SHARE_URL();
  setTimeout(() => {
    window.removeEventListener('blur', onBlur);
    if (!left && !document.hidden) document.getElementById('share-help').hidden = false;
  }, 2500);
}
document.getElementById('share-help-close')?.addEventListener('click', () => { document.getElementById('share-help').hidden = true; });

// Fullscreen
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (document.fullscreenEnabled && videoArea.requestFullscreen) {
    videoArea.requestFullscreen().then(lockLandscape).catch(() => {});
  } else if (remoteVideo.webkitEnterFullscreen) {
    // iPhone Safari can't put a page element in fullscreen, only a video, in the system player
    // (which turns with the phone on its own)
    remoteVideo.webkitEnterFullscreen();
  }
}

// On a phone, fullscreen means sideways, like a video app. Android Chrome allows the lock only while
// in fullscreen; elsewhere it's rejected and the page simply follows the phone.
function lockLandscape() {
  const orientation = screen.orientation;
  if (!orientation || !orientation.lock || !matchMedia('(pointer: coarse)').matches) return;
  orientation.lock('landscape').catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
  btnFullscreen.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  if (!document.fullscreenElement) {
    try { screen.orientation?.unlock?.(); } catch {}
  }
});

btnFullscreen.addEventListener('click', toggleFullscreen);
// Double-click on the picture toggles fullscreen; quick clicks on the control bar must not
videoArea.addEventListener('dblclick', (e) => { if (!e.target.closest('.player-bar')) toggleFullscreen(); });

// ======== Stream info & viewer telemetry ========
const btnInfo = document.getElementById('btn-info');
const statsOverlay = document.getElementById('stats-overlay');
const statsLines = document.getElementById('stats-lines');
// The viewer's choice sticks across streams and visits; the panel only shows while there is video
const INFO_KEY = 'fs-stream-info';
let infoWanted = false;
try { infoWanted = localStorage.getItem(INFO_KEY) === '1'; } catch {}
let infoOpen = false;
let prevVideo = null;
let prevPc = null;
let agg = null;

function resetAgg() {
  agg = { n: 0, fpsSum: 0, fpsMin: Infinity, freezes: 0, freezeMs: 0, lost: 0, packets: 0, kbpsSum: 0, jbSum: 0, last: null };
}
resetAgg();

async function sampleInbound() {
  if (!pc || pc.connectionState !== 'connected') return null;
  const stats = await pc.getStats();
  let v, pair;
  for (const r of stats.values()) {
    if (r.type === 'inbound-rtp' && r.kind === 'video') v = r;
    else if (r.type === 'candidate-pair' && r.nominated) pair = r;
  }
  if (!v) return null;
  const p = prevPc === pc ? prevVideo : null;
  prevVideo = v;
  prevPc = pc;
  if (!p) return null;
  const dt = (v.timestamp - p.timestamp) / 1000;
  const lost = Math.max(0, v.packetsLost - p.packetsLost);
  const recv = Math.max(0, v.packetsReceived - p.packetsReceived);
  const emitted = v.jitterBufferEmittedCount - p.jitterBufferEmittedCount;
  const local = pair && stats.get(pair.localCandidateId);
  const remote = pair && stats.get(pair.remoteCandidateId);
  return {
    res: `${v.frameWidth || 0}x${v.frameHeight || 0}`,
    fps: v.framesPerSecond || 0,
    kbps: dt > 0 ? Math.round((v.bytesReceived - p.bytesReceived) * 8 / dt / 1000) : 0,
    lost,
    packets: lost + recv,
    freezes: Math.max(0, (v.freezeCount || 0) - (p.freezeCount || 0)),
    freezeMs: Math.max(0, Math.round(((v.totalFreezesDuration || 0) - (p.totalFreezesDuration || 0)) * 1000)),
    jbMs: emitted > 0 ? Math.round((v.jitterBufferDelay - p.jitterBufferDelay) / emitted * 1000) : null,
    rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    codec: (stats.get(v.codecId)?.mimeType || '').replace('video/', ''),
    decoder: v.decoderImplementation || '',
    relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
    sfu: !!pc.isSfu
  };
}

function renderOverlay(s) {
  statsLines.replaceChildren();
  const line = (text, cls) => {
    const el = document.createElement('div');
    el.textContent = text;
    if (cls) el.className = cls;
    statsLines.appendChild(el);
  };
  if (!s) { line('Coletando dados...'); return; }
  const lossPct = s.packets ? (100 * s.lost / s.packets) : 0;
  const delay = s.rttMs != null && s.jbMs != null ? Math.round(s.rttMs / 2 + s.jbMs) : null;
  line(`Resolução   ${s.res} @ ${s.fps} fps`, s.fps && s.fps < 24 ? 'bad' : null);
  line(`Codec       ${s.codec}${s.decoder ? ` (${s.decoder})` : ''}`);
  line(`Bitrate     ${(s.kbps / 1000).toFixed(1)} Mbps`);
  line(`Perda       ${lossPct.toFixed(1)}%`, lossPct > 2 ? 'bad' : 'ok');
  line(`Travadas    ${agg.freezes} (${(agg.freezeMs / 1000).toFixed(1)}s)`, agg.freezes ? 'bad' : 'ok');
  if (delay != null) line(`Atraso      ~${delay} ms (rede ${s.rttMs} + buffer ${s.jbMs})`, delay > 250 ? 'bad' : null);
  line(`Conexão     ${s.sfu ? 'servidor (SFU)' : s.relay ? 'via relay (TURN)' : 'direta (P2P)'}`);
}

function setInfoOpen(open) {
  infoOpen = open;
  statsOverlay.style.display = open ? '' : 'none';
  btnInfo.setAttribute('aria-pressed', String(open));
  if (open) renderOverlay(agg.last);
}

// A choice made by the viewer (button, x or the I key), remembered for next time
function toggleInfo(open = !infoOpen) {
  infoWanted = open;
  try { localStorage.setItem(INFO_KEY, open ? '1' : '0'); } catch {}
  setInfoOpen(open);
}
btnInfo.addEventListener('click', () => toggleInfo());
document.getElementById('stats-close').addEventListener('click', () => toggleInfo(false));

function flushTelemetry() {
  if (!agg.n) return;
  reportViewerStats({
    avgFps: +(agg.fpsSum / agg.n).toFixed(1),
    minFps: agg.fpsMin,
    freezes: agg.freezes,
    freezeMs: agg.freezeMs,
    lossPct: agg.packets ? +(100 * agg.lost / agg.packets).toFixed(2) : 0,
    avgKbps: Math.round(agg.kbpsSum / agg.n),
    avgJbMs: Math.round(agg.jbSum / agg.n),
    rttMs: agg.last?.rttMs,
    res: agg.last?.res,
    codec: agg.last?.codec,
    decoder: agg.last?.decoder,
    relay: agg.last?.relay,
    sfu: agg.last?.sfu,
    visible: !document.hidden
  });
  resetAgg();
}

setInterval(async () => {
  let s = null;
  try { s = await sampleInbound(); } catch {}
  if (s) {
    agg.n++;
    agg.fpsSum += s.fps;
    agg.fpsMin = Math.min(agg.fpsMin, s.fps);
    agg.freezes += s.freezes;
    agg.freezeMs += s.freezeMs;
    agg.lost += s.lost;
    agg.packets += s.packets;
    agg.kbpsSum += s.kbps;
    agg.jbSum += s.jbMs || 0;
    agg.last = s;
    if (agg.n >= 60) flushTelemetry();
  }
  if (infoOpen) renderOverlay(s || agg.last);
}, 1000);

function reportViewerStats(context) {
  try {
    fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'viewer-stats', level: 'info', message: 'quality', context, room_id: roomId, app_version: '1.6.0', user_agent: navigator.userAgent })
    }).catch(() => {});
  } catch {}
}

// ======== Volume ========
const volumeControl = document.getElementById('volume-control');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue = document.getElementById('volume-value');
const iconWave1 = document.getElementById('icon-vol-wave1');
const iconWave2 = document.getElementById('icon-vol-wave2');
const iconX = document.getElementById('icon-vol-x');

const VOL_KEY = 'ss-volume';
const MUTED_KEY = 'ss-muted';
let wantMuted = false;

try {
  const v = parseFloat(localStorage.getItem(VOL_KEY));
  if (v >= 0 && v <= 1) remoteVideo.volume = v;
  wantMuted = localStorage.getItem(MUTED_KEY) === '1';
} catch {}

function saveVolume() {
  try {
    localStorage.setItem(VOL_KEY, String(remoteVideo.volume));
    localStorage.setItem(MUTED_KEY, wantMuted ? '1' : '0');
  } catch {}
}

function updateVolumeUI() {
  const silent = remoteVideo.muted || remoteVideo.volume === 0;
  const pct = silent ? 0 : Math.round(remoteVideo.volume * 100);
  volumeSlider.value = pct;
  volumeSlider.style.setProperty('--fill', pct + '%');
  volumeValue.textContent = pct + '%';
  iconX.style.display = silent ? '' : 'none';
  iconWave1.style.display = silent ? 'none' : '';
  iconWave2.style.display = !silent && remoteVideo.volume > 0.5 ? '' : 'none';
  const label = silent ? 'Desmutar' : 'Mutar';
  btnMute.setAttribute('aria-label', label);
  btnMute.title = label + ' (M)';
}

remoteVideo.addEventListener('volumechange', updateVolumeUI);
updateVolumeUI();

let osdEl = null;
let osdTimer = null;
function showVolumeOsd() {
  if (!osdEl) {
    osdEl = document.createElement('div');
    osdEl.className = 'volume-osd';
    videoArea.appendChild(osdEl);
  }
  const silent = remoteVideo.muted || remoteVideo.volume === 0;
  osdEl.textContent = silent ? 'Mudo' : `Volume ${Math.round(remoteVideo.volume * 100)}%`;
  osdEl.classList.add('visible');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osdEl.classList.remove('visible'), 900);
}

function setVolume(v) {
  v = Math.min(1, Math.max(0, v));
  remoteVideo.volume = v;
  wantMuted = v === 0;
  remoteVideo.muted = wantMuted;
  if (!wantMuted) remoteVideo.play().catch(() => {});
  saveVolume();
}

function toggleMute() {
  if (remoteVideo.muted || remoteVideo.volume === 0) {
    if (remoteVideo.volume === 0) remoteVideo.volume = 0.5;
    wantMuted = false;
    remoteVideo.muted = false;
    remoteVideo.play().catch(() => {});
  } else {
    wantMuted = true;
    remoteVideo.muted = true;
  }
  saveVolume();
}

// Browsers only allow autoplay while muted; unmuting without a click can pause the video
function applyInitialAudio() {
  remoteVideo.play().then(() => {
    if (wantMuted) return;
    remoteVideo.muted = false;
    if (remoteVideo.paused) {
      remoteVideo.muted = true;
      remoteVideo.play().catch(() => {});
      showToast('O navegador abriu sem som: toque na tela para ouvir');
    }
  }).catch(() => {
    showToast('O navegador abriu sem som: toque na tela para ouvir');
  });
}

// Phones (and most browsers) start the video muted. Any tap or key on the page counts as the
// viewer's permission, so the sound comes on with the first one instead of needing the speaker
// button. Not when the viewer muted on purpose, and not for taps on the volume controls themselves.
function unmuteOnInteraction(e) {
  if (e.target?.closest?.('#btn-mute, #volume-slider, #unmute-cta')) return;
  if (remoteVideo.style.display !== 'block' || !remoteVideo.muted || wantMuted) return;
  remoteVideo.muted = false;
  remoteVideo.play().catch(() => {});
}
for (const type of ['pointerup', 'click', 'keydown']) document.addEventListener(type, unmuteOnInteraction, true);

volumeSlider.addEventListener('input', () => setVolume(volumeSlider.value / 100));
btnMute.addEventListener('click', toggleMute);

videoArea.addEventListener('wheel', (e) => {
  if (volumeControl.style.display === 'none') return;
  e.preventDefault();
  const base = remoteVideo.muted ? 0 : remoteVideo.volume;
  setVolume(base + (e.deltaY < 0 ? 0.05 : -0.05));
  showVolumeOsd();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  // 1-4 pick a stream in group rooms; also works in fullscreen, where the list is out of view
  if (/^[1-4]$/.test(e.key) && hostsInfo.length > 1) {
    const info = hostsInfo.slice().sort((a, b) => a.slot - b.slot)[Number(e.key) - 1];
    const ch = info && channels.get(info.id);
    if (ch?.stream && !ch.paused) { select(info.id); showToast(`Assistindo ${info.name}`); }
    return;
  }
  if (volumeControl.style.display === 'none') return;
  const base = remoteVideo.muted ? 0 : remoteVideo.volume;
  if (e.key === 'ArrowUp') setVolume(base + 0.05);
  else if (e.key === 'ArrowDown') setVolume(base - 0.05);
  else if (e.key === 'm' || e.key === 'M') toggleMute();
  else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
  else if (e.key === 'i' || e.key === 'I') { toggleInfo(); return; }
  else return;
  e.preventDefault();
  showVolumeOsd();
});
