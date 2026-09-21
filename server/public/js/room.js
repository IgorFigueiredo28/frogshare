const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');
const isHost = params.get('host') === '1';

if (!roomId) {
  window.location.href = '/';
}

document.getElementById('room-code').textContent = roomId;

const socket = io();
const peerConnections = new Map();
let localStream = null;

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
  const reordered = [...h264Payloads, ...payloads.filter(p => !h264Payloads.includes(p))];
  lines[videoMLine] = [...header, ...reordered].join(' ');
  return lines.join('\r\n');
}

const btnShare = document.getElementById('btn-share');
const btnStop = document.getElementById('btn-stop');
const btnCopy = document.getElementById('btn-copy');
const btnFullscreen = document.getElementById('btn-fullscreen');
const localPreview = document.getElementById('local-preview');
const remoteVideo = document.getElementById('remote-video');
const placeholder = document.getElementById('placeholder');
const statusText = document.getElementById('status-text');
const viewerCount = document.getElementById('viewer-count');
const controlsBar = document.getElementById('controls-bar');
const streamStats = document.getElementById('stream-stats');
const videoArea = document.getElementById('video-area');

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Hide host controls if viewer
if (!isHost) {
  btnShare.style.display = 'none';
  const audioSetup = document.getElementById('audio-setup');
  if (audioSetup) audioSetup.style.display = 'none';
  statusText.textContent = 'Aguardando host compartilhar a tela...';
}

// Copy room code
btnCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => showToast('Codigo copiado!'));
});

// Join room
socket.emit('join-room', { roomId, asHost: isHost });

socket.on('room-update', ({ hasHost, viewerCount: count }) => {
  viewerCount.textContent = `${count} assistindo`;
});

// ======== AUDIO DEVICE MANAGEMENT (HOST ONLY) ========
if (isHost) {
  const audioDeviceSelect = document.getElementById('audio-device-select');
  const deviceOption = document.getElementById('device-option');
  const btnRefresh = document.getElementById('btn-refresh-devices');
  const audioRadios = document.querySelectorAll('input[name="audio-source"]');

  async function loadAudioDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {}

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');

    audioDeviceSelect.innerHTML = '';
    let hasVirtual = false;

    audioInputs.forEach(device => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `Microfone ${device.deviceId.slice(0, 8)}`;
      audioDeviceSelect.appendChild(opt);

      const lbl = device.label.toLowerCase();
      if (lbl.includes('cable') || lbl.includes('virtual') || lbl.includes('vb-audio') || lbl.includes('voicemeeter')) {
        hasVirtual = true;
        opt.selected = true;
      }
    });

    if (audioInputs.length > 0) {
      deviceOption.style.display = '';
    }

    return hasVirtual;
  }

  loadAudioDevices();

  btnRefresh.addEventListener('click', async () => {
    const found = await loadAudioDevices();
    if (found) {
      showToast('Dispositivo virtual detectado!');
    } else {
      showToast(`${audioDeviceSelect.options.length} dispositivo(s) encontrado(s)`);
    }
  });

  audioRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      audioDeviceSelect.style.display = radio.value === 'device' && radio.checked ? '' : 'none';
    });
  });

  function getSelectedAudioSource() {
    const selected = document.querySelector('input[name="audio-source"]:checked').value;
    return selected;
  }

  function getSelectedDeviceId() {
    return audioDeviceSelect.value;
  }

  // ======== HOST SHARING LOGIC ========
  btnShare.addEventListener('click', startSharing);
  btnStop.addEventListener('click', stopSharing);

  async function startSharing() {
    try {
      const audioSource = getSelectedAudioSource();

      // Capture video (and optionally system audio) via getDisplayMedia
      const displayMediaOptions = {
        video: {
          cursor: 'always',
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude'
      };

      if (audioSource === 'system') {
        displayMediaOptions.audio = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000
        };
        displayMediaOptions.systemAudio = 'include';
      } else {
        displayMediaOptions.audio = false;
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

      // If user selected a specific device, capture audio separately
      if (audioSource === 'device') {
        const deviceId = getSelectedDeviceId();
        if (deviceId) {
          try {
            const audioStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                deviceId: { exact: deviceId },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48000,
                channelCount: 2
              }
            });

            // Combine video from display + audio from device
            localStream = new MediaStream([
              ...displayStream.getVideoTracks(),
              ...audioStream.getAudioTracks()
            ]);

            // Stop audio when display stops
            displayStream.getVideoTracks()[0].addEventListener('ended', () => {
              audioStream.getTracks().forEach(t => t.stop());
            });
          } catch (audioErr) {
            showToast('Erro ao capturar audio do dispositivo: ' + audioErr.message);
            localStream = displayStream;
          }
        } else {
          localStream = displayStream;
        }
      } else {
        localStream = displayStream;
      }

      localPreview.srcObject = localStream;
      localPreview.style.display = 'block';
      placeholder.style.display = 'none';
      btnShare.style.display = 'none';
      btnStop.style.display = '';
      controlsBar.style.display = '';
      document.getElementById('audio-setup').style.display = 'none';

      localStream.getVideoTracks()[0].addEventListener('ended', stopSharing);

      for (const [viewerId] of peerConnections) {
        createOfferForViewer(viewerId);
      }

      const hasAudio = localStream.getAudioTracks().length > 0;
      showToast(hasAudio ? 'Compartilhando tela com audio' : 'Compartilhando tela (sem audio)');
      updateStats();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        showToast('Erro ao capturar tela: ' + err.message);
      }
    }
  }

  function stopSharing() {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    localPreview.style.display = 'none';
    localPreview.srcObject = null;
    placeholder.style.display = '';
    btnShare.style.display = '';
    btnStop.style.display = 'none';
    controlsBar.style.display = 'none';
    document.getElementById('audio-setup').style.display = '';

    for (const [id, pc] of peerConnections) {
      pc.close();
    }
    peerConnections.clear();
  }

  socket.on('viewer-joined', async ({ viewerId }) => {
    if (localStream) {
      await createOfferForViewer(viewerId);
    } else {
      peerConnections.set(viewerId, null);
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
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });

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

  let statsInterval;
  function updateStats() {
    clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
      if (peerConnections.size === 0) {
        streamStats.textContent = 'Transmitindo (0 conexoes)';
        return;
      }
      const [, pc] = [...peerConnections.entries()][0];
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        for (const report of stats.values()) {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            const fps = report.framesPerSecond || '-';
            const width = report.frameWidth || '-';
            const height = report.frameHeight || '-';
            streamStats.textContent =
              `${width}x${height} @ ${fps}fps | ${peerConnections.size} conexao(es)`;
            break;
          }
        }
      } catch {}
    }, 2000);
  }
}

