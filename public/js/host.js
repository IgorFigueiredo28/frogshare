// ======== Error Reporting ========
let _signalUrl = null;
async function getSignalUrl() {
  if (!_signalUrl) _signalUrl = await window.electronAPI.getSignalServer();
  return _signalUrl;
}

function reportError(message, stack, context) {
  getSignalUrl().then(url => {
    fetch(`${url}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'host',
        level: 'error',
        message: String(message).slice(0, 2000),
        stack: stack ? String(stack).slice(0, 5000) : null,
        context: context || null,
        room_id: roomId,
        app_version: '1.1.4',
        user_agent: navigator.userAgent
      })
    }).catch(() => {});
  }).catch(() => {});
}

window.onerror = (msg, src, line, col, err) => {
  reportError(`${msg} at ${src}:${line}:${col}`, err?.stack);
};
window.onunhandledrejection = (e) => {
  const err = e.reason;
  reportError(err?.message || String(err), err?.stack, { type: 'unhandledrejection' });
};

// ======== State ========
let selectedSourceId = null;
let selectedPid = null;
let localStream = null;
let audioContext = null;
let audioWorkletNode = null;
let socket = null;
const peerConnections = new Map();
let offerSeq = 0;
let roomId = null;
let signalServer = '';
let isStreaming = false;

const FALLBACK_ICE = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};
let iceCache = { config: null, fetchedAt: 0 };

// TURN credentials come from the signaling server so they can rotate without an app update
async function getIceConfig() {
  if (iceCache.config && Date.now() - iceCache.fetchedAt < 3600000) return iceCache.config;
  try {
    const url = await getSignalUrl();
    const res = await fetch(`${url}/api/ice-servers`);
    const data = await res.json();
    iceCache = { config: { iceServers: data.iceServers }, fetchedAt: Date.now() };
    return iceCache.config;
  } catch {
    return iceCache.config || FALLBACK_ICE;
  }
}

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
  return out;
}

// Measured on Electron 33/Windows: only H264 Main reaches the GPU encoder (Media Foundation/NVENC);
// Constrained Baseline and High fall back to OpenH264 on the CPU, which competes with the game.
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
  const reordered = [
    ...h264Payloads,
    ...payloads.filter(p => !h264Payloads.includes(p))
  ];
  lines[videoMLine] = [...header, ...reordered].join(' ');
  return lines.join('\r\n');
}

// Applied to the remote answer: the sender's encoder reads these from the remote description.
// Without a start bitrate WebRTC ramps up from ~300kbps and the first seconds look blurry.
function tuneAnswerSdp(sdp) {
  const lines = sdp.split('\r\n');
  const videoPts = new Set();
  const opusPts = new Set();
  let section = '';
  for (const l of lines) {
    if (l.startsWith('m=')) section = l.slice(2, 7);
    const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (!m) continue;
    if (section === 'video' && /^(H264|VP8|VP9|AV1)$/i.test(m[2])) videoPts.add(m[1]);
    if (section === 'audio' && /^opus$/i.test(m[2])) opusPts.add(m[1]);
  }
  return lines.map(l => {
    const m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (!m) return l;
    if (videoPts.has(m[1]) && !m[2].includes('x-google-start-bitrate')) {
      return l + ';x-google-start-bitrate=4000;x-google-min-bitrate=1000;x-google-max-bitrate=12000';
    }
    if (opusPts.has(m[1]) && !m[2].includes('stereo=')) {
      return l + ';stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
    }
    return l;
  }).join('\r\n');
}

// ======== DOM ========
const panelSetup = document.getElementById('panel-setup');
const panelStreaming = document.getElementById('panel-streaming');
const sourceGrid = document.getElementById('source-grid');
const sessionList = document.getElementById('session-list');
const sessionsContainer = document.getElementById('audio-sessions-container');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnRefreshSources = document.getElementById('btn-refresh-sources');
const btnRefreshAudio = document.getElementById('btn-refresh-audio');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnCopyLink = document.getElementById('btn-copy-link');
const localPreview = document.getElementById('local-preview');

// A live preview repainting next to a game makes G-SYNC/FreeSync refresh swing, which VA panels
// show as whole-screen brightness flicker; only render it while this window has focus.
// document.hasFocus() stays true while a game is in the foreground, so focus comes from BrowserWindow events
let windowFocused = true;
function syncPreview() {
  const want = localStream && windowFocused && !document.hidden ? localStream : null;
  if (localPreview.srcObject !== want) localPreview.srcObject = want;
}
window.electronAPI.onWindowFocus((focused) => {
  windowFocused = focused;
  syncPreview();
});
document.addEventListener('visibilitychange', syncPreview);
const roomCodeEl = document.getElementById('room-code');
const viewerCountEl = document.getElementById('viewer-count');
const streamStatsEl = document.getElementById('stream-stats');
const audioModeRadios = document.querySelectorAll('input[name="audio-mode"]');
const roomBar = document.getElementById('room-bar');
const roomCodeBar = document.getElementById('room-code-bar');
const viewerCountBar = document.getElementById('viewer-count-bar');
const btnCopyCodeBar = document.getElementById('btn-copy-code-bar');

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function getAudioMode() {
  return document.querySelector('input[name="audio-mode"]:checked').value;
}

// ======== Source Selection ========
async function loadSources() {
  sourceGrid.innerHTML = '<div class="loading">Carregando janelas...</div>';
  const sources = await window.electronAPI.getSources();

  const screens = sources.filter(s => s.isScreen);
  const windows = sources.filter(s => !s.isScreen);

  sourceGrid.innerHTML = '';

  if (screens.length > 0) {
    const screenLabel = document.createElement('div');
    screenLabel.className = 'source-section-label';
    screenLabel.textContent = 'Telas (captura jogos em tela cheia)';
    sourceGrid.appendChild(screenLabel);

    screens.forEach(source => {
      const item = createSourceItem(source);
      sourceGrid.appendChild(item);
    });

    const windowLabel = document.createElement('div');
    windowLabel.className = 'source-section-label';
    windowLabel.textContent = 'Janelas';
    sourceGrid.appendChild(windowLabel);
  }

  windows.forEach(source => {
    const item = createSourceItem(source);
    sourceGrid.appendChild(item);
  });
}

function createSourceItem(source, onClick) {
  const item = document.createElement('div');
  item.className = 'source-item' + (source.id === selectedSourceId ? ' selected' : '');

  const thumb = document.createElement('img');
  thumb.className = 'source-thumb';
  thumb.src = source.thumbnail;
  thumb.alt = source.name;

  const label = document.createElement('div');
  label.className = 'source-label';
  if (source.appIcon) {
    const icon = document.createElement('img');
    icon.src = source.appIcon;
    label.appendChild(icon);
  }
  const name = document.createElement('span');
  name.title = source.name;
  name.textContent = source.name;
  label.appendChild(name);

  item.append(thumb, label);
  if (onClick) {
    item.addEventListener('click', onClick);
  } else {
    item.addEventListener('click', () => {
      document.querySelectorAll('#source-grid .source-item.selected').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedSourceId = source.id;
      updateStartButton();
    });
  }
  return item;
}

// ======== Audio Sessions ========
async function loadAudioSessions() {
  sessionList.innerHTML = '<div class="loading">Buscando processos com audio...</div>';
  const result = await window.electronAPI.listAudioSessions();

  if (result.error) {
    sessionList.innerHTML = `<div class="empty">Erro: ${result.error}</div>`;
    return;
  }

  const sessions = result.sessions || [];
  if (sessions.length === 0) {
    sessionList.innerHTML = '<div class="empty">Nenhum processo com audio encontrado. Inicie um app com audio e clique Atualizar.</div>';
    return;
  }

  sessionList.innerHTML = '';
  sessions.forEach(session => {
    const item = document.createElement('div');
    item.className = 'session-item' + (session.pid === selectedPid ? ' selected' : '');
    item.innerHTML = `
      <span class="session-name">${session.name}</span>
      <span class="session-pid">PID ${session.pid}</span>
      <span class="session-state ${session.state}">${session.state === 'active' ? 'Ativo' : 'Inativo'}</span>
    `;
    item.addEventListener('click', () => {
      document.querySelectorAll('.session-item.selected').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedPid = session.pid;
      updateStartButton();
    });
    sessionList.appendChild(item);
  });
}

// ======== Audio Mode Toggle ========
audioModeRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    const mode = getAudioMode();
    sessionsContainer.style.display = mode === 'process' ? '' : 'none';
    selectedPid = null;
    document.querySelectorAll('.session-item.selected').forEach(el => el.classList.remove('selected'));
    updateStartButton();
  });
});

function updateStartButton() {
  const mode = getAudioMode();
  const hasSource = !!selectedSourceId;
  const hasAudio = mode !== 'process' || !!selectedPid;
  btnStart.disabled = !(hasSource && hasAudio);
}

// ======== AudioWorklet for process audio ========
// Ring buffer with a latency cap: capture and AudioContext clocks drift apart,
// so without dropping old samples the audio slowly falls behind the video.
const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ch = options.processorOptions.channels;
    this.channels = ch;
    this.capacity = Math.ceil(sampleRate * 0.5) * ch;
    this.ring = new Float32Array(this.capacity);
    this.readPos = 0;
    this.available = 0;
    this.target = Math.ceil(sampleRate * 0.03) * ch;
    this.max = Math.ceil(sampleRate * 0.08) * ch;
    this.primed = false;
    this.port.onmessage = (e) => this.push(e.data);
  }

  skip(n) {
    n = Math.min(this.available, Math.ceil(n / this.channels) * this.channels);
    this.readPos = (this.readPos + n) % this.capacity;
    this.available -= n;
  }

  push(data) {
    let len = data.length;
    let src = 0;
    if (len > this.capacity) { src = len - this.capacity; len = this.capacity; }
    if (this.available + len > this.capacity) this.skip(this.available + len - this.capacity);

    const writePos = (this.readPos + this.available) % this.capacity;
    const first = Math.min(len, this.capacity - writePos);
    this.ring.set(data.subarray(src, src + first), writePos);
    if (first < len) this.ring.set(data.subarray(src + first, src + len), 0);
    this.available += len;

    if (this.available > this.max) this.skip(this.available - this.target);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    const ch = this.channels;

    if (!this.primed && this.available >= this.target) this.primed = true;
    const n = this.primed ? Math.min(frames, Math.floor(this.available / ch)) : 0;

    let r = this.readPos;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        if (c < out.length) out[c][i] = this.ring[r];
        if (++r === this.capacity) r = 0;
      }
    }
    for (let c = 0; c < out.length; c++) out[c].fill(0, n);

    this.readPos = r;
    this.available -= n * ch;
    if (n < frames) this.primed = false;
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

async function createAudioTrackFromProcess(sampleRate, channels) {
  audioContext = new AudioContext({ sampleRate, latencyHint: 'interactive' });

  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor', {
    numberOfInputs: 0,
    outputChannelCount: [channels],
    processorOptions: { channels }
  });

  const destination = audioContext.createMediaStreamDestination();
  audioWorkletNode.connect(destination);

  window.electronAPI.onAudioData((data) => {
    if (audioWorkletNode) {
      audioWorkletNode.port.postMessage(data, [data.buffer]);
    }
  });

  const track = destination.stream.getAudioTracks()[0];
  track.contentHint = 'music';
  return track;
}

// ======== Room Management (persistent) ========
async function ensureRoom() {
  // Socket.IO reconnects on its own; recreating here would orphan viewers in the old room
  if (roomId && socket) return;

  signalServer = await window.electronAPI.getSignalServer();
  const res = await fetch(`${signalServer}/api/room/create`);
  const data = await res.json();
  roomId = data.roomId;

  socket = io(signalServer);
  socket.on('connect', () => {
    socket.emit('join-room', { roomId, asHost: true });
  });

  socket.on('viewer-joined', async ({ viewerId }) => {
    if (isStreaming && localStream) {
      await createOfferForViewer(viewerId);
    }
  });

  socket.on('viewer-left', ({ viewerId }) => {
    const pc = peerConnections.get(viewerId);
    if (pc) pc.close();
    peerConnections.delete(viewerId);
  });

  socket.on('answer', async ({ from, answer, sid }) => {
    const pc = peerConnections.get(from);
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    // An answer to a superseded offer carries the wrong ICE credentials and would wedge the new peer
    if (sid !== undefined && sid !== pc.sid) return;
    try {
      await pc.setRemoteDescription({ type: answer.type, sdp: tuneAnswerSdp(answer.sdp) });
      for (const c of pc.pendingIce.splice(0)) pc.addIceCandidate(c).catch(() => {});
    } catch (err) {
      console.error('setRemoteDescription failed', err);
      reportError('setRemoteDescription failed: ' + err.message, err.stack, { from });
    }
  });

  socket.on('ice-candidate', ({ from, candidate, sid }) => {
    const pc = peerConnections.get(from);
    if (!pc || (sid !== undefined && sid !== pc.sid)) return;
    if (pc.remoteDescription) pc.addIceCandidate(candidate).catch(() => {});
    else pc.pendingIce.push(candidate);
  });

  socket.on('room-update', ({ viewerCount: count }) => {
    viewerCountEl.textContent = `${count} assistindo`;
    viewerCountBar.textContent = `${count} assistindo`;
  });

  roomCodeBar.textContent = roomId;
  roomBar.style.display = '';
}

// ======== Capture video (cursor hidden) ========
async function captureVideo(sourceId) {
  await window.electronAPI.setCaptureSource(sourceId);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { cursor: 'never', frameRate: { ideal: 60, max: 60 } },
    audio: false
  });
  const source = stream.getVideoTracks()[0];
  // 'detail' puts the encoder in screencast mode, which drops frames to keep text sharp
  source.contentHint = 'motion';
  return gpuBackedTrack(source);
}

// Desktop capture yields CPU-side ARGB frames, which Chromium's hardware encoder rejects,
// so WebRTC silently falls back to OpenH264 (~50ms/frame at 1080p, stealing CPU from the game).
// Redrawing each frame on a GPU canvas produces texture-backed frames that NVENC/AMF/QSV accept.
// Stream-based (not requestAnimationFrame) so it keeps running while the window is minimized.
function gpuBackedTrack(source) {
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') {
    return source;
  }
  const processor = new MediaStreamTrackProcessor({ track: source, maxBufferSize: 2 });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  generator.contentHint = 'motion';
  generator.sourceTrack = source;

  const settings = source.getSettings();
  const canvas = new OffscreenCanvas(settings.width || 1920, settings.height || 1080);
  const ctx = canvas.getContext('2d', { alpha: false });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();

  (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        const out = new VideoFrame(canvas, { timestamp: frame.timestamp });
        frame.close();
        await writer.write(out);
      }
    } catch (err) {
      if (generator.readyState === 'live') reportError('GPU frame pipeline failed: ' + err.message, err.stack);
    } finally {
      try { reader.releaseLock(); } catch {}
      try { await writer.close(); } catch {}
    }
  })();

  return generator;
}

function stopVideoTrack(track) {
  if (!track) return;
  track.stop();
  if (track.sourceTrack) track.sourceTrack.stop();
}

// ======== Start Streaming ========
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Iniciando...';

  try {
    const mode = getAudioMode();
    const isResume = !!roomId;

    // 1. Capture video with cursor hidden
    const videoTrack = await captureVideo(selectedSourceId);
    const tracks = [videoTrack];

    // 2. Handle audio based on mode
    if (mode === 'process' && selectedPid) {
      const result = await window.electronAPI.startAudioCapture(selectedPid);
      if (result.error) {
        showToast('Erro ao capturar audio: ' + result.error);
      } else {
        const audioTrack = await createAudioTrackFromProcess(
          result.sampleRate || 48000,
          result.channels || 2
        );
        tracks.push(audioTrack);
        showToast(`Audio capturado: ${result.sampleRate}Hz, ${result.channels}ch`);
      }
    } else if (mode === 'system') {
      const result = await window.electronAPI.startAudioCapture('system');
      if (result.error) {
        showToast('Erro ao capturar audio do sistema: ' + result.error);
      } else {
        const audioTrack = await createAudioTrackFromProcess(
          result.sampleRate || 48000,
          result.channels || 2
        );
        tracks.push(audioTrack);
        showToast(`Audio do sistema capturado: ${result.sampleRate}Hz`);
      }
    }

    localStream = new MediaStream(tracks);
    syncPreview();

    // 3. Create or reuse room
    await ensureRoom();
    isStreaming = true;

    // 4. If resuming, notify server — it re-sends viewer-joined for each viewer
    if (isResume) {
      socket.emit('host-resume');
    }

    (videoTrack.sourceTrack || videoTrack).addEventListener('ended', pauseStreaming);

    // 5. Switch to streaming panel
    roomCodeEl.textContent = roomId;
    panelSetup.style.display = 'none';
    panelStreaming.style.display = '';

    startStatsUpdate();

  } catch (err) {
    showToast('Erro: ' + err.message);
    reportError('Start streaming failed: ' + err.message, err.stack);
    btnStart.disabled = false;
    btnStart.textContent = roomId ? 'Retomar Compartilhamento' : 'Iniciar Compartilhamento';
  }
});

// ======== WebRTC ========
async function createOfferForViewer(viewerId) {
  const existing = peerConnections.get(viewerId);
  if (existing) existing.close();
  peerConnections.delete(viewerId);

  const iceConfig = await getIceConfig();
  if (peerConnections.has(viewerId) || !localStream) return;
  const pc = new RTCPeerConnection(iceConfig);
  pc.pendingIce = [];
  pc.sid = ++offerSeq;
  peerConnections.set(viewerId, pc);

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
  if (videoSender) {
    try {
      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = 12000000;
      params.encodings[0].maxFramerate = 60;
      params.encodings[0].networkPriority = 'high';
      params.encodings[0].priority = 'high';
      // maintain-framerate collapses resolution under bandwidth pressure, which is what makes it look blocky
      params.degradationPreference = 'balanced';
      await videoSender.setParameters(params);
    } catch (err) {
      console.warn('setParameters failed, using defaults', err);
      reportError('setParameters failed: ' + err.message, err.stack, { viewerId });
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: viewerId, candidate: e.candidate, sid: pc.sid });
    }
  };

  // 'disconnected' is often a transient blip that recovers; only tear down on failure
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      iceDiagnostics(pc).then(diag => reportError('PeerConnection failed', null, { viewerId, sid: pc.sid, ...diag }));
      pc.close();
      if (peerConnections.get(viewerId) === pc) peerConnections.delete(viewerId);
    } else if (pc.connectionState === 'closed') {
      if (peerConnections.get(viewerId) === pc) peerConnections.delete(viewerId);
    }
  };

  if (peerConnections.get(viewerId) !== pc) return;
  const offer = await pc.createOffer();
  const h264Offer = { type: offer.type, sdp: preferH264(offer.sdp) };
  await pc.setLocalDescription(h264Offer);
  if (peerConnections.get(viewerId) !== pc) return;
  socket.emit('offer', { to: viewerId, offer: h264Offer, sid: pc.sid });
}

// ======== Pause Streaming (room stays alive) ========
btnStop.addEventListener('click', pauseStreaming);

async function pauseStreaming() {
  isStreaming = false;

  if (localStream) {
    localStream.getTracks().forEach(t => t.kind === 'video' ? stopVideoTrack(t) : t.stop());
    localStream = null;
  }

  await window.electronAPI.stopAudioCapture();
  window.electronAPI.removeAudioListeners();

  if (audioWorkletNode) {
    audioWorkletNode.disconnect();
    audioWorkletNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  for (const [, pc] of peerConnections) {
    pc.close();
  }
  peerConnections.clear();

  if (socket) {
    socket.emit('host-pause');
  }

  syncPreview();

  panelStreaming.style.display = 'none';
  panelSetup.style.display = '';
  btnStart.textContent = 'Retomar Compartilhamento';
  updateStartButton();
}

// ======== Copy buttons ========
btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => showToast('Codigo copiado!'));
});

btnCopyCodeBar.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => showToast('Codigo copiado!'));
});

btnCopyLink.addEventListener('click', async () => {
  const url = signalServer || await window.electronAPI.getSignalServer();
  const link = `${url}/room.html?room=${roomId}`;
  navigator.clipboard.writeText(link).then(() => showToast('Link copiado!'));
});

// ======== Stats ========
let statsInterval;
function startStatsUpdate() {
  clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    if (peerConnections.size === 0) {
      streamStatsEl.textContent = localStream ? 'Transmitindo (aguardando viewers)' : '';
      return;
    }
    const [, pc] = [...peerConnections.entries()][0];
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      for (const report of stats.values()) {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          const fps = report.framesPerSecond || '-';
          const w = report.frameWidth || '-';
          const h = report.frameHeight || '-';
          const hw = report.powerEfficientEncoder ? 'GPU' : 'CPU';
          streamStatsEl.textContent = `${w}x${h} @ ${fps}fps | ${hw} | ${peerConnections.size} viewer(s)`;
          break;
        }
      }
    } catch {}
    if (++statsTicks % 30 === 0) reportQuality();
  }, 2000);
}

let statsTicks = 0;
async function reportQuality() {
  const viewers = [];
  for (const [viewerId, pc] of peerConnections) {
    try {
      const stats = await pc.getStats();
      for (const r of stats.values()) {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          viewers.push({
            viewer: viewerId.slice(0, 6),
            enc: r.encoderImplementation,
            fps: r.framesPerSecond,
            res: `${r.frameWidth}x${r.frameHeight}`,
            kbps: Math.round((r.targetBitrate || 0) / 1000),
            limit: r.qualityLimitationReason,
            encMs: r.framesEncoded ? +(1000 * r.totalEncodeTime / r.framesEncoded).toFixed(1) : null
          });
        }
      }
    } catch {}
  }
  if (viewers.length === 0) return;
  getSignalUrl().then(url => fetch(`${url}/api/errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'host-stats', level: 'info', message: 'quality', context: { viewers }, room_id: roomId, app_version: '1.1.4', user_agent: navigator.userAgent })
  })).catch(() => {});
}

