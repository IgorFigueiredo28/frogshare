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
        app_version: '1.1.3',
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

let pc = null;
let hostPaused = false;

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
  volumeControl.style.display = 'none';
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
  volumeControl.style.display = 'none';
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

// Candidates that arrive while the offer handler is still awaiting the ICE config
let earlyIce = [];
let offerToken = 0;

socket.on('offer', async ({ from, offer, sid }) => {
  if (pc) {
    try { pc.close(); } catch {}
  }

  hostPaused = false;
  pc = null;
  const myToken = ++offerToken;
  const iceConfig = await getIceConfig();
  if (myToken !== offerToken) return;

  pc = new RTCPeerConnection(iceConfig);
  pc.pendingIce = earlyIce.filter(e => e.sid === sid).map(e => e.candidate);
  earlyIce = [];
  pc.sid = sid;
  const thisPc = pc;

  setTimeout(async () => {
    if (pc === thisPc && thisPc.connectionState !== 'connected') {
      const diag = await iceDiagnostics(thisPc);
      reportError('ICE timeout 10s', null, { state: thisPc.connectionState, sid, ...diag });
      if (pc === thisPc) requestNewOffer('Conexao demorando, tentando de novo...');
    }
  }, 10000);

  pc.ontrack = (e) => {
    const isNewStream = remoteVideo.srcObject !== e.streams[0];
    remoteVideo.srcObject = e.streams[0];
    remoteVideo.style.display = 'block';
    placeholder.style.display = 'none';
    btnFullscreen.style.display = '';
    volumeControl.style.display = '';
    if (isNewStream) applyInitialAudio();

    const receivers = thisPc.getReceivers();
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
      iceDiagnostics(thisPc).then(diag => reportError('PeerConnection failed', null, { sid, ...diag }));
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
  if (!pc) {
    if (earlyIce.length < 100) earlyIce.push({ sid, candidate });
    return;
  }
  if (sid !== undefined && sid !== pc.sid) return;
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
      showToast('Toque no alto-falante para ativar o som');
    }
  }).catch(() => {
    showToast('Toque no alto-falante para ativar o som');
  });
}

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
  if (volumeControl.style.display === 'none') return;
  if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  const base = remoteVideo.muted ? 0 : remoteVideo.volume;
  if (e.key === 'ArrowUp') setVolume(base + 0.05);
  else if (e.key === 'ArrowDown') setVolume(base - 0.05);
  else if (e.key === 'm' || e.key === 'M') toggleMute();
  else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
  else return;
  e.preventDefault();
  showVolumeOsd();
});
