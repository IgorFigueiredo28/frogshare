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
        app_version: '1.6.2',
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
// Proves to the server that this app created the room, so nobody else can take it over as host
let hostKey = null;
let signalServer = '';
let isStreaming = false;

// Group streaming: the room owner can let up to 3 friends stream in the same room, and viewers pick
// whose screen to watch. A friend's app joins as a guest, opened by the site's "Compartilhar minha
// tela aqui" (frogshare://share?room=...).
const group = { enabled: false, guestRoom: null, slot: 0, ownerName: '', hosts: [] };
// Viewers watching someone else in a group room don't need our video meanwhile: viewerId -> false
const viewerWatch = new Map();
const NICK_KEY = 'fs-nickname';
function nickname() {
  try { return (localStorage.getItem(NICK_KEY) || '').trim().slice(0, 24); } catch { return ''; }
}

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
const sourceSignature = (sources) => sources.map(s => s.id).sort().join('|');

async function loadSources({ silent = false } = {}) {
  if (!silent) sourceGrid.innerHTML = '<div class="loading">Procurando janelas…</div>';
  const scroll = sourceGrid.scrollTop;
  const sources = await window.electronAPI.getSources();
  refreshPermissions();
  liveLists.sourceSig = sourceSignature(sources);
  sources.forEach(s => knownSources.set(s.id, s));
  // The window that was picked may have closed (the game was quit)
  if (selectedSourceId && !sources.some(s => s.id === selectedSourceId)) {
    selectedSourceId = null;
    updateStartButton();
  }

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
  sourceGrid.scrollTop = scroll;
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
      followWindowAudio(source);
    });
  }
  return item;
}

// ======== Audio Sessions ========
function sessionRow(session) {
  const span = (className, text) => Object.assign(document.createElement('span'), { className, textContent: text });
  const active = session.state === 'active';
  return [
    span('session-name', String(session.name)),
    span('session-pid', 'PID ' + session.pid),
    span('session-state ' + (active ? 'active' : 'inactive'), active ? 'Ativo' : 'Inativo')
  ];
}

const audioSignature = (sessions) => (sessions || []).map(s => `${s.pid}:${s.name}:${s.state}`).join('|');

// ======== Sound that follows the window ========
// Picking a game's window also picks the game's sound, unless a sound was already chosen by hand.
// Matched by the same process, then one of its child processes (games and browsers often play
// audio from a helper), then the same program name. If the game isn't making sound yet, the pick
// happens as soon as its session shows up.
const audioFollow = { owner: null, sourceId: null, autoPicked: false };

function matchOwnerSession(owner, sessions) {
  const name = (owner.name || '').toLowerCase();
  return sessions.find(s => s.pid === owner.pid)
    || sessions.find(s => owner.descendants?.includes(s.pid))
    || (name && sessions.find(s => String(s.name).toLowerCase() === name))
    || null;
}

function applyAudioFollow(sessions, { announce = true } = {}) {
  const { owner } = audioFollow;
  if (!owner || audioFollow.sourceId !== selectedSourceId || getAudioMode() !== 'process') return false;
  if (selectedPid && !audioFollow.autoPicked) return false;
  const session = matchOwnerSession(owner, sessions || []);
  if (!session || session.pid === selectedPid) return false;
  selectedPid = session.pid;
  audioFollow.autoPicked = true;
  updateStartButton();
  if (announce) showToast(`Som de "${session.name}" escolhido junto com a janela.`);
  return true;
}

async function followWindowAudio(source) {
  audioFollow.owner = null;
  audioFollow.sourceId = source.id;
  if (source.isScreen) return;
  const owner = await window.electronAPI.getWindowOwner(source.id);
  // Another window may have been picked while this was being looked up
  if (!owner || audioFollow.sourceId !== source.id) return;
  audioFollow.owner = owner;
  if (applyAudioFollow(audioFollow.lastSessions)) loadAudioSessions({ silent: true, result: { sessions: audioFollow.lastSessions } });
}

