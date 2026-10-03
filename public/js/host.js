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
        app_version: '1.4.0',
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
      return l + ';x-google-start-bitrate=4000;x-google-min-bitrate=1000;x-google-max-bitrate=20000';
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
  sourceGrid.innerHTML = '<div class="loading">Procurando janelas…</div>';
  const sources = await window.electronAPI.getSources();

  const screens = sources.filter(s => s.isScreen);
  const windows = sources.filter(s => !s.isScreen);

  sourceGrid.innerHTML = '';

  if (screens.length > 0) {
    const screenLabel = document.createElement('div');
    screenLabel.className = 'source-section-label';
    screenLabel.textContent = 'Telas inteiras (melhor para jogos em tela cheia)';
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
  sessionList.innerHTML = '<div class="loading">Procurando apps com som…</div>';
  const result = await window.electronAPI.listAudioSessions();

  if (result.error) {
    sessionList.innerHTML = `<div class="empty">Erro: ${result.error}</div>`;
    return;
  }

  const sessions = result.sessions || [];
  if (sessions.length === 0) {
    sessionList.innerHTML = '<div class="empty">Nenhum app tocando som agora. Abra o jogo ou a música e toque em Atualizar.</div>';
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
    socket.emit('join-room', { roomId, asHost: true, appVersion });
    // The server forgets the SFU session when the host socket drops
    if (sfu.active) socket.emit('sfu-start', { sessionId: sfu.sessionId, tracks: sfu.tracks });
  });

  socket.on('viewer-joined', async ({ viewerId }) => {
    // In SFU mode the server points the viewer at the published tracks instead
    if (isStreaming && localStream && !sfu.active) {
      await createOfferForViewer(viewerId);
    }
  });

  socket.on('viewer-needs-p2p', async ({ viewerId }) => {
    if (!isStreaming || !localStream) return;
    // Its direct connection from before the switch may still be live: keep it rather than renegotiate
    const existing = peerConnections.get(viewerId);
    if (existing && existing.connectionState === 'connected') {
      existing.keepDirect = true;
      return;
    }
    await createOfferForViewer(viewerId);
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
    roomViewerCount = count;
    viewerCountEl.textContent = `${count} assistindo`;
    viewerCountBar.textContent = `${count} assistindo`;
  });

  roomCodeBar.textContent = roomId;
  roomBar.style.display = '';
}

// ======== Quality presets ========
const QUALITY_KEY = 'ss-quality';
const quality = { res: '1080', fps: 60 };
try { Object.assign(quality, JSON.parse(localStorage.getItem(QUALITY_KEY)) || {}); } catch {}

function targetSize(w, h) {
  const maxH = quality.res === 'native' ? h : Math.min(h, parseInt(quality.res, 10));
  if (maxH >= h) return { w, h };
  return { w: Math.round((w * maxH / h) / 2) * 2, h: Math.round(maxH / 2) * 2 };
}

// Bits per pixel for fast-moving game content on H264; at 30fps each frame needs more bits
function presetBitrate() {
  const { w, h } = targetSize(
    pipe.srcW || Math.round(screen.width * devicePixelRatio),
    pipe.srcH || Math.round(screen.height * devicePixelRatio)
  );
  const bpp = quality.fps > 30 ? 0.075 : 0.1;
  return Math.round(Math.min(20e6, Math.max(2.5e6, w * h * quality.fps * bpp)));
}

const qualityHint = document.getElementById('quality-hint');
const qualitySection = document.getElementById('quality-section');
function renderQualityControls() {
  document.querySelectorAll('input[name="q-res"]').forEach(r => { r.checked = r.value === quality.res; });
  document.querySelectorAll('input[name="q-fps"]').forEach(r => { r.checked = Number(r.value) === quality.fps; });
  const mbps = (presetBitrate() / 1e6).toFixed(0);
  qualityHint.textContent = `até ~${mbps} Mbps de upload por pessoa`;
}