// ======== Hot-swap window + audio switching ========
const btnSwitchSource = document.getElementById('btn-switch-source');
const switchModal = document.getElementById('switch-modal');
const switchSourceGrid = document.getElementById('switch-source-grid');
const switchAudioList = document.getElementById('switch-audio-list');
const btnCloseModal = document.getElementById('btn-close-modal');
let switchAudioPid = null;

btnSwitchSource.addEventListener('click', async () => {
  switchModal.style.display = '';
  switchAudioPid = null;

  switchSourceGrid.innerHTML = '<div class="loading">Carregando janelas...</div>';
  switchAudioList.innerHTML = '<div class="loading">Carregando audio...</div>';

  const [sources, audioResult] = await Promise.all([
    window.electronAPI.getSources(),
    window.electronAPI.listAudioSessions()
  ]);

  // Build source grid
  const screens = sources.filter(s => s.isScreen);
  const windows = sources.filter(s => !s.isScreen);
  switchSourceGrid.innerHTML = '';

  if (screens.length > 0) {
    const screenLabel = document.createElement('div');
    screenLabel.className = 'source-section-label';
    screenLabel.textContent = 'Telas (captura jogos em tela cheia)';
    switchSourceGrid.appendChild(screenLabel);
    screens.forEach(source => {
      const item = createSourceItem(source, () => switchToSource(source));
      switchSourceGrid.appendChild(item);
    });
    const windowLabel = document.createElement('div');
    windowLabel.className = 'source-section-label';
    windowLabel.textContent = 'Janelas';
    switchSourceGrid.appendChild(windowLabel);
  }

  windows.forEach(source => {
    const item = createSourceItem(source, () => switchToSource(source));
    switchSourceGrid.appendChild(item);
  });

  // Build audio list
  switchAudioList.innerHTML = '';
  const sessions = (audioResult && audioResult.sessions) || [];

  const keepItem = document.createElement('div');
  keepItem.className = 'session-item selected';
  keepItem.innerHTML = '<span class="session-name">Manter audio atual</span>';
  keepItem.addEventListener('click', () => {
    switchAudioList.querySelectorAll('.session-item.selected').forEach(el => el.classList.remove('selected'));
    keepItem.classList.add('selected');
    switchAudioPid = null;
  });
  switchAudioList.appendChild(keepItem);

  sessions.forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `
      <span class="session-name">${s.name}</span>
      <span class="session-pid">PID ${s.pid}</span>
      <span class="session-state ${s.state}">${s.state === 'active' ? 'Ativo' : 'Inativo'}</span>
    `;
    item.addEventListener('click', () => {
      switchAudioList.querySelectorAll('.session-item.selected').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      switchAudioPid = s.pid;
    });
    switchAudioList.appendChild(item);
  });

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nenhum processo com audio encontrado';
    switchAudioList.appendChild(empty);
  }
});