async function loadAudioSessions({ silent = false, result = null } = {}) {
  if (!silent) sessionList.innerHTML = '<div class="loading">Procurando apps com som…</div>';
  result = result || await window.electronAPI.listAudioSessions();
  liveLists.audioSig = audioSignature(result.sessions);
  audioFollow.lastSessions = result.sessions || [];
  // The picked window's program may have only just started playing sound
  applyAudioFollow(audioFollow.lastSessions);
  // The app that was picked may have closed
  if (selectedPid && !(result.sessions || []).some(s => s.pid === selectedPid)) {
    selectedPid = null;
    updateStartButton();
  }

  if (result.error) {
    sessionList.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Erro: ' + result.error }));
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
    item.append(...sessionRow(session));
    item.addEventListener('click', () => {
      document.querySelectorAll('.session-item.selected').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedPid = session.pid;
      audioFollow.autoPicked = false;
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

// What still has to be picked before a stream can start, or null when it's ready
function missingForStart() {
  if (!selectedSourceId) {
    return { section: sourceGrid.closest('.step'), message: 'Escolha a tela ou a janela que você quer mostrar.' };
  }
  if (getAudioMode() === 'process' && !selectedPid) {
    return { section: sessionList.closest('.step'), message: 'Escolha o app do som que vai junto, ou marque "Todo o PC" ou "Sem som".' };
  }
  return null;
}

// The button stays clickable while something is missing (it only looks inactive), so a click can
// say what's missing instead of doing nothing
function updateStartButton() {
  btnStart.setAttribute('aria-disabled', String(!!missingForStart()));
}

function flagMissing({ section, message }) {
  showToast(message);
  section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  section.classList.remove('needs-attention');
  void section.offsetWidth; // restart the nudge if it's clicked again
  section.classList.add('needs-attention');
  // The nudge is brief; the highlight lingers long enough to find the spot
  clearTimeout(section.attentionTimer);
  section.attentionTimer = setTimeout(() => section.classList.remove('needs-attention'), 2500);
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
  if (group.guestRoom) {
    roomId = group.guestRoom;
    hostKey = null;
  } else {
    const res = await fetch(`${signalServer}/api/room/create`);
    const data = await res.json();
    roomId = data.roomId;
    hostKey = data.hostKey || null;
  }

  socket = io(signalServer);
  socket.on('connect', () => {
    if (group.guestRoom) {
      socket.emit('join-room', { roomId, asHost: true, coHost: true, appVersion, name: nickname() });
    } else {
      socket.emit('join-room', { roomId, asHost: true, appVersion, hostKey, name: nickname() });
      // A restarted server forgets the room; bring the group back with it
      if (group.enabled) socket.emit('group-mode', { enabled: true });
    }
    // The server forgets the SFU session when the host socket drops
    if (sfu.active) socket.emit('sfu-start', { sessionId: sfu.sessionId, tracks: sfu.tracks });
  });

  socket.on('host-rejected', ({ reason, group: isGroup }) => {
    showToast(reason || 'O servidor não aceitou esta sala.');
    if (isGroup && group.guestRoom) {
      if (isStreaming) pauseStreaming();
      else exitGuestMode();
      return;
    }
    reportError('Host join rejected', null, { roomId });
  });

  socket.on('cohost-accepted', ({ slot, ownerName }) => {
    group.slot = slot;
    group.ownerName = ownerName || '';
    renderGroupUi();
  });

  // The owner removed us, closed the group or the room closed
  socket.on('group-ended', ({ reason } = {}) => {
    if (!group.guestRoom) return;
    showToast(reason || 'A transmissão em grupo terminou.');
    if (isStreaming) pauseStreaming();
    else exitGuestMode();
  });

  socket.on('viewer-watch', ({ viewerId, video }) => {
    if (video) viewerWatch.delete(viewerId);
    else viewerWatch.set(viewerId, false);
    applyWatch(viewerId);
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
    viewerWatch.delete(viewerId);
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

  socket.on('room-update', ({ viewerCount: count, group: groupOn, hosts }) => {
    roomViewerCount = count;
    group.hosts = Array.isArray(hosts) ? hosts : [];
    if (!group.guestRoom) group.enabled = !!groupOn;
    renderGroupUi();
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
    // Keeps the mouse out of the stream, so a fullscreen game shows only its own crosshair. Electron 33
    // ignored this and drew the cursor; 44 honours it for both window and screen capture (measured).
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
  if (track.stopCard) track.stopCard();
  track.stop();
  if (track.sourceTrack) track.sourceTrack.stop();
}

// ======== Start Streaming ========
btnStart.addEventListener('click', async () => {
  const missing = missingForStart();
  if (missing) {
    flagMissing(missing);
    return;
  }
  btnStart.disabled = true;
  btnStart.textContent = 'Iniciando…';

  try {
    const mode = getAudioMode();
    if (group.guestRoom && roomId && roomId !== group.guestRoom) leaveRoomConnection();
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

    // Every stream carries an audio channel, silent when there's no sound, so a sound can be switched
    // in later on the same connections (adding a track live would mean renegotiating every viewer)
    const hasSound = tracks.some(t => t.kind === 'audio');
    if (!hasSound) tracks.push(silentAudioTrack());
    localStream = new MediaStream(tracks);
    // What viewers hear right now: an app's pid, 'system', or 'none' for the silent channel
    liveAudio = hasSound ? (mode === 'system' ? 'system' : selectedPid) : 'none';
    rememberSource(sourceById(selectedSourceId));
    syncPreview();

    // 3. Create or reuse room
    await ensureRoom();
    isStreaming = true;
    window.electronAPI.setStreamingPriority(true);

    // 4. If resuming, notify server — it re-sends viewer-joined for each viewer
    if (isResume) {
      socket.emit('host-resume');
    }

    (videoTrack.sourceTrack || videoTrack).addEventListener('ended', (e) => onCaptureEnded(e.target));

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
    btnStart.textContent = startLabel();
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
    params.encodings[0].active = viewerWatch.get(label) !== false;
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

// In a group room a viewer watches one streamer at a time; the others keep only the sound flowing to it
function applyWatch(viewerId) {
  const pc = peerConnections.get(viewerId);
  const sender = pc?.getSenders().find(s => s.track?.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) return;
  const active = viewerWatch.get(viewerId) !== false;
  if (params.encodings[0].active === active) return;
  params.encodings[0].active = active;
  sender.setParameters(params).catch(() => {});
}

// ======== Pause Streaming (room stays alive) ========
btnStop.addEventListener('click', pauseStreaming);

async function pauseStreaming() {
  isStreaming = false;
  stopStandby();
  window.electronAPI.setStreamingPriority(false);
  flushRelayUsage();
  panelSetup.insertBefore(qualitySection, btnStart);

  if (localStream) {
    localStream.getTracks().forEach(t => t.kind === 'video' ? stopVideoTrack(t) : t.stop());
    localStream = null;
  }
  releaseSilentAudio();

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
    socket.emit(group.guestRoom ? 'leave-group' : 'host-pause');
  }

  syncPreview();

  panelStreaming.style.display = 'none';
  panelSetup.style.display = '';
  btnStart.disabled = false;
  if (group.guestRoom) exitGuestMode();
  btnStart.textContent = startLabel();
  updateStartButton();
}

function startLabel() {
  if (group.guestRoom) return 'Entrar na transmissão em grupo';
  return roomId ? 'Voltar a transmitir' : 'Começar a transmitir';
}

// ======== Group streaming ========
const groupInvite = document.getElementById('group-invite');
const groupInviteText = document.getElementById('group-invite-text');
const groupToggle = document.getElementById('group-toggle');
const groupToggleSetup = document.getElementById('group-toggle-setup');
const groupJoin = document.getElementById('group-join');
const groupJoinCode = document.getElementById('group-join-code');
const groupToggleRow = document.getElementById('group-toggle-row');
const groupDetails = document.getElementById('group-details');
const groupList = document.getElementById('group-list');
const groupHint = document.getElementById('group-hint');
const chipGroup = document.getElementById('chip-group');
const chipGroupFrog = document.getElementById('chip-group-frog');
const chipGroupText = document.getElementById('chip-group-text');
const roomBarLabel = document.getElementById('room-bar-label');
const nickInputs = [document.getElementById('nickname'), document.getElementById('guest-nickname')];

// Whoever calls themselves "bigfrog" gets the chubby frog
const frogIcon = (name) => /^big\s*frog$/i.test(String(name || '').trim()) ? '/brand/frog-head-big.svg' : '/brand/frog-head.svg';

function renderGroupUi() {
  const guest = !!group.guestRoom;
  document.body.classList.toggle('group-guest', guest);
  groupInvite.hidden = !guest;
  if (guest) {
    groupInviteText.textContent = group.ownerName
      ? `Você está entrando na sala de ${group.ownerName} (${group.guestRoom}). Escolha a tela e o som e clique em "Entrar na transmissão em grupo".`
      : `Sala ${group.guestRoom}. Escolha a tela e o som e clique em "Entrar na transmissão em grupo". Sua tela aparece para quem está na sala, junto com a do dono.`;
  }
  groupToggleRow.hidden = guest;
  btnStop.lastChild.textContent = guest ? 'Sair do grupo' : 'Parar';
  groupToggle.checked = group.enabled;
  groupToggleSetup.checked = group.enabled;
  const inGroup = guest || group.enabled;
  groupDetails.hidden = !inGroup;
  roomBarLabel.textContent = guest ? 'Em grupo' : 'Sala ativa';

  const me = socket?.id;
  const others = group.hosts.length - 1;
  chipGroup.hidden = !(guest || (group.enabled && others > 0));
  chipGroupFrog.className = `group-frog slot-${guest ? group.slot : 0}`;
  chipGroupFrog.src = frogIcon(nickname());
  chipGroupText.textContent = guest ? `Em grupo${group.ownerName ? ' com ' + group.ownerName : ''}` : `Em grupo · ${group.hosts.length} transmitindo`;

  const items = group.hosts.slice().sort((a, b) => a.slot - b.slot).map(h => {
    const li = document.createElement('li');
    li.className = `slot-${h.slot}`;
    const frog = Object.assign(document.createElement('img'), { className: 'group-frog' + (frogIcon(h.name).includes('big') ? ' is-big' : ''), src: frogIcon(h.name), alt: '' });
    const name = Object.assign(document.createElement('span'), { className: 'group-name', textContent: h.name });
    const tags = [h.id === me ? 'você' : '', h.owner ? 'dono' : '', h.paused ? 'pausado' : ''].filter(Boolean).join(' · ');
    if (tags) name.append(' ', Object.assign(document.createElement('span'), { className: 'group-tag', textContent: `(${tags})` }));
    li.append(frog, name);
    if (!guest && !h.owner) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'btn btn-ghost btn-icon';
      kick.title = `Tirar ${h.name} da transmissão`;
      kick.setAttribute('aria-label', kick.title);
      kick.innerHTML = '<svg class="ico" aria-hidden="true"><use href="/brand/icons.svg#i-x"/></svg>';
      kick.addEventListener('click', () => socket?.emit('kick-host', { hostId: h.id }));
      li.append(kick);
    }
    return li;
  });
  groupList.replaceChildren(...items);
  groupHint.textContent = guest
    ? 'Quem está na sala escolhe qual tela assistir. Para sair, clique em "Sair do grupo".'
    : (group.hosts.length >= 4
      ? 'O grupo está cheio (4 pessoas).'
      : 'Quem estiver assistindo pode clicar em "Compartilhar minha tela aqui" no site para transmitir junto.');
  for (const input of nickInputs) if (document.activeElement !== input) input.value = nickname();
}

// The same switch lives on the setup screen (before going live) and in the room panel
function setGroupEnabled(enabled) {
  group.enabled = enabled;
  // Without a room yet, joining the room turns it on (see ensureRoom)
  if (socket && !group.guestRoom) socket.emit('group-mode', { enabled });
  renderGroupUi();
  if (enabled && !nickname()) {
    showToast('Coloque seu apelido, para seus amigos saberem qual tela é a sua.');
    if (panelStreaming.style.display !== 'none') document.getElementById('nickname').focus();
  }
}
groupToggle.addEventListener('change', () => setGroupEnabled(groupToggle.checked));
groupToggleSetup.addEventListener('change', () => setGroupEnabled(groupToggleSetup.checked));

// A friend's room code, or the room link they sent (…/room.html?room=abc)
groupJoin.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = groupJoinCode.value.trim();
  const room = (text.match(/[?&]room=([A-Za-z0-9_-]{1,64})/) || [])[1] || text;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
    showToast('Cole o código da sala ou o link que seu amigo mandou.');
    return;
  }
  groupJoinCode.value = '';
  handleGroupInvite({ room });
});

for (const input of nickInputs) {
  input.addEventListener('change', () => {
    const name = input.value.trim().slice(0, 24);
    try { localStorage.setItem(NICK_KEY, name); } catch {}
    socket?.emit('set-name', { name });
    renderGroupUi();
  });
}

// The site asked this app to stream in its room. Nothing is shared until the person picks a
// screen and clicks the start button.
function handleGroupInvite(invite) {
  const room = invite?.room;
  if (typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) return;
  if (group.guestRoom === room) return;
  if (isStreaming) {
    showToast('Pare a sua transmissão antes de entrar na transmissão em grupo.');
    return;
  }
  if (!group.guestRoom && room === roomId) {
    showToast('Essa é a sua própria sala. Ligue "Transmissão em grupo" nela para seus amigos entrarem.');
    return;
  }
  // Switching from another group's invite: leave that room if we were in it. Our own paused room
  // stays until the start button really joins this one, so "Cancelar" gets it back intact.
  if (group.guestRoom && roomId === group.guestRoom) leaveRoomConnection();
  group.guestRoom = room;
  group.slot = 0;
  group.ownerName = '';
  group.hosts = [];
  renderGroupUi();
  btnStart.textContent = startLabel();
  panelSetup.scrollIntoView?.({ block: 'start' });
  showToast('Escolha a tela e o som para transmitir na sala do grupo.');
}

function leaveRoomConnection() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socket = null;
  roomId = null;
  hostKey = null;
  viewerWatch.clear();
  roomBar.style.display = 'none';
}

function exitGuestMode() {
  if (!group.guestRoom) return;
  if (roomId === group.guestRoom) leaveRoomConnection();
  group.guestRoom = null;
  group.slot = 0;
  group.ownerName = '';
  group.hosts = [];
  renderGroupUi();
  btnStart.textContent = startLabel();
}

document.getElementById('btn-group-cancel').addEventListener('click', exitGuestMode);
window.electronAPI.onGroupInvite?.(handleGroupInvite);
window.electronAPI.takeGroupInvite?.().then(handleGroupInvite).catch(() => {});
renderGroupUi();

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
  const sharing = [...peerConnections.keys()].filter(id => !isExcluded(id) && viewerWatch.get(id) !== false).length || 1;
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
            // Not watching us right now (group room): no video goes to it on purpose
            idle: !isSfu && viewerWatch.get(viewerId) === false,
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
    } else if (samples.every(x => x.idle)) {
      streamStatsEl.textContent = 'Em grupo: quem está na sala está vendo outra tela agora (o seu som continua indo)';
    } else {
      const s = samples.find(x => x.sfu) || samples.find(x => !x.idle) || samples[0];
      const kbps = samples.map(x => (x.targetBitrate / 1e6).toFixed(1)).join('/');
      const mode = sfu.active ? 'servidor (SFU)' : 'direto';
      streamStatsEl.textContent =
        `${s.res} @ ${s.fps}fps | ${s.gpu ? 'GPU' : 'CPU'} | ${kbps} Mbps | ${mode} | ${roomViewerCount} viewer(s)`;
    }
    updateUploadBudget(samples.filter(x => !x.sfu && !x.idle));
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
    body: JSON.stringify({ source: 'host-stats', level: 'info', message: 'quality', context, room_id: roomId, app_version: '1.6.2', user_agent: navigator.userAgent })
  })).catch(() => {});
}