document.querySelectorAll('input[name="q-res"], input[name="q-fps"]').forEach(input => {
  input.addEventListener('change', async () => {
    if (input.name === 'q-res') quality.res = input.value;
    else quality.fps = Number(input.value);
    try { localStorage.setItem(QUALITY_KEY, JSON.stringify(quality)); } catch {}
    const videoTrack = localStream?.getVideoTracks()[0];
    videoTrack?.pipelineWorker?.postMessage({ quality: { ...quality } });
    const source = videoTrack?.sourceTrack;
    if (source) await source.applyConstraints({ frameRate: { ideal: quality.fps, max: quality.fps } }).catch(() => {});
    renderQualityControls();
    applySenderLimits();
  });
});

// ======== Capture video (cursor hidden) ========
async function captureVideo(sourceId) {
  await window.electronAPI.setCaptureSource(sourceId);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { cursor: 'never', frameRate: { ideal: quality.fps, max: quality.fps } },
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
// Downscaling and the fps cap happen here too, so the encoder never sees frames it would discard.
const pipe = {
  inFrames: 0, outFrames: 0, busyMs: 0, srcW: 0, srcH: 0, outW: 0, outH: 0,
  bursts: 0, pacerDropped: 0, maxGapMs: 0, longGaps: 0, maxQueue: 0
};

// With a game holding the GPU this pipeline stalls for tens of ms and then hands over the
// frames it buffered almost at once. The encoder is still busy with the first, so libwebrtc
// silently discards the rest: a live session captured 55fps but encoded ~30 with no limitation
// reported. Measured on synthetic bursts of 4 frames: 29.5fps unpaced, 54-60fps paced.
// Frames pass straight through when they arrive evenly; only bursts are spread out.
function createPacer(writer) {
  const queue = [];
  let pumping = false;
  let nextAt = 0;
  let lastWrite = 0;
  // Roughly one hardware encode; two frames closer than this and the second is discarded
  const MIN_SPACING_MS = 9;

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const slot = 1000 / quality.fps;
        // Drain faster when frames are piling up so the queue never becomes standing latency
        const gap = queue.length > 2 ? Math.min(slot * 0.9, Math.max(10, slot * 0.5)) : slot * 0.9;
        const now = performance.now();
        // Absolute schedule: one late timer must not push every later frame back
        if (nextAt < now - gap) nextAt = now;
        // ...but catching up after a late timer must not put two frames back to back either
        const wait = Math.max(nextAt, lastWrite + MIN_SPACING_MS) - now;
        if (wait > 1) await new Promise(r => setTimeout(r, wait));
        const frame = queue.shift();
        if (!frame) break;
        nextAt += gap;
        lastWrite = performance.now();
        const out = new VideoFrame(frame, { timestamp: Math.round(lastWrite * 1000) });
        frame.close();
        await writer.write(out);
        pipe.outFrames++;
      }
    } finally {
      pumping = false;
    }
  }

  return {
    push(frame) {
      queue.push(frame);
      pipe.maxQueue = Math.max(pipe.maxQueue, queue.length);
      while (queue.length > 4) {
        queue.shift().close();
        pipe.pacerDropped++;
      }
      pump().catch(() => {});
    },
    clear() {
      while (queue.length) queue.shift().close();
    }
  };
}

