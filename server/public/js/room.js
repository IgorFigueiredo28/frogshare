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
        app_version: '1.1.1',
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

function requestNewOffer(message) {
  if (pc) { try { pc.close(); } catch {} }
  pc = null;
  if (hostPaused) return;
  statusText.textContent = message;
  socket.emit('join-room', { roomId, asHost: false });
}

socket.on('offer', async ({ from, offer, sid }) => {
  if (pc) {
    try { pc.close(); } catch {}
  }

  hostPaused = false;
  pc = new RTCPeerConnection(ICE_SERVERS);
  pc.pendingIce = [];
  pc.sid = sid;
  const thisPc = pc;

  setTimeout(() => {
    if (pc === thisPc && thisPc.connectionState !== 'connected') {
      reportError('ICE timeout 10s', null, { state: thisPc.connectionState, sid });
      requestNewOffer('Conexao demorando, tentando de novo...');
    }
  }, 10000);

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

    const receivers = pc.getReceivers();
    for (const receiver of receivers) {
      if (receiver.jitterBufferTarget !== undefined) {
        receiver.jitterBufferTarget = 0;
      }
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: from, candidate: e.candidate, sid });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc !== thisPc) return;
    const state = thisPc.connectionState;
    if (state === 'connected') {
      statusText.textContent = '';
    } else if (state === 'disconnected') {
      if (hostPaused) return;
      statusText.textContent = 'Reconectando...';
      setTimeout(() => {
        if (pc === thisPc && thisPc.connectionState === 'disconnected') {
          requestNewOffer('Reconectando...');
        }
      }, 3000);
    } else if (state === 'failed') {
      reportError('PeerConnection failed', null, { sid: thisPc.sid });
      remoteVideo.style.display = 'none';
      placeholder.style.display = '';
      requestNewOffer('Conexao perdida. Reconectando...');
    }
  };

  try {
    await thisPc.setRemoteDescription(offer);
    for (const c of thisPc.pendingIce.splice(0)) thisPc.addIceCandidate(c).catch(() => {});
    const answer = await thisPc.createAnswer();
    const h264Answer = { type: answer.type, sdp: preferH264(answer.sdp) };
    await thisPc.setLocalDescription(h264Answer);
    if (pc !== thisPc) return;
    socket.emit('answer', { to: from, answer: h264Answer, sid });
  } catch (err) {
    console.error('Negotiation failed', err);
    reportError('Negotiation failed: ' + err.message, err.stack, { from });
  }
});

socket.on('ice-candidate', ({ candidate, sid }) => {
  if (!pc || (sid !== undefined && sid !== pc.sid)) return;
  if (pc.remoteDescription) pc.addIceCandidate(candidate).catch(() => {});
  else pc.pendingIce.push(candidate);
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