// ======== Hot-swap window + audio switching ========
const btnSwitchSource = document.getElementById('btn-switch-source');
const switchModal = document.getElementById('switch-modal');
const switchSourceGrid = document.getElementById('switch-source-grid');
const switchAudioList = document.getElementById('switch-audio-list');
const btnCloseModal = document.getElementById('btn-close-modal');
// The dialog only collects choices; Aplicar switches the screen, the sound or both
const switchPick = { sourceId: null, sources: [], sessions: [], audio: 'keep', audioByHand: false };
let liveAudio = null;
const btnSwitchApply = document.getElementById('btn-switch-apply');
const switchSummary = document.getElementById('switch-summary');

btnSwitchSource.addEventListener('click', async () => {
  switchModal.style.display = '';
  switchPick.sourceId = selectedSourceId;
  switchPick.audio = 'keep';
  switchPick.audioByHand = false;
  updateSwitchApply();

  switchSourceGrid.innerHTML = '<div class="loading">Procurando janelas…</div>';
  switchAudioList.innerHTML = '<div class="loading">Procurando apps com som…</div>';

  const [sources, audioResult] = await Promise.all([
    window.electronAPI.getSources(),
    window.electronAPI.listAudioSessions()
  ]);
  renderSwitchSources(sources);
  renderSwitchAudio(audioResult);
});