// The redraw runs in a worker so that a GPU stall blocks that thread, not this one: the pacer
// lives here and can keep releasing frames on time. (A pacer on the stalled thread gained nothing.)
const PIPELINE_WORKER = `
let quality = { res: '1080', fps: 60 };
function targetSize(w, h) {
  const maxH = quality.res === 'native' ? h : Math.min(h, parseInt(quality.res, 10));
  if (maxH >= h) return { w, h };
  return { w: Math.round((w * maxH / h) / 2) * 2, h: Math.round(maxH / 2) * 2 };
}
self.onmessage = async (e) => {
  if (e.data.quality) quality = e.data.quality;
  if (!e.data.readable) return;
  const reader = e.data.readable.getReader();
  const canvas = new OffscreenCanvas(e.data.width || 1920, e.data.height || 1080);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  let lastTs = -Infinity, lastArrival = 0;
  let read = 0, bursts = 0, longGaps = 0, maxGap = 0;
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      read++;
      const t0 = performance.now();
      if (lastArrival) {
        const gap = t0 - lastArrival;
        if (gap < 8) bursts++;
        if (gap > 100) longGaps++;
        if (gap > maxGap) maxGap = gap;
      }
      lastArrival = t0;
      // 15% slack so a 60fps source isn't halved by capture jitter
      if (frame.timestamp - lastTs < (1e6 / quality.fps) * 0.85) { frame.close(); continue; }
      lastTs = frame.timestamp;
      const { w, h } = targetSize(frame.displayWidth, frame.displayHeight);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.imageSmoothingQuality = 'high';
      }
      ctx.drawImage(frame, 0, 0, w, h);
      const srcW = frame.displayWidth, srcH = frame.displayHeight;
      const out = new VideoFrame(canvas, { timestamp: frame.timestamp });
      frame.close();
      self.postMessage({ frame: out, read, bursts, longGaps, maxGap, drawMs: performance.now() - t0, srcW, srcH, outW: w, outH: h }, [out]);
      read = 0; bursts = 0; longGaps = 0; maxGap = 0;
    }
    self.postMessage({ done: true });
  } catch (err) {
    self.postMessage({ done: true, error: err.message });
  }
};
`;

function gpuBackedTrack(source) {
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') {
    return source;
  }
  const processor = new MediaStreamTrackProcessor({ track: source, maxBufferSize: 2 });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  generator.contentHint = 'motion';
  generator.sourceTrack = source;

  const writer = generator.writable.getWriter();
  const pacer = createPacer(writer);
  const url = URL.createObjectURL(new Blob([PIPELINE_WORKER], { type: 'application/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  generator.pipelineWorker = worker;

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.frame) {
      pipe.inFrames += m.read;
      pipe.bursts += m.bursts;
      pipe.longGaps += m.longGaps;
      if (m.maxGap > pipe.maxGapMs) pipe.maxGapMs = m.maxGap;
      pipe.busyMs += m.drawMs;
      pipe.srcW = m.srcW; pipe.srcH = m.srcH;
      pipe.outW = m.outW; pipe.outH = m.outH;
      pacer.push(m.frame);
      return;
    }
    if (m.error && generator.readyState === 'live') reportError('GPU frame pipeline failed: ' + m.error);
    if (m.done) {
      pacer.clear();
      writer.close().catch(() => {});
      worker.terminate();
    }
  };
  worker.onerror = (e) => reportError('GPU frame pipeline worker error: ' + e.message);

  const settings = source.getSettings();
  worker.postMessage(
    { readable: processor.readable, quality: { ...quality }, width: settings.width, height: settings.height },
    [processor.readable]
  );
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
  btnStart.textContent = 'Iniciando…';

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
        showToast('Não deu para capturar o som: ' + result.error);
      } else {
        const audioTrack = await createAudioTrackFromProcess(
          result.sampleRate || 48000,
          result.channels || 2
        );
        tracks.push(audioTrack);
        showToast(`Som do app capturado (${result.sampleRate} Hz, ${result.channels} canais)`);
      }
    } else if (mode === 'system') {
      const result = await window.electronAPI.startAudioCapture('system');
      if (result.error) {
        showToast('Não deu para capturar o som do PC: ' + result.error);
      } else {
        const audioTrack = await createAudioTrackFromProcess(
          result.sampleRate || 48000,
          result.channels || 2
        );
        tracks.push(audioTrack);
        showToast(`Som do PC capturado (${result.sampleRate} Hz)`);
      }
    }

    localStream = new MediaStream(tracks);
    syncPreview();

    // 3. Create or reuse room
    await ensureRoom();
    isStreaming = true;
    window.electronAPI.setStreamingPriority(true);

    // 4. If resuming, notify server — it re-sends viewer-joined for each viewer
    if (isResume) {
      socket.emit('host-resume');
    }

    (videoTrack.sourceTrack || videoTrack).addEventListener('ended', pauseStreaming);

    // 5. Switch to streaming panel
    roomCodeEl.textContent = roomId;
    panelSetup.style.display = 'none';
    panelStreaming.style.display = '';
    panelStreaming.appendChild(qualitySection);

    startStatsUpdate();

  } catch (err) {
    showToast('Erro: ' + err.message);
    reportError('Start streaming failed: ' + err.message, err.stack);
    btnStart.disabled = false;
    btnStart.textContent = roomId ? 'Voltar a transmitir' : 'Começar a transmitir';
  }
});

