const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');

if (!roomId) {
  window.location.href = '/';
}

document.getElementById('room-code').textContent = roomId;

const socket = io();
const viewerCount = document.getElementById('viewer-count');
const remoteVideo = document.getElementById('remote-video');
const placeholder = document.getElementById('placeholder');
const statusText = document.getElementById('status-text');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnMute = document.getElementById('btn-mute');
const videoArea = document.getElementById('video-area');

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
  ]
};

let pc = null;
let hostPaused = false;

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

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Join room as viewer (re-joins automatically on reconnection)
socket.on('connect', () => {
  socket.emit('join-room', { roomId, asHost: false });
});

socket.on('room-update', ({ hasHost, viewerCount: count }) => {
  viewerCount.textContent = `${count} assistindo`;
  if (!hasHost) {
    statusText.textContent = 'Aguardando host conectar...';
  }
});

socket.on('host-joined', () => {
  hostPaused = false;
  statusText.textContent = 'Host conectado, aguardando tela...';
  placeholder.style.display = '';
});

socket.on('host-left', () => {
  hostPaused = false;
  statusText.textContent = 'Host desconectou.';
  remoteVideo.style.display = 'none';
  placeholder.style.display = '';
  btnFullscreen.style.display = 'none';
  btnMute.style.display = 'none';
  if (pc) {
    pc.close();
    pc = null;
  }
});

socket.on('host-paused', () => {
  hostPaused = true;
  statusText.textContent = 'Host pausou a transmissao...';
  remoteVideo.style.display = 'none';
  placeholder.style.display = '';
  btnFullscreen.style.display = 'none';
  btnMute.style.display = 'none';
  if (pc) {
    pc.close();
    pc = null;
  }
});

socket.on('offer', async ({ from, offer }) => {
  if (pc) {
    try { pc.close(); } catch {}
  }

  hostPaused = false;
  pc = new RTCPeerConnection(ICE_SERVERS);

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    remoteVideo.style.display = 'block';
    placeholder.style.display = 'none';
    btnFullscreen.style.display = '';
    btnMute.style.display = '';
    btnMute.textContent = 'Desmutar';

    remoteVideo.play().then(() => {
      remoteVideo.muted = false;
      btnMute.textContent = 'Mutar';
    }).catch(() => {
      showToast('Clique em "Desmutar" para ouvir o audio');
    });

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
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      statusText.textContent = '';
    } else if (pc.connectionState === 'disconnected') {
      if (hostPaused) return;
      statusText.textContent = 'Reconectando...';
      setTimeout(() => {
        if (pc && pc.connectionState === 'disconnected') {
          pc.close();
          pc = null;
          socket.emit('join-room', { roomId, asHost: false });
        }
      }, 3000);
    } else if (pc.connectionState === 'failed') {
      remoteVideo.style.display = 'none';
      placeholder.style.display = '';
      if (hostPaused) return;
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

// Fullscreen
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    videoArea.requestFullscreen().catch(() => {});
  }
}

document.addEventListener('fullscreenchange', () => {
  btnFullscreen.textContent = document.fullscreenElement ? 'Sair Tela Cheia' : 'Tela Cheia';
});

btnFullscreen.addEventListener('click', toggleFullscreen);
videoArea.addEventListener('dblclick', toggleFullscreen);

// Mute toggle
btnMute.addEventListener('click', () => {
  if (remoteVideo.muted) {
    remoteVideo.muted = false;
    remoteVideo.play().catch(() => {});
    btnMute.textContent = 'Mutar';
  } else {
    remoteVideo.muted = true;
    btnMute.textContent = 'Desmutar';
  }
});