function renderSwitchSources(sources) {
  liveLists.sourceSig = sourceSignature(sources);
  switchPick.sources = sources;
  sources.forEach(s => knownSources.set(s.id, s));
  // The window being picked may have closed: fall back to what's on air
  if (!sources.some(s => s.id === switchPick.sourceId)) switchPick.sourceId = selectedSourceId;
  const screens = sources.filter(s => s.isScreen);
  const windows = sources.filter(s => !s.isScreen);
  switchSourceGrid.innerHTML = '';

  const addItem = (source) => {
    const item = createSourceItem(source, () => pickSwitchSource(source));
    item.dataset.sourceId = source.id;
    item.classList.toggle('selected', source.id === switchPick.sourceId);
    if (source.id === selectedSourceId) {
      item.querySelector('.source-label').append(Object.assign(document.createElement('span'), { className: 'now-tag', textContent: 'agora' }));
    }
    switchSourceGrid.appendChild(item);
  };

  if (screens.length > 0) {
    const screenLabel = document.createElement('div');
    screenLabel.className = 'source-section-label';
    screenLabel.textContent = 'Telas inteiras (melhor para jogos em tela cheia)';
    switchSourceGrid.appendChild(screenLabel);
    screens.forEach(addItem);
    const windowLabel = document.createElement('div');
    windowLabel.className = 'source-section-label';
    windowLabel.textContent = 'Janelas';
    switchSourceGrid.appendChild(windowLabel);
  }
  windows.forEach(addItem);
  updateSwitchApply();
}