// ======== VIEWER LOGIC ========
if (!isHost) {
  let pc = null;

  socket.on('host-joined', () => {
    statusText.textContent = 'Host conectado, aguardando tela...';
  });

  socket.on('host-left', () => {
    statusText.textContent = 'Host desconectou.';
    remoteVideo.style.display = 'none';
    placeholder.style.display = '';
    btnFullscreen.style.display = 'none';
    if (pc) {
      pc.close();
      pc = null;
    }
  });

  socket.on('offer', async ({ from, offer }) => {
    if (pc) pc.close();

    pc = new RTCPeerConnection(ICE_SERVERS);

    pc.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
      remoteVideo.style.display = 'block';
      placeholder.style.display = 'none';
      btnFullscreen.style.display = '';

      // Reduce jitter buffer for lower latency
      const receiver = e.receiver;
      if (receiver && receiver.jitterBufferTarget !== undefined) {
        receiver.jitterBufferTarget = 50;
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('ice-candidate', { to: from, candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        statusText.textContent = '';
      } else if (pc.connectionState === 'disconnected') {
        statusText.textContent = 'Reconectando...';
        // Auto-reconnect after brief disconnect
        setTimeout(() => {
          if (pc && pc.connectionState === 'disconnected') {
            pc.close();
            pc = null;
            socket.emit('join-room', { roomId, asHost: false });
            statusText.textContent = 'Reconectando...';
          }
        }, 3000);
      } else if (pc.connectionState === 'failed') {
        remoteVideo.style.display = 'none';
        placeholder.style.display = '';
        statusText.textContent = 'Conexao perdida. Reconectando...';
        pc.close();
        pc = null;
        socket.emit('join-room', { roomId, asHost: false });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    const h264Answer = { type: answer.type, sdp: preferH264(answer.sdp) };
    await pc.setLocalDescription(h264Answer);
    socket.emit('answer', { to: from, answer: h264Answer });
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });

  btnFullscreen.addEventListener('click', () => {
    if (videoArea.requestFullscreen) {
      videoArea.requestFullscreen();
    }
  });

  remoteVideo.addEventListener('click', () => {
    if (remoteVideo.muted) {
      remoteVideo.muted = false;
    }
  });
}

// Double click for fullscreen (both roles)
videoArea.addEventListener('dblclick', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    videoArea.requestFullscreen().catch(() => {});
  }
});