// ======== WebRTC ========
async function configureVideoSender(pc, maxBitrate, label) {
  const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
  if (!videoSender) return;
  try {
    const params = videoSender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = quality.fps;
    params.encodings[0].networkPriority = 'high';
    params.encodings[0].priority = 'high';
    // maintain-framerate collapses resolution under bandwidth pressure, which is what makes it look blocky
    params.degradationPreference = 'balanced';
    await videoSender.setParameters(params);
  } catch (err) {
    console.warn('setParameters failed, using defaults', err);
    reportError('setParameters failed: ' + err.message, err.stack, { viewerId: label });
  }
}

async function createOfferForViewer(viewerId) {
  const existing = peerConnections.get(viewerId);
  if (existing) existing.close();
  peerConnections.delete(viewerId);

  const iceConfig = await getIceConfig();
  if (peerConnections.has(viewerId) || !localStream) return;
  const pc = new RTCPeerConnection(iceConfig);
  pc.pendingIce = [];
  pc.sid = ++offerSeq;
  pc.createdAt = performance.now();
  peerConnections.set(viewerId, pc);

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  await configureVideoSender(pc, viewerBitrateCap(viewerId), viewerId);

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
  window.electronAPI.setStreamingPriority(false);
  flushRelayUsage();
  panelSetup.insertBefore(qualitySection, btnStart);

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
  // 'host-pause' below already tells the server and viewers the stream is gone
  stopSfu(false);

  if (socket) {
    socket.emit('host-pause');
  }

  syncPreview();

  panelStreaming.style.display = 'none';
  panelSetup.style.display = '';
  btnStart.textContent = 'Voltar a transmitir';
  updateStartButton();
}

// ======== Copy buttons ========
btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => showToast('Código copiado'));
});

btnCopyCodeBar.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => showToast('Código copiado'));
});

btnCopyLink.addEventListener('click', async () => {
  const url = signalServer || await window.electronAPI.getSignalServer();
  const link = `${url}/room.html?room=${roomId}`;
  navigator.clipboard.writeText(link).then(() => showToast('Link copiado'));
});

// ======== SFU mode ========
// P2P costs one encode and one upload per viewer. From 3 viewers on, publish once to the SFU
// and let it fan out; with 1-2 viewers stay direct, which is free and has the lowest latency.
const SFU_MIN_VIEWERS = 3;
const sfu = {
  active: false, starting: false, pc: null, sessionId: null, tracks: [],
  cooldownUntil: 0, lowSince: 0, enabled: false, checkedAt: 0
};
let roomViewerCount = 0;

function sendingPcs() {
  return sfu.pc ? [...peerConnections.values(), sfu.pc] : [...peerConnections.values()];
}

