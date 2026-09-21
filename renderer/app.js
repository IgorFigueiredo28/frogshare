// ======== State ========
let selectedSourceId = null;
let selectedPid = null;
let localStream = null;
let audioContext = null;
let audioWorkletNode = null;
let socket = null;
const peerConnections = new Map();
let roomId = null;
let serverPort = 3030;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

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
const roomCodeEl = document.getElementById('room-code');
const viewerCountEl = document.getElementById('viewer-count');
const streamStatsEl = document.getElementById('stream-stats');
const audioModeRadios = document.querySelectorAll('input[name="audio-mode"]');

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

  sourceGrid.innerHTML = '';
  sources.forEach(source => {
    const item = document.createElement('div');
    item.className = 'source-item' + (source.id === selectedSourceId ? ' selected' : '');
    item.innerHTML = `
      <img class="source-thumb" src="${source.thumbnail}" alt="${source.name}">
      <div class="source-label">
        ${source.appIcon ? `<img src="${source.appIcon}">` : ''}
        <span title="${source.name}">${source.name}</span>
      </div>
    `;
    item.addEventListener('click', () => {
      document.querySelectorAll('.source-item.selected').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedSourceId = source.id;
      updateStartButton();
    });
    sourceGrid.appendChild(item);
  });
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
const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.port.onmessage = (e) => {
      const newData = new Float32Array(e.data);
      const combined = new Float32Array(this.buffer.length + newData.length);
      combined.set(this.buffer);
      combined.set(newData, this.buffer.length);
      // Keep max 1 second of buffer to prevent unbounded growth
      if (combined.length > 48000 * 2) {
        this.buffer = combined.slice(combined.length - 48000 * 2);
      } else {
        this.buffer = combined;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const numChannels = output.length;
    const frameSize = output[0].length;
    const samplesNeeded = frameSize * numChannels;

    if (this.buffer.length >= samplesNeeded) {
      // Deinterleave: input is [L,R,L,R,...], output is separate channels
      for (let i = 0; i < frameSize; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          output[ch][i] = this.buffer[i * numChannels + ch] || 0;
        }
      }
      this.buffer = this.buffer.slice(samplesNeeded);
    } else {
      // Not enough data, output silence
      for (let ch = 0; ch < numChannels; ch++) {
        output[ch].fill(0);
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

async function createAudioTrackFromProcess(sampleRate, channels) {
  audioContext = new AudioContext({ sampleRate });

  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor', {
    outputChannelCount: [channels]
  });

  const destination = audioContext.createMediaStreamDestination();
  audioWorkletNode.connect(destination);

  window.electronAPI.onAudioData((data) => {
    if (audioWorkletNode) {
      audioWorkletNode.port.postMessage(data);
    }
  });

  return destination.stream.getAudioTracks()[0];
}

// ======== Start Streaming ========
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Iniciando...';

  try {
    const mode = getAudioMode();

    // 1. Capture video from selected window
    const videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: selectedSourceId,
          maxFrameRate: 60,
          maxWidth: 1920,
          maxHeight: 1080
        }
      }
    });

    const videoTrack = videoStream.getVideoTracks()[0];
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
      try {
        const sysAudio = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop'
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: selectedSourceId
            }
          }
        });
        const sysTracks = sysAudio.getAudioTracks();
        if (sysTracks.length > 0) tracks.push(sysTracks[0]);
        sysAudio.getVideoTracks().forEach(t => t.stop());
      } catch {
        showToast('Nao foi possivel capturar audio do sistema');
      }
    }

    localStream = new MediaStream(tracks);
    localPreview.srcObject = localStream;

    // 3. Create room
    const port = await window.electronAPI.getServerPort();
    serverPort = port;
    const res = await fetch(`http://localhost:${port}/api/room/create`);
    const data = await res.json();
    roomId = data.roomId;

    // 4. Connect signaling
    socket = io(`http://localhost:${port}`);
    socket.emit('join-room', { roomId, asHost: true });

    socket.on('viewer-joined', async ({ viewerId }) => {
      await createOfferForViewer(viewerId);
    });

    socket.on('viewer-left', ({ viewerId }) => {
      const pc = peerConnections.get(viewerId);
      if (pc) pc.close();
      peerConnections.delete(viewerId);
    });

    socket.on('answer', async ({ from, answer }) => {
      const pc = peerConnections.get(from);
      if (pc && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const pc = peerConnections.get(from);
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
    });

    socket.on('room-update', ({ viewerCount: count }) => {
      viewerCountEl.textContent = `${count} assistindo`;
    });

    videoTrack.addEventListener('ended', stopStreaming);

    // 5. Switch to streaming panel
    roomCodeEl.textContent = roomId;
    panelSetup.style.display = 'none';
    panelStreaming.style.display = '';

    startStatsUpdate();

  } catch (err) {
    showToast('Erro: ' + err.message);
    btnStart.disabled = false;
    btnStart.textContent = 'Iniciar Compartilhamento';
  }
});

// ======== WebRTC ========
async function createOfferForViewer(viewerId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections.set(viewerId, pc);

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
  if (videoSender) {
    const params = videoSender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = 8000000;
    params.encodings[0].maxFramerate = 60;
    await videoSender.setParameters(params);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: viewerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      pc.close();
      peerConnections.delete(viewerId);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { to: viewerId, offer });
}

// ======== Stop ========
btnStop.addEventListener('click', stopStreaming);

async function stopStreaming() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
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
    socket.disconnect();
    socket = null;
  }

  roomId = null;
  localPreview.srcObject = null;

  panelStreaming.style.display = 'none';
  panelSetup.style.display = '';
  btnStart.textContent = 'Iniciar Compartilhamento';
  updateStartButton();
}

// ======== Copy buttons ========
btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => showToast('Codigo copiado!'));
});

btnCopyLink.addEventListener('click', () => {
  const link = `http://localhost:${serverPort}/room.html?room=${roomId}`;
  navigator.clipboard.writeText(link).then(() => showToast('Link copiado! (funciona na rede local)'));
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
          streamStatsEl.textContent = `${w}x${h} @ ${fps}fps | ${peerConnections.size} viewer(s)`;
          break;
        }
      }
    } catch {}
  }, 2000);
}

// ======== Refresh buttons ========
btnRefreshSources.addEventListener('click', loadSources);
btnRefreshAudio.addEventListener('click', loadAudioSessions);

// ======== Init ========
loadSources();
loadAudioSessions();