btnCloseModal.addEventListener('click', () => {
  switchModal.style.display = 'none';
});

switchModal.addEventListener('click', (e) => {
  if (e.target === switchModal) switchModal.style.display = 'none';
});

async function switchAudio(newPid) {
  // Stop old audio
  await window.electronAPI.stopAudioCapture();
  window.electronAPI.removeAudioListeners();
  if (audioWorkletNode) { audioWorkletNode.disconnect(); audioWorkletNode = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }

  // Remove old audio track from stream and PCs
  const oldAudioTrack = localStream.getAudioTracks()[0];
  if (oldAudioTrack) {
    oldAudioTrack.stop();
    localStream.removeTrack(oldAudioTrack);
  }

  // Start new audio capture
  const result = await window.electronAPI.startAudioCapture(newPid);
  if (result.error) {
    showToast('Erro ao trocar audio: ' + result.error);
    return;
  }

  const newAudioTrack = await createAudioTrackFromProcess(
    result.sampleRate || 48000,
    result.channels || 2
  );
  localStream.addTrack(newAudioTrack);

  // Replace audio track on all peer connections
  for (const [, pc] of peerConnections) {
    const audioSender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (audioSender) {
      await audioSender.replaceTrack(newAudioTrack);
    }
  }

  selectedPid = newPid;
  showToast(`Audio trocado: PID ${newPid}`);
}