async function sfuFetch(method, path, body) {
  const url = await getSignalUrl();
  const res = await fetch(`${url}/api/sfu${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, ...body })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errorCode) throw new Error(data.errorDescription || data.errorCode || `SFU HTTP ${res.status}`);
  return data;
}

async function refreshSfuEnabled() {
  if (Date.now() - sfu.checkedAt < 60000) return sfu.enabled;
  sfu.checkedAt = Date.now();
  try {
    const url = await getSignalUrl();
    sfu.enabled = (await (await fetch(`${url}/api/sfu/status`)).json()).enabled === true;
  } catch {
    sfu.enabled = false;
  }
  return sfu.enabled;
}

function waitConnected(pc, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SFU connection timeout')), timeoutMs);
    const check = () => {
      if (pc.connectionState === 'connected') { clearTimeout(timer); resolve(); }
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        clearTimeout(timer);
        reject(new Error('SFU connection ' + pc.connectionState));
      }
    };
    pc.addEventListener('connectionstatechange', check);
    check();
  });
}

// Cloudflare's SFU only negotiates H264 constrained baseline (42e01f), which Chromium encodes on
// the CPU. It forwards RTP untouched and decoders take the profile from the stream itself, so
// telling our own encoder "Main" keeps it on the GPU. Measured through the SFU at 1080p:
// 4.6ms/frame as Main vs 11.4ms as baseline, decoding cleanly on the far side.
async function hardwareProfileSdp(sdp) {
  if (/profile-level-id=4d/i.test(sdp)) return sdp;
  const hardware = async (profile) => (await navigator.mediaCapabilities.encodingInfo({
    type: 'webrtc',
    video: {
      contentType: `video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`,
      width: 1920, height: 1080, bitrate: 8e6, framerate: 60
    }
  })).powerEfficient;
  try {
    // Only worth it where Main is hardware and baseline is not
    if (await hardware('42e01f') || !(await hardware('4d001f'))) return sdp;
  } catch {
    return sdp;
  }
  return sdp.replace(/profile-level-id=42e01f/gi, 'profile-level-id=4d001f');
}

async function startSfu() {
  if (sfu.active || sfu.starting || !localStream) return;
  sfu.starting = true;
  let pc;
  try {
    const { sessionId } = await sfuFetch('POST', '/sessions');
    const iceConfig = await getIceConfig();
    pc = new RTCPeerConnection({ ...iceConfig, bundlePolicy: 'max-bundle' });
    const published = localStream.getTracks().map(track => ({
      transceiver: pc.addTransceiver(track, { direction: 'sendonly' }),
      trackName: track.kind
    }));
    await configureVideoSender(pc, presetBitrate(), 'sfu');

    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: preferH264(offer.sdp) });
    const data = await sfuFetch('POST', `/sessions/${sessionId}/tracks`, {
      sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
      tracks: published.map(p => ({ location: 'local', mid: p.transceiver.mid, trackName: p.trackName }))
    });
    const failed = (data.tracks || []).find(t => t.errorCode);
    if (failed) throw new Error(failed.errorDescription || failed.errorCode);
    const answerSdp = await hardwareProfileSdp(data.sessionDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: tuneAnswerSdp(preferH264(answerSdp)) });
    await waitConnected(pc, 10000);
    if (!isStreaming || !localStream) throw new Error('stream stopped during SFU start');

    sfu.pc = pc;
    sfu.sessionId = sessionId;
    sfu.tracks = published.map(p => p.trackName);
    sfu.active = true;
    sfu.lowSince = 0;
    pc.addEventListener('connectionstatechange', () => {
      if (sfu.pc === pc && pc.connectionState === 'failed') {
        reportError('SFU connection failed', null, { sessionId });
        sfu.cooldownUntil = Date.now() + 300000;
        stopSfu();
      }
    });
    socket.emit('sfu-start', { sessionId, tracks: sfu.tracks });

    // Viewers swap over on their own; drop the direct connections they no longer use.
    // A viewer that fell back to P2P gets a fresh entry, which the identity check spares.
    const previous = [...peerConnections];
    setTimeout(() => {
      for (const [id, old] of previous) {
        if (sfu.active && !old.keepDirect && peerConnections.get(id) === old) {
          old.close();
          peerConnections.delete(id);
        }
      }
    }, 6000);
  } catch (err) {
    if (pc) pc.close();
    sfu.cooldownUntil = Date.now() + 300000;
    reportError('SFU start failed: ' + err.message, err.stack, { viewers: roomViewerCount });
  } finally {
    sfu.starting = false;
  }
}

// Viewers answer 'sfu-stop' by re-joining, which brings back one P2P offer each
function stopSfu(notify = true) {
  const pc = sfu.pc;
  if (!pc && !sfu.active) return;
  sfu.active = false;
  sfu.pc = null;
  sfu.sessionId = null;
  sfu.tracks = [];
  sfu.lowSince = 0;
  if (notify && socket) socket.emit('sfu-stop');
  if (pc) pc.close();
}

async function updateSfuMode() {
  if (!isStreaming || !localStream) return;
  if (sfu.active) {
    if (!(await refreshSfuEnabled())) { stopSfu(); return; }
    if (roomViewerCount < SFU_MIN_VIEWERS) {
      // Wait out someone refreshing the page before paying for another switch
      if (!sfu.lowSince) sfu.lowSince = Date.now();
      else if (Date.now() - sfu.lowSince > 30000) stopSfu();
    } else {
      sfu.lowSince = 0;
    }
  } else if (!sfu.starting && roomViewerCount >= SFU_MIN_VIEWERS && Date.now() > sfu.cooldownUntil) {
    if (await refreshSfuEnabled()) startSfu();
  }
}

// ======== Upload sharing ========
// Every viewer gets its own encode and its own copy of the upload. Measured: with two viewers
// one held 11 Mbps while the other sat at 960x540/4 Mbps, summing to a steady ~16 Mbps.
// A throttled viewer is either behind the host's saturated uplink (fixable by sharing evenly)
// or behind its own slow downlink (sharing would only hurt the others). A 10s trial of an even
// split tells them apart: if the throttled viewer climbs, keep sharing; if not, exclude it.
const share = { mode: 'off', budget: Infinity, trialStart: 0, trialIds: [], excluded: new Map() };

function isExcluded(viewerId) {
  const until = share.excluded.get(viewerId);
  if (until && until > Date.now()) return true;
  share.excluded.delete(viewerId);
  return false;
}

function viewerBitrateCap(viewerId) {
  const preset = presetBitrate();
  if (share.mode === 'off' || (viewerId && isExcluded(viewerId))) return preset;
  const sharing = [...peerConnections.keys()].filter(id => !isExcluded(id)).length || 1;
  return Math.round(Math.min(preset, share.budget / sharing));
}

function applySenderLimits() {
  const entries = [...peerConnections];
  if (sfu.pc) entries.push([null, sfu.pc]);
  for (const [viewerId, pc] of entries) {
    // The SFU link carries the one copy everybody watches, so it always gets the full preset
    const cap = pc === sfu.pc ? presetBitrate() : viewerBitrateCap(viewerId);
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    if (params.encodings[0].maxBitrate === cap && params.encodings[0].maxFramerate === quality.fps) continue;
    params.encodings[0].maxBitrate = cap;
    params.encodings[0].maxFramerate = quality.fps;
    sender.setParameters(params).catch(() => {});
  }
}

function resetShare() {
  share.mode = 'off';
  share.budget = Infinity;
  share.trialIds = [];
}

function updateUploadBudget(samples) {
  const eligible = samples.filter(s => !isExcluded(s.id));
  // A fresh connection is still ramping up bandwidth estimation, which looks like throttling
  if (eligible.length < 2 || samples.some(s => s.ageMs < 10000)) {
    if (eligible.length < 2) resetShare();
    applySenderLimits();
    return;
  }
  const limited = eligible.filter(s => s.targetBitrate < viewerBitrateCap(s.id) * 0.85);
  const total = eligible.reduce((sum, s) => sum + s.targetBitrate, 0);

  if (share.mode === 'off') {
    if (limited.length > 0 && limited.length < eligible.length) {
      share.mode = 'trial';
      share.budget = total;
      share.trialStart = Date.now();
      share.trialIds = limited.map(s => s.id);
    }
  } else if (share.mode === 'trial') {
    if (Date.now() - share.trialStart >= 10000) {
      const stillLow = eligible.filter(s => share.trialIds.includes(s.id) && s.targetBitrate < viewerBitrateCap(s.id) * 0.85);
      if (stillLow.length === 0) {
        share.mode = 'on';
      } else {
        for (const s of stillLow) share.excluded.set(s.id, Date.now() + 300000);
        resetShare();
      }
    }
  } else if (limited.length > 0) {
    // Someone is below its share again: the uplink is full at the current total
    share.budget = total;
  } else {
    // Probe back up slowly so a temporary dip doesn't cap the stream forever
    share.budget *= 1.05;
    if (share.budget > presetBitrate() * eligible.length * 1.2) resetShare();
  }
  applySenderLimits();
}

// ======== Stats ========
let statsInterval;
let statsTicks = 0;
let lastPipe = { ...pipe, at: performance.now() };

async function collectSenderStats() {
  const samples = [];
  const entries = [...peerConnections];
  if (sfu.active && sfu.pc) entries.push(['sfu', sfu.pc]);
  for (const [viewerId, pc] of entries) {
    const isSfu = pc === sfu.pc;
    try {
      const stats = await pc.getStats();
      for (const r of stats.values()) {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          const pair = [...stats.values()].find(p => p.type === 'candidate-pair' && p.nominated);
          // Each relayed hop (ours and/or the viewer's allocation) is traffic Cloudflare meters
          const relayHops = pair
            ? [pair.localCandidateId, pair.remoteCandidateId].filter(id => stats.get(id)?.candidateType === 'relay').length
            : 0;
          // The SFU bills what it sends out: one copy of our upload per viewer it serves
          const billedCopies = relayHops + (isSfu ? Math.max(0, roomViewerCount - peerConnections.size) : 0);
          if (pair) {
            const sent = pair.bytesSent || 0;
            if (billedCopies > 0) relayBytesPending += Math.max(0, sent - (pc.lastPairBytes || 0)) * billedCopies;
            pc.lastPairBytes = sent;
          }
          samples.push({
            id: viewerId,
            sfu: isSfu,
            viewer: viewerId.slice(0, 6),
            ageMs: Math.round(performance.now() - (pc.createdAt || 0)),
            enc: r.encoderImplementation,
            gpu: !!r.powerEfficientEncoder,
            fps: r.framesPerSecond || 0,
            res: `${r.frameWidth || 0}x${r.frameHeight || 0}`,
            targetBitrate: r.targetBitrate || 0,
            limit: r.qualityLimitationReason,
            encMs: r.framesEncoded ? +(1000 * r.totalEncodeTime / r.framesEncoded).toFixed(1) : null,
            rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
            relay: pair ? relayHops > 0 : null
          });
        }
      }
    } catch {}
  }
  return samples;
}

function pipelineRates() {
  const now = performance.now();
  const secs = (now - lastPipe.at) / 1000 || 1;
  const outDelta = pipe.outFrames - lastPipe.outFrames;
  const rates = {
    srcFps: +((pipe.inFrames - lastPipe.inFrames) / secs).toFixed(1),
    outFps: +(outDelta / secs).toFixed(1),
    drawMs: outDelta ? +((pipe.busyMs - lastPipe.busyMs) / outDelta).toFixed(2) : null,
    src: `${pipe.srcW}x${pipe.srcH}`,
    out: `${pipe.outW}x${pipe.outH}`,
    // Frames that arrived under 8ms after the previous one, and arrival gaps over 100ms
    bursts: pipe.bursts - lastPipe.bursts,
    longGaps: pipe.longGaps - lastPipe.longGaps,
    maxGapMs: Math.round(pipe.maxGapMs),
    pacerDropped: pipe.pacerDropped - lastPipe.pacerDropped,
    maxQueue: pipe.maxQueue
  };
  pipe.maxGapMs = 0;
  pipe.maxQueue = 0;
  lastPipe = { ...pipe, at: now };
  return rates;
}

function startStatsUpdate() {
  clearInterval(statsInterval);
  lastPipe = { ...pipe, at: performance.now() };
  statsInterval = setInterval(async () => {
    statsTicks++;
    const samples = await collectSenderStats();
    if (samples.length === 0) {
      streamStatsEl.textContent = localStream ? 'Transmitindo (aguardando viewers)' : '';
    } else {
      const s = samples.find(x => x.sfu) || samples[0];
      const kbps = samples.map(x => (x.targetBitrate / 1e6).toFixed(1)).join('/');
      const mode = sfu.active ? 'servidor (SFU)' : 'direto';
      streamStatsEl.textContent =
        `${s.res} @ ${s.fps}fps | ${s.gpu ? 'GPU' : 'CPU'} | ${kbps} Mbps | ${mode} | ${roomViewerCount} viewer(s)`;
    }
    updateUploadBudget(samples.filter(x => !x.sfu));
    updateSfuMode();
    if (statsTicks % 30 === 0) {
      const pipeline = pipelineRates();
      if (samples.length) reportQuality(samples, pipeline);
      flushRelayUsage();
    }
  }, 2000);
}

// Feeds the server's monthly TURN cap so relayed traffic can't run past the free tier
let relayBytesPending = 0;
function flushRelayUsage() {
  if (relayBytesPending <= 0) return;
  const bytes = Math.round(relayBytesPending);
  relayBytesPending = 0;
  getSignalUrl().then(url => fetch(`${url}/api/relay-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bytes })
  })).catch(() => { relayBytesPending += bytes; });
}