async function pickSwitchSource(source) {
  switchPick.sourceId = source.id;
  switchSourceGrid.querySelectorAll('.source-item').forEach(el => el.classList.toggle('selected', el.dataset.sourceId === source.id));
  // Like on the setup screen, a game's window brings the game's sound along, unless a sound was picked by hand
  // Only while an app's sound is on air: a stream left on "Sem som" or "Todo o PC" stays that way
  if (!switchPick.audioByHand && typeof liveAudio === 'number') {
    let follow = 'keep';
    const owner = source.isScreen ? null : await window.electronAPI.getWindowOwner(source.id);
    if (switchPick.sourceId !== source.id) return;
    const session = owner && matchOwnerSession(owner, switchPick.sessions);
    if (session && session.pid !== liveAudio) follow = session.pid;
    if (follow !== switchPick.audio) {
      switchPick.audio = follow;
      renderSwitchAudio({ sessions: switchPick.sessions });
    }
  }
  updateSwitchApply();
}

function switchAudioLabel(value) {
  if (value === 'system') return 'Todo o PC';
  if (value === 'none') return 'Sem som';
  const s = switchPick.sessions.find(x => x.pid === value);
  return s ? s.name : 'outro app';
}

function updateSwitchApply() {
  const source = switchPick.sources.find(s => s.id === switchPick.sourceId);
  const videoChanged = !!source && switchPick.sourceId !== selectedSourceId;
  const audioChanged = switchPick.audio !== 'keep' && switchPick.audio !== liveAudio;
  btnSwitchApply.disabled = !(videoChanged || audioChanged);
  btnSwitchApply.textContent = videoChanged && audioChanged ? 'Trocar tela e som' : videoChanged ? 'Trocar tela' : audioChanged ? 'Trocar som' : 'Aplicar';
  const parts = [];
  if (videoChanged) parts.push(`tela: ${source.name}`);
  if (audioChanged) parts.push(`som: ${switchAudioLabel(switchPick.audio)}`);
  switchSummary.textContent = parts.length ? 'Vai trocar ' + parts.join(' e ') : 'Nada mudou ainda';
}

function renderSwitchAudio(audioResult) {
  switchAudioList.innerHTML = '';
  const sessions = (audioResult && audioResult.sessions) || [];
  switchPick.sessions = sessions;
  liveLists.audioSig = audioSignature(sessions);

  // Without an audio track the connections were set up video-only, so a sound can't be added live
  if (liveAudio === null) {
    switchAudioList.append(Object.assign(document.createElement('p'), {
      className: 'switch-note',
      textContent: 'Esta transmissão começou sem som. Para ter som, pare a transmissão e comece de novo escolhendo um som.'
    }));
    switchPick.audio = 'keep';
    updateSwitchApply();
    return;
  }
  // A redraw keeps what was picked, unless that app is gone
  if (typeof switchPick.audio === 'number' && !sessions.some(s => s.pid === switchPick.audio)) switchPick.audio = 'keep';

  const addOption = (value, children) => {
    const item = document.createElement('div');
    item.className = 'session-item' + (value === switchPick.audio ? ' selected' : '');
    item.setAttribute('role', 'button');
    item.append(...children);
    if (value !== 'keep' && value === liveAudio) {
      item.append(Object.assign(document.createElement('span'), { className: 'now-tag', textContent: 'agora' }));
    }
    item.addEventListener('click', () => {
      switchAudioList.querySelectorAll('.session-item.selected').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      switchPick.audio = value;
      switchPick.audioByHand = value !== 'keep';
      updateSwitchApply();
    });
    switchAudioList.appendChild(item);
  };
  const nameSpan = (text) => Object.assign(document.createElement('span'), { className: 'session-name', textContent: text });

  addOption('keep', [nameSpan('Manter o som atual')]);
  addOption('system', [nameSpan('Todo o PC')]);
  addOption('none', [nameSpan('Sem som')]);
  sessions.forEach(s => addOption(s.pid, sessionRow(s)));
  if (sessions.length === 0) {
    switchAudioList.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nenhum app tocando som agora' }));
  }
  updateSwitchApply();
}

btnSwitchApply.addEventListener('click', applySwitch);

// ======== Silent audio channel ========
let silentAudio = null;
function silentAudioTrack() {
  if (!silentAudio) {
    const ctx = new AudioContext();
    const destination = ctx.createMediaStreamDestination();
    silentAudio = { ctx, track: destination.stream.getAudioTracks()[0] };
  }
  return silentAudio.track;
}
function releaseSilentAudio() {
  if (!silentAudio) return;
  silentAudio.track.stop();
  silentAudio.ctx.close().catch(() => {});
  silentAudio = null;
}

// ======== Video switching ========
// Names and owners of sources, for the "window closed" recovery below
const knownSources = new Map();
const sourceById = (id) => knownSources.get(id) || { id, name: '', isScreen: String(id).startsWith('screen:') };
let currentSource = { id: null, name: '', isScreen: false, owner: '' };

async function rememberSource(source) {
  currentSource = { id: source.id, name: source.name, isScreen: source.isScreen, owner: '' };
  if (source.isScreen) return;
  const owner = await window.electronAPI.getWindowOwner(source.id);
  if (owner && currentSource.id === source.id) currentSource.owner = owner.name;
}

