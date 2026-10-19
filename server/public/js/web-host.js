// Streaming from the site itself (transmitir.html), for people who can't or won't install the app:
// the browser's own screen picker, then the same signaling the app speaks, so the room page works
// unchanged. One encode and one upload per viewer (no media server here) and a fixed room per browser.
(function () {
  const $ = (id) => document.getElementById(id);
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} }
  };
  const ROOM_KEY = 'fs-web-room';
  const NAME_KEY = 'fs-web-name';
  const QUALITY_KEY = 'fs-web-quality';
  const AUDIO_KEY = 'fs-web-audio';

  function showToast(msg) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // Desktop Chrome, Edge and Firefox can share a screen; phones can't
  const supported = !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const btnStart = $('wh-start');
  if (!supported) {
    $('wh-unsupported').hidden = false;
    btnStart.disabled = true;
  }

  const nameInput = $('wh-name');
  nameInput.value = storage.get(NAME_KEY) || '';
  const savedQuality = storage.get(QUALITY_KEY);
  if (savedQuality) {
    const radio = [...document.querySelectorAll('input[name="wh-quality"]')].find(r => r.value === savedQuality);
    if (radio) radio.checked = true;
  }
  $('wh-audio').checked = storage.get(AUDIO_KEY) !== '0';
  const quality = () => {
    const [h, fps] = document.querySelector('input[name="wh-quality"]:checked').value.split('-').map(Number);
    return { h, fps };
  };
  const displayName = () => nameInput.value.trim().slice(0, 24) || 'Amigo';

  // ======== State ========
  let socket = null, roomId = null, hostKey = null, stream = null, live = false, rejectedOnce = false;
  const pcs = new Map();      // viewerId -> RTCPeerConnection
  const pending = new Map();  // viewerId -> token of the offer being prepared (a 'viewer-left' cancels it)
  const low = new Set();      // viewers who asked for "Economizar dados"
  let seq = 0, iceConfig = null;

  async function getIce() {
    if (iceConfig) return iceConfig;
    try {
      iceConfig = { iceServers: (await (await fetch('/api/ice-servers')).json()).iceServers };
    } catch {
      iceConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
    }
    return iceConfig;
  }

  // Same bits per pixel as the app: 0.1 at 60 fps, 0.13 at 30 (more bits per frame)
  function presetBitrate() {
    const s = stream?.getVideoTracks()[0]?.getSettings() || {};
    const { h, fps } = quality();
    const height = Math.min(h, s.height || h);
    const width = s.width && s.height ? Math.round(s.width * height / s.height) : Math.round(height * 16 / 9);
    return Math.round(Math.min(20e6, Math.max(2e6, width * height * fps * (fps > 30 ? 0.1 : 0.13))));
  }
  const LOW_BPS = 1200000;

  async function applySender(pc, viewerId) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const isLow = low.has(viewerId);
    const h = sender.track.getSettings().height || 0;
    params.encodings[0].maxBitrate = isLow ? LOW_BPS : presetBitrate();
    params.encodings[0].maxFramerate = isLow ? Math.min(30, quality().fps) : quality().fps;
    params.encodings[0].scaleResolutionDownBy = isLow && h > 540 ? h / 540 : 1;
    params.degradationPreference = 'balanced';
    try { await sender.setParameters(params); } catch {}
  }

  // A start bitrate, or WebRTC ramps up from ~300 kbps and the first seconds look blurry; stereo sound
  function tuneAnswer(sdp) {
    const lines = sdp.split('\r\n');
    const video = new Set(), opus = new Set();
    let section = '';
    for (const l of lines) {
      if (l.startsWith('m=')) section = l.slice(2, 7);
      const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
      if (!m) continue;
      if (section === 'video' && /^(H264|VP8|VP9|AV1)$/i.test(m[2])) video.add(m[1]);
      if (section === 'audio' && /^opus$/i.test(m[2])) opus.add(m[1]);
    }
    return lines.map(l => {
      const m = l.match(/^a=fmtp:(\d+) (.*)$/);
      if (!m) return l;
      if (video.has(m[1]) && !m[2].includes('x-google-start-bitrate')) return l + ';x-google-start-bitrate=3000';
      if (opus.has(m[1]) && !m[2].includes('stereo=')) return l + ';stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
      return l;
    }).join('\r\n');
  }

  async function offer(viewerId) {
    const old = pcs.get(viewerId);
    if (old) old.close();
    pcs.delete(viewerId);
    const token = {};
    pending.set(viewerId, token);
    const config = await getIce();
    if (pending.get(viewerId) !== token) return;
    pending.delete(viewerId);
    if (!live || !stream || pcs.has(viewerId)) return;
    const pc = new RTCPeerConnection(config);
    pc.sid = ++seq;
    pc.pendingIce = [];
    pcs.set(viewerId, pc);
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('ice-candidate', { to: viewerId, candidate: e.candidate, sid: pc.sid }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return;
      if (pcs.get(viewerId) === pc) pcs.delete(viewerId);
      if (pc.connectionState === 'failed') pc.close();
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await applySender(pc, viewerId);
      if (pcs.get(viewerId) !== pc) return;
      socket.emit('offer', { to: viewerId, offer: pc.localDescription, sid: pc.sid });
    } catch (err) {
      pc.close();
      if (pcs.get(viewerId) === pc) pcs.delete(viewerId);
    }
  }

  // ======== Room: the same one every time in this browser, so the link never changes ========
  async function newRoom() {
    const res = await fetch('/api/room/create');
    if (!res.ok) throw new Error('não deu para criar a sala');
    ({ roomId, hostKey } = await res.json());
    storage.set(ROOM_KEY, JSON.stringify({ roomId, hostKey }));
  }

  function join() {
    socket.emit('join-room', { roomId, asHost: true, hostKey, appVersion: 'web', name: displayName() });
    if (!live) socket.emit('host-pause');
  }

  async function ensureRoom() {
    if (socket) return;
    let saved = null;
    try { saved = JSON.parse(storage.get(ROOM_KEY) || 'null'); } catch {}
    if (saved && /^[A-Za-z0-9_-]{1,64}$/.test(saved.roomId || '') && saved.hostKey) ({ roomId, hostKey } = saved);
    else await newRoom();
    socket = io();
    socket.on('connect', join);
    socket.on('host-rejected', async ({ reason } = {}) => {
      // The saved room went to someone else (a server restart and an unlucky claim): start a new one
      if (rejectedOnce) { showToast(reason || 'O servidor não aceitou a sala.'); return; }
      rejectedOnce = true;
      try { await newRoom(); renderLink(); join(); } catch (err) { showToast(err.message); }
    });
    socket.on('viewer-joined', ({ viewerId } = {}) => { if (live && stream && viewerId) offer(viewerId); });
    socket.on('viewer-needs-p2p', ({ viewerId } = {}) => { if (live && stream && viewerId) offer(viewerId); });
    socket.on('viewer-left', ({ viewerId } = {}) => {
      pending.delete(viewerId);
      low.delete(viewerId);
      const pc = pcs.get(viewerId);
      if (pc) pc.close();
      pcs.delete(viewerId);
    });
    socket.on('answer', async ({ from, answer, sid } = {}) => {
      const pc = pcs.get(from);
      if (!pc || pc.signalingState !== 'have-local-offer' || (sid !== undefined && sid !== pc.sid)) return;
      try {
        await pc.setRemoteDescription({ type: answer.type, sdp: tuneAnswer(answer.sdp) });
        for (const c of pc.pendingIce.splice(0)) pc.addIceCandidate(c).catch(() => {});
      } catch {}
    });
    socket.on('ice-candidate', ({ from, candidate, sid } = {}) => {
      const pc = pcs.get(from);
      if (!pc || (sid !== undefined && sid !== pc.sid)) return;
      if (pc.remoteDescription) pc.addIceCandidate(candidate).catch(() => {});
      else pc.pendingIce.push(candidate);
    });
    socket.on('viewer-quality', ({ viewerId, low: isLow } = {}) => {
      if (isLow) low.add(viewerId); else low.delete(viewerId);
      const pc = pcs.get(viewerId);
      if (pc) applySender(pc, viewerId);
    });
    socket.on('room-update', ({ viewerCount = 0, viewerNames = [] } = {}) => renderViewers(viewerCount, viewerNames));
    socket.on('reaction', ({ emoji, name } = {}) => addReaction(emoji, name));
  }

  // ======== Capture ========
  let silent = null;
  function silentTrack() {
    if (!silent) {
      const ctx = new AudioContext();
      silent = { ctx, track: ctx.createMediaStreamDestination().stream.getAudioTracks()[0] };
    }
    return silent.track;
  }

  async function capture() {
    const { h, fps } = quality();
    const media = await navigator.mediaDevices.getDisplayMedia({
      video: { height: { ideal: h, max: h }, frameRate: { ideal: fps, max: fps } },
      audio: $('wh-audio').checked ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include'
    });
    const video = media.getVideoTracks()[0];
    video.contentHint = 'motion';
    // Every stream carries a sound channel (silent if needed), so switching later never renegotiates
    if (!media.getAudioTracks().length) media.addTrack(silentTrack());
    // "Parar de compartilhar" in the browser's own bar
    video.addEventListener('ended', () => { if (live && stream?.getVideoTracks()[0] === video) stop(); });
    return media;
  }

  function releaseTracks(media) {
    for (const t of media?.getTracks() || []) if (t !== silent?.track) t.stop();
  }

  // ======== Start, switch, stop ========
  async function start() {
    if (!supported) return;
    storage.set(NAME_KEY, nameInput.value.trim());
    storage.set(QUALITY_KEY, document.querySelector('input[name="wh-quality"]:checked').value);
    storage.set(AUDIO_KEY, $('wh-audio').checked ? '1' : '0');
    btnStart.disabled = true;
    btnStart.textContent = 'Escolhendo a tela…';
    try {
      stream = await capture();
    } catch (err) {
      btnStart.disabled = false;
      btnStart.textContent = socket ? 'Voltar a transmitir' : 'Escolher a tela e começar';
      if (err.name !== 'NotAllowedError') showToast('Não deu para capturar a tela: ' + err.message);
      return;
    }
    live = true;
    $('wh-preview').srcObject = stream;
    const resume = !!socket;
    try {
      await ensureRoom();
    } catch (err) {
      showToast('Não deu para abrir a sala: ' + err.message);
      stop();
      return;
    }
    if (resume) {
      socket.emit('set-name', { name: displayName() });
      socket.emit('host-resume');
    }
    renderLink();
    setState('live');
    startHealth();
    btnStart.disabled = false;
  }

  async function switchSource() {
    let next;
    try {
      next = await capture();
    } catch (err) {
      if (err.name !== 'NotAllowedError') showToast('Não deu para trocar: ' + err.message);
      return;
    }
    const previous = stream;
    stream = next;
    $('wh-preview').srcObject = stream;
    for (const [id, pc] of pcs) {
      for (const kind of ['video', 'audio']) {
        const sender = pc.getSenders().find(s => s.track?.kind === kind);
        const track = stream.getTracks().find(t => t.kind === kind);
        if (sender && track) await sender.replaceTrack(track).catch(() => {});
      }
      applySender(pc, id);
    }
    releaseTracks(previous);
    showToast('Pronto, mostrando o que você escolheu.');
  }

  function stop() {
    live = false;
    releaseTracks(stream);
    stream = null;
    $('wh-preview').srcObject = null;
    for (const pc of pcs.values()) pc.close();
    pcs.clear();
    pending.clear();
    socket?.emit('host-pause');
    stopHealth();
    setState('setup');
    btnStart.textContent = 'Voltar a transmitir';
  }

  // ======== What the room page uses to explain a stutter ========
  let healthTimer = null;
  function startHealth() {
    stopHealth();
    healthTimer = setInterval(async () => {
      if (!live || !socket?.connected || !pcs.size) return;
      let fps = 0, limit = 'none';
      for (const pc of pcs.values()) {
        try {
          for (const r of (await pc.getStats()).values()) {
            if (r.type !== 'outbound-rtp' || r.kind !== 'video') continue;
            fps = Math.max(fps, r.framesPerSecond || 0);
            if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') limit = r.qualityLimitationReason === 'cpu' || r.qualityLimitationReason === 'bandwidth' ? r.qualityLimitationReason : 'other';
          }
        } catch {}
      }
      socket.emit('host-health', { fps, target: quality().fps, limit });
    }, 5000);
  }
  function stopHealth() { clearInterval(healthTimer); healthTimer = null; }

  // ======== Page ========
  function setState(state) {
    document.body.dataset.state = state;
    $('wh-setup').hidden = state === 'live';
    $('wh-live').hidden = state !== 'live';
  }
  const linkFor = () => `${location.origin}/s/${encodeURIComponent(roomId)}`;
  function renderLink() { $('wh-link').value = linkFor(); }

  function renderViewers(count, names) {
    $('wh-count').textContent = `${count} assistindo`;
    const list = names.slice(0, 6);
    $('wh-names').textContent = !count
      ? 'Ninguém assistindo ainda: mande o link.'
      : `Assistindo: ${list.join(', ')}${count > list.length ? ` e mais ${count - list.length}` : ''}`;
    $('wh-crowd').hidden = count < 4;
  }

  const recent = [];
  function addReaction(emoji, name) {
    if (!emoji) return;
    recent.unshift(`${emoji} ${name || 'Sapo'}`);
    recent.length = Math.min(recent.length, 3);
    $('wh-reactions').textContent = recent.join('   ');
    clearTimeout(addReaction.timer);
    addReaction.timer = setTimeout(() => { recent.length = 0; $('wh-reactions').textContent = ''; }, 6000);
  }

  btnStart.addEventListener('click', start);
  $('wh-stop').addEventListener('click', stop);
  $('wh-switch').addEventListener('click', switchSource);
  $('wh-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(linkFor())
      .then(() => showToast('Link copiado. É só mandar para quem quiser assistir.'))
      .catch(() => { $('wh-link').select(); showToast('Copie o link selecionado.'); });
  });
  window.addEventListener('beforeunload', (e) => {
    if (!live) return;
    e.preventDefault();
    e.returnValue = '';
  });
})();