function reportQuality(samples, pipeline) {
  const viewers = samples.map(({ id, targetBitrate, ageMs, ...rest }) => ({
    ...rest,
    kbps: Math.round(targetBitrate / 1000),
    capKbps: Math.round((rest.sfu ? presetBitrate() : viewerBitrateCap(id)) / 1000),
    excluded: isExcluded(id)
  }));
  const context = {
    viewers,
    pipeline,
    mode: sfu.active ? 'sfu' : 'p2p',
    roomViewers: roomViewerCount,
    preset: `${quality.res}p${quality.fps}`,
    share: share.mode,
    budgetKbps: share.budget === Infinity ? null : Math.round(share.budget / 1000)
  };
  getSignalUrl().then(url => fetch(`${url}/api/errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'host-stats', level: 'info', message: 'quality', context, room_id: roomId, app_version: '1.4.0', user_agent: navigator.userAgent })
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

  switchSourceGrid.innerHTML = '<div class="loading">Procurando janelas…</div>';
  switchAudioList.innerHTML = '<div class="loading">Procurando apps com som…</div>';

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
    screenLabel.textContent = 'Telas inteiras (melhor para jogos em tela cheia)';
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
  keepItem.innerHTML = '<span class="session-name">Manter o som atual</span>';
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
    empty.textContent = 'Nenhum app tocando som agora';
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
    showToast('Não deu para trocar o som: ' + result.error);
    return;
  }

  const newAudioTrack = await createAudioTrackFromProcess(
    result.sampleRate || 48000,
    result.channels || 2
  );
  localStream.addTrack(newAudioTrack);

  // Replace audio track on all peer connections
  for (const pc of sendingPcs()) {
    const audioSender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (audioSender) {
      await audioSender.replaceTrack(newAudioTrack);
    }
  }

  selectedPid = newPid;
  showToast(`Som trocado (PID ${newPid})`);
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

      for (const pc of sendingPcs()) {
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

    showToast(`Agora mostrando: ${source.name}`);
  } catch (err) {
    showToast('Não deu para trocar: ' + err.message);
    reportError('Switch source failed: ' + err.message, err.stack);
  }
}

// ======== Refresh buttons ========
btnRefreshSources.addEventListener('click', loadSources);
btnRefreshAudio.addEventListener('click', loadAudioSessions);

// ======== Update check ========
// Old builds stutter badly (CPU encoding per viewer) and nothing ever told the host to update
let appVersion = null;

function versionOlder(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  try {
    appVersion = await window.electronAPI.getAppVersion();
    const url = await getSignalUrl();
    const latest = await (await fetch(`${url}/api/app-version`)).json();
    if (!latest.version || !versionOlder(appVersion, latest.version)) return;
    document.getElementById('update-text').textContent =
      `Versão ${latest.version} disponível (você está na ${appVersion}).`;
    document.getElementById('btn-update').onclick = () => window.electronAPI.openDownload(latest.url);
    document.getElementById('update-banner').style.display = '';
  } catch {}
}

// ======== Init ========
loadSources();
loadAudioSessions();
renderQualityControls();
checkForUpdate();

// Wake the Render free-tier server early so "Iniciar" doesn't wait on a cold start
getSignalUrl().then(url => {
  fetch(`${url}/health`).catch(() => {});
  getIceConfig();
});