async function replaceVideoTrack(newVideoTrack) {
  for (const pc of sendingPcs()) {
    const transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === 'video' && t.sender);
    if (transceiver) await transceiver.sender.replaceTrack(newVideoTrack);
  }
  const oldVideoTrack = localStream.getVideoTracks()[0];
  if (oldVideoTrack) {
    stopVideoTrack(oldVideoTrack);
    localStream.removeTrack(oldVideoTrack);
  }
  localStream.addTrack(newVideoTrack);
  syncPreview();
}

async function switchVideo(source) {
  const newVideoTrack = await captureVideo(source.id);
  stopStandby();
  await replaceVideoTrack(newVideoTrack);
  selectedSourceId = source.id;
  rememberSource(source);
  (newVideoTrack.sourceTrack || newVideoTrack).addEventListener('ended', (e) => onCaptureEnded(e.target));
}

// ======== Captured window closed ========
// A game's window closes at the end of every match. Pausing there (as before) dropped every viewer,
// unnoticed with the app minimized. Now the stream stays up with a "be right back" card, the host
// gets a notification, and the program's window is picked up again by itself when it reappears
// (same title, or another window of the same program). A screen that goes away still pauses.
const standby = { active: false, timer: null, name: '', owner: '', lastIds: '', busy: false };

function standbyCardTrack() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const g = canvas.getContext('2d');
  const draw = (frog) => {
    g.fillStyle = '#0B1A10'; g.fillRect(0, 0, 1280, 720);
    if (frog) g.drawImage(frog, 560, 170, 160, 147);
    g.textAlign = 'center'; g.fillStyle = '#F3F8EC'; g.font = '600 44px Fredoka, sans-serif';
    g.fillText('O host está trocando de janela…', 640, 400);
    g.fillStyle = '#A9C6AC'; g.font = '28px Inter, sans-serif';
    g.fillText('A transmissão volta sozinha em instantes.', 640, 450);
  };
  const frog = new Image();
  frog.src = '/brand/frog-sleep.svg';
  draw(null);
  // A canvas only yields frames when it's drawn, so redraw twice a second: viewers who join during the
  // wait (and keyframe requests) need fresh frames. Identical frames cost almost nothing to encode.
  const timer = setInterval(() => draw(frog.complete ? frog : null), 500);
  const track = canvas.captureStream(2).getVideoTracks()[0];
  track.contentHint = 'detail';
  track.stopCard = () => clearInterval(timer);
  return track;
}

function onCaptureEnded(endedTrack) {
  if (!isStreaming || !localStream) return;
  const live = localStream.getVideoTracks()[0];
  if (!live || (live.sourceTrack || live) !== endedTrack) return; // already switched away
  if (currentSource.isScreen || !currentSource.id) { pauseStreaming(); return; }
  enterStandby();
}

async function enterStandby() {
  standby.active = true;
  standby.name = currentSource.name;
  standby.owner = currentSource.owner;
  standby.lastIds = '';
  await replaceVideoTrack(standbyCardTrack());
  selectedSourceId = null;
  const name = standby.name || 'A janela';
  showToast(`"${name}" fechou. Seus amigos veem um aviso; a transmissão volta sozinha quando ela abrir de novo.`);
  window.electronAPI.notify('A janela da transmissão fechou',
    `"${name}" fechou. Seus amigos veem um aviso de "já volta". A transmissão volta sozinha quando a janela abrir de novo, ou escolha outra em Trocar janela ou som.`);
  standby.timer = setInterval(checkStandby, 2000);
}

function stopStandby() {
  clearInterval(standby.timer);
  standby.timer = null;
  standby.active = false;
}

async function checkStandby() {
  if (!isStreaming || !standby.active) return stopStandby();
  if (standby.busy) return;
  standby.busy = true;
  try {
    // Cheap check first; the full list (thumbnails) only when a window opened or closed
    const ids = await window.electronAPI.getSourceIds();
    if (ids === standby.lastIds) return;
    standby.lastIds = ids;
    const windows = (await window.electronAPI.getSources()).filter(s => !s.isScreen);
    windows.forEach(s => knownSources.set(s.id, s));
    let match = windows.find(s => s.name === standby.name);
    if (!match && standby.owner) {
      for (const s of windows) {
        const owner = await window.electronAPI.getWindowOwner(s.id);
        if (owner && owner.name === standby.owner) { match = s; break; }
      }
    }
    if (!match || !standby.active) return;
    await switchVideo(match);
    showToast(`Voltou: mostrando ${match.name}`);
    window.electronAPI.notify('A transmissão voltou', `Mostrando "${match.name}" de novo.`);
  } catch (err) {
    reportError('Standby recovery failed: ' + err.message, err.stack);
  } finally {
    standby.busy = false;
  }
}
document.getElementById('btn-switch-cancel').addEventListener('click', () => { switchModal.style.display = 'none'; });

btnCloseModal.addEventListener('click', () => {
  switchModal.style.display = 'none';
});

switchModal.addEventListener('click', (e) => {
  if (e.target === switchModal) switchModal.style.display = 'none';
});