async function switchToSource(source) {
  const newAudioPid = switchAudioPid;
  switchModal.style.display = 'none';

  const videoChanged = source.id !== selectedSourceId;
  const audioChanged = newAudioPid && newAudioPid !== selectedPid;

  if (!videoChanged && !audioChanged) return;

  try {
    // Switch video
    if (videoChanged) {
      const newVideoTrack = await captureVideo(source.id);

      for (const [, pc] of peerConnections) {
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(newVideoTrack);
        }
      }

      const oldVideoTrack = localStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        stopVideoTrack(oldVideoTrack);
        localStream.removeTrack(oldVideoTrack);
      }
      localStream.addTrack(newVideoTrack);

      syncPreview();
      selectedSourceId = source.id;
      (newVideoTrack.sourceTrack || newVideoTrack).addEventListener('ended', pauseStreaming);
    }

    // Switch audio
    if (audioChanged) {
      await switchAudio(newAudioPid);
    }

    showToast(`Trocado: ${source.name}`);
  } catch (err) {
    showToast('Erro ao trocar: ' + err.message);
    reportError('Switch source failed: ' + err.message, err.stack);
  }
}

// ======== Refresh buttons ========
btnRefreshSources.addEventListener('click', loadSources);
btnRefreshAudio.addEventListener('click', loadAudioSessions);

// ======== Init ========
loadSources();
loadAudioSessions();

// Wake the Render free-tier server early so "Iniciar" doesn't wait on a cold start
getSignalUrl().then(url => {
  fetch(`${url}/health`).catch(() => {});
  getIceConfig();
});
