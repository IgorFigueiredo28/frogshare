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
const videoArea = document.getElementById('video-area');

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

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Join room as viewer
socket.emit('join-room', { roomId, asHost: false });

socket.on('room-update', ({ hasHost, viewerCount: count }) => {
  viewerCount.textContent = `${count} assistindo`;
  if (!hasHost) {
    statusText.textContent = 'Aguardando host conectar...';
  }
});

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

let pc = null;

socket.on('offer', async ({ from, offer }) => {
  if (pc) pc.close();

  pc = new RTCPeerConnection(ICE_SERVERS);

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    remoteVideo.style.display = 'block';
    placeholder.style.display = 'none';
    btnFullscreen.style.display = '';

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
btnFullscreen.addEventListener('click', () => {
  if (videoArea.requestFullscreen) {
    videoArea.requestFullscreen();
  }
});

videoArea.addEventListener('dblclick', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    videoArea.requestFullscreen().catch(() => {});
  }
});

// Unmute on click
remoteVideo.addEventListener('click', () => {
  if (remoteVideo.muted) {
    remoteVideo.muted = false;
  }
});