async function switchAudio(newPid, label = '') {
  // Stop old audio
  await window.electronAPI.stopAudioCapture();
  window.electronAPI.removeAudioListeners();
  if (audioWorkletNode) { audioWorkletNode.disconnect(); audioWorkletNode = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }

  // The new sound, or the silent channel for "Sem som" (also the fallback if capture fails)
  let newAudioTrack = silentAudioTrack();
  if (newPid !== 'none') {
    const result = await window.electronAPI.startAudioCapture(newPid);
    if (result.error) {
      showToast('Não deu para trocar o som: ' + result.error);
      newPid = 'none';
      label = 'Sem som';
    } else {
      newAudioTrack = await createAudioTrackFromProcess(result.sampleRate || 48000, result.channels || 2);
    }
  }

  const oldAudioTrack = localStream.getAudioTracks()[0];
  if (oldAudioTrack && oldAudioTrack !== newAudioTrack) {
    localStream.removeTrack(oldAudioTrack);
    if (oldAudioTrack !== silentAudio?.track) oldAudioTrack.stop();
  }
  if (!localStream.getAudioTracks().includes(newAudioTrack)) localStream.addTrack(newAudioTrack);

  // Same audio sender on every connection (and the SFU), so no renegotiation
  for (const pc of sendingPcs()) {
    const transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === 'audio' && t.sender);
    if (transceiver) await transceiver.sender.replaceTrack(newAudioTrack);
  }

  if (typeof newPid === 'number') selectedPid = newPid;
  liveAudio = newPid;
  showToast(`Som trocado para ${label || 'o app escolhido'}`);
}

async function applySwitch() {
  const source = switchPick.sources.find(s => s.id === switchPick.sourceId);
  const videoChanged = !!source && source.id !== selectedSourceId;
  const newAudio = switchPick.audio;
  const audioChanged = newAudio !== 'keep' && newAudio !== liveAudio;
  const audioName = audioChanged ? switchAudioLabel(newAudio) : '';
  switchModal.style.display = 'none';
  if (!videoChanged && !audioChanged) return;

  try {
    // Switch video
    if (videoChanged) await switchVideo(source);

    // Switch audio
    if (audioChanged) {
      await switchAudio(newAudio, audioName);
    }

    if (videoChanged && audioChanged) showToast(`Agora mostrando: ${source.name}, com o som de ${audioName}`);
    else if (videoChanged) showToast(`Agora mostrando: ${source.name}`);
  } catch (err) {
    showToast('Não deu para trocar: ' + err.message);
    reportError('Switch source failed: ' + err.message, err.stack);
  }
}

// ======== Refresh buttons ========
btnRefreshSources.addEventListener('click', () => loadSources());
btnRefreshAudio.addEventListener('click', () => loadAudioSessions());

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

// Downloads in the background, checks the file against the hash the server publishes, then
// installs silently and reopens. Without a published hash it falls back to the browser download.
const updateText = document.getElementById('update-text');
const updateProgress = document.getElementById('update-progress');
const btnUpdate = document.getElementById('btn-update');

function offerBrowserDownload(latest, message) {
  updateText.textContent = message;
  updateProgress.hidden = true;
  btnUpdate.disabled = false;
  btnUpdate.textContent = 'Baixar pelo navegador';
  btnUpdate.onclick = () => window.electronAPI.openDownload(latest.url);
}

let updateStarted = false;

async function startUpdate(latest) {
  updateStarted = true;
  btnUpdate.disabled = true;
  btnUpdate.textContent = 'Baixando…';
  updateText.textContent = `Baixando a versão ${latest.version} em segundo plano…`;
  updateProgress.value = 0;
  updateProgress.hidden = false;
  const result = await window.electronAPI.downloadUpdate();
  if (!result.ok) {
    updateStarted = false;
    offerBrowserDownload(latest, `Não deu para atualizar por aqui (${result.error}).`);
    return;
  }
  updateProgress.hidden = true;
  updateText.textContent = `Versão ${result.version} baixada. Ela é instalada sozinha quando você fechar o FrogShare.`;
  btnUpdate.disabled = false;
  btnUpdate.textContent = 'Reiniciar agora';
  btnUpdate.onclick = async () => {
    btnUpdate.disabled = true;
    const install = await window.electronAPI.installUpdate();
    if (install.ok) {
      btnUpdate.textContent = 'Instalando…';
    } else if (install.cancelled) {
      btnUpdate.disabled = false;
    } else {
      offerBrowserDownload(latest, `Não deu para instalar por aqui (${install.error}).`);
    }
  };
}

window.electronAPI.onUpdateProgress(({ received, total }) => {
  if (total) updateProgress.value = Math.round((received / total) * 100);
  btnUpdate.textContent = `Baixando… ${updateProgress.value}%`;
});

async function checkForUpdate() {
  try {
    appVersion = await window.electronAPI.getAppVersion();
    const url = await getSignalUrl();
    const latest = await (await fetch(`${url}/api/app-version`)).json();
    if (!latest.version || !versionOlder(appVersion, latest.version)) return;
    // Already downloading or downloaded: the banner already says so
    if (updateStarted) return;
    const platform = await window.electronAPI.getPlatform();
    const downloadUrl = platform === 'darwin' ? latest.macUrl : latest.url;
    if (!downloadUrl) return;
    updateText.textContent = `Versão ${latest.version} disponível (você está na ${appVersion}).`;
    // The silent installer (and its published hash) is the Windows build; the Mac .dmg goes through the browser
    if (platform === 'win32' && latest.sha512) {
      // Downloads right away; it installs on its own when the app is closed
      document.getElementById('update-banner').style.display = '';
      startUpdate(latest);
      return;
    } else {
      btnUpdate.textContent = 'Baixar';
      btnUpdate.onclick = () => window.electronAPI.openDownload(downloadUrl);
    }
    document.getElementById('update-banner').style.display = '';
  } catch {}
}

// ======== macOS permissions ========
// Screen and system-audio recording each need a macOS permission that nothing else asks for:
// without them the stream is blank or silent. Walk the host through both on first launch.
const panelPermissions = document.getElementById('panel-permissions');
const btnPermContinue = document.getElementById('btn-perm-continue');
const btnPermRelaunch = document.getElementById('btn-perm-relaunch');
const requestedPermissions = new Set();
let permissionPoll = null;

