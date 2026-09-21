// ======== State ========
let selectedSourceId = null;
let selectedPid = null;
let localStream = null;
let audioContext = null;
let audioWorkletNode = null;
let socket = null;
const peerConnections = new Map();
let roomId = null;
let signalServer = '';
let isStreaming = false;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
  ]
};

function preferH264(sdp) {
  const lines = sdp.split('\r\n');
  const videoMLine = lines.findIndex(l => l.startsWith('m=video'));
  if (videoMLine === -1) return sdp;

  const h264Payloads = [];
  for (let i = videoMLine + 1; i < lines.length; i++) {
    if (lines[i].startsWith('m=')) break;
    const match = lines[i].match(/^a=rtpmap:(\d+)\s+H264\//i);
    if (match) h264Payloads.push(match[1]);
  }
  if (h264Payloads.length === 0) return sdp;

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
  item.innerHTML = `
    <img class="source-thumb" src="${source.thumbnail}" alt="${source.name}">
    <div class="source-label">
      ${source.appIcon ? `<img src="${source.appIcon}">` : ''}
      <span title="${source.name}">${source.name}</span>
    </div>
  `;
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
      for (let i = 0; i < frameSize; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          output[ch][i] = this.buffer[i * numChannels + ch] || 0;
        }
      }
      this.buffer = this.buffer.slice(samplesNeeded);
    } else {
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

// ======== Room Management (persistent) ========
async function ensureRoom() {
  if (roomId && socket && socket.connected) return;

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
    viewerCountBar.textContent = `${count} assistindo`;
  });

  roomCodeBar.textContent = roomId;
  roomBar.style.display = '';
}

// ======== Capture video (cursor hidden) ========
async function captureVideo(sourceId) {
  await window.electronAPI.setCaptureSource(sourceId);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { cursor: 'never' },
    audio: false
  });
  return stream;
}

// ======== Start Streaming ========
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Iniciando...';

  try {
    const mode = getAudioMode();
    const isResume = !!roomId;

    // 1. Capture video with cursor hidden
    const videoStream = await captureVideo(selectedSourceId);
    const videoTrack = videoStream.getVideoTracks()[0];
    videoTrack.contentHint = 'detail';
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
    localPreview.srcObject = localStream;

    // 3. Create or reuse room
    await ensureRoom();
    isStreaming = true;

    // 4. If resuming, notify server — it re-sends viewer-joined for each viewer
    if (isResume) {
      socket.emit('host-resume');
    }

    videoTrack.addEventListener('ended', pauseStreaming);

    // 5. Switch to streaming panel
    roomCodeEl.textContent = roomId;
    panelSetup.style.display = 'none';
    panelStreaming.style.display = '';

    startStatsUpdate();

  } catch (err) {
    showToast('Erro: ' + err.message);
    btnStart.disabled = false;
    btnStart.textContent = roomId ? 'Retomar Compartilhamento' : 'Iniciar Compartilhamento';
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
    params.encodings[0].maxBitrate = 4000000;
    params.encodings[0].maxFramerate = 30;
    params.degradationPreference = 'maintain-resolution';
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
  const h264Offer = { type: offer.type, sdp: preferH264(offer.sdp) };
  await pc.setLocalDescription(h264Offer);
  socket.emit('offer', { to: viewerId, offer: h264Offer });
}

// ======== Pause Streaming (room stays alive) ========
btnStop.addEventListener('click', pauseStreaming);

async function pauseStreaming() {
  isStreaming = false;

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
    socket.emit('host-pause');
  }

  localPreview.srcObject = null;

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
          streamStatsEl.textContent = `${w}x${h} @ ${fps}fps | ${peerConnections.size} viewer(s)`;
          break;
        }
      }
    } catch {}
  }, 2000);
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
      const newStream = await captureVideo(source.id);
      const newVideoTrack = newStream.getVideoTracks()[0];
      newVideoTrack.contentHint = 'detail';

      for (const [, pc] of peerConnections) {
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(newVideoTrack);
        }
      }

      const oldVideoTrack = localStream.getVideoTracks()[0];
      if (oldVideoTrack) oldVideoTrack.stop();
      localStream.removeTrack(oldVideoTrack);
      localStream.addTrack(newVideoTrack);

      localPreview.srcObject = localStream;
      selectedSourceId = source.id;
      newVideoTrack.addEventListener('ended', pauseStreaming);
    }

    // Switch audio
    if (audioChanged) {
      await switchAudio(newAudioPid);
    }

    showToast(`Trocado: ${source.name}`);
  } catch (err) {
    showToast('Erro ao trocar: ' + err.message);
  }
}

// ======== Refresh buttons ========
btnRefreshSources.addEventListener('click', loadSources);
btnRefreshAudio.addEventListener('click', loadAudioSessions);

// ======== Init ========
loadSources();
loadAudioSessions();