const audioMissing = (p) => p.audio === 'denied' || p.audio === 'not-determined';
const permissionsMissing = (p) => p.screen !== 'granted' || audioMissing(p);

function renderPermissions(p) {
  for (const row of panelPermissions.querySelectorAll('[data-perm]')) {
    const kind = row.dataset.perm;
    const status = p[kind];
    const granted = status === 'granted';
    // "unknown": the check itself isn't available, so there is nothing useful to ask
    row.hidden = status === 'unknown';
    row.querySelector('.perm-done').hidden = !granted;
    const unsupported = row.querySelector('.perm-unsupported');
    if (unsupported) unsupported.hidden = status !== 'unsupported';
    row.querySelector('.perm-btn').hidden = granted || status === 'unsupported';
    row.querySelector('.perm-hint').hidden = granted || !requestedPermissions.has(kind);
  }
  // Screen access only applies after a relaunch, so after asking that becomes the next step
  const needsRelaunch = p.screen !== 'granted' && requestedPermissions.has('screen');
  btnPermRelaunch.hidden = !needsRelaunch;
  btnPermContinue.hidden = needsRelaunch;
  btnPermContinue.disabled = p.screen !== 'granted';
  document.getElementById('permission-banner').style.display =
    permissionsMissing(p) && panelPermissions.style.display === 'none' ? '' : 'none';
}

async function refreshPermissions() {
  const p = await window.electronAPI.getPermissions();
  renderPermissions(p);
  return p;
}

function showPermissions(show) {
  panelPermissions.style.display = show ? '' : 'none';
  panelSetup.style.display = show ? 'none' : '';
  clearInterval(permissionPoll);
  // Picks up the switch being flipped in System Settings
  if (show) permissionPoll = setInterval(refreshPermissions, 2000);
  refreshPermissions();
}

panelPermissions.querySelectorAll('.perm-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const kind = btn.closest('[data-perm]').dataset.perm;
    btn.disabled = true;
    requestedPermissions.add(kind);
    try {
      renderPermissions(await window.electronAPI.requestPermission(kind));
    } finally {
      btn.disabled = false;
    }
  });
});
btnPermContinue.addEventListener('click', () => { showPermissions(false); loadSources(); });
document.getElementById('btn-perm-skip').addEventListener('click', () => showPermissions(false));
btnPermRelaunch.addEventListener('click', () => window.electronAPI.relaunchApp());
document.getElementById('btn-permission-banner').addEventListener('click', () => showPermissions(true));

async function initPermissions() {
  if (await window.electronAPI.getPlatform() !== 'darwin') return;
  if (permissionsMissing(await refreshPermissions())) showPermissions(true);
}

// ======== Live lists ========
// A game opened while the app is up shows its window and its sound without pressing Atualizar.
// Every few seconds: a cheap id-only window check (thumbnails only when the set changes) and the
// audio session list. Nothing runs while streaming with the modal closed or while minimized.
// windowSig is only ever compared with itself: it says "the set of windows changed", nothing more
const liveLists = { sourceSig: '', windowSig: '', audioSig: '', busy: false, minimized: false, ticks: 0, isMac: false };
window.electronAPI.getPlatform().then(p => { liveLists.isMac = p === 'darwin'; });

async function refreshLiveLists() {
  const modalOpen = switchModal.style.display !== 'none';
  const setupOpen = panelSetup.style.display !== 'none' && !isStreaming;
  if (liveLists.busy || liveLists.minimized || !(modalOpen || setupOpen)) return;
  liveLists.busy = true;
  try {
    // On macOS the window check is Electron's own (expensive), so it runs on every 4th pass only
    const checkWindows = !liveLists.isMac || liveLists.ticks % 4 === 0;
    const [ids, audio] = await Promise.all([
      checkWindows ? window.electronAPI.getSourceIds() : Promise.resolve(''),
      window.electronAPI.listAudioSessions()
    ]);
    if (ids) {
      const changed = liveLists.windowSig && ids !== liveLists.windowSig;
      liveLists.windowSig = ids;
      if (changed) {
        if (modalOpen) renderSwitchSources(await window.electronAPI.getSources());
        else await loadSources({ silent: true });
      }
    }
    if (!audio.error && audioSignature(audio.sessions) !== liveLists.audioSig) {
      const scroll = (modalOpen ? switchAudioList : sessionList).scrollTop;
      if (modalOpen) renderSwitchAudio(audio);
      else await loadAudioSessions({ silent: true, result: audio });
      (modalOpen ? switchAudioList : sessionList).scrollTop = scroll;
    }
  } catch {} finally {
    liveLists.busy = false;
  }
}

// Every 3s while the window has focus, every 6s while it's open behind something else
setInterval(() => {
  liveLists.ticks++;
  if (windowFocused || liveLists.ticks % 2 === 0) refreshLiveLists();
}, 3000);
window.electronAPI.onWindowFocus((focused) => { if (focused) refreshLiveLists(); });
window.electronAPI.onWindowMinimized((minimized) => {
  liveLists.minimized = minimized;
  if (!minimized) refreshLiveLists();
});

// ======== Init ========
initPermissions();
loadSources();
loadAudioSessions();
renderQualityControls();
checkForUpdate();
// For sessions left open for days: look again every few hours
setInterval(checkForUpdate, 6 * 3600 * 1000);

// Wake the Render free-tier server early so "Iniciar" doesn't wait on a cold start
getSignalUrl().then(url => {
  fetch(`${url}/health`).catch(() => {});
  getIceConfig();
});
