// Streaming from the site itself (transmitir.html), for people who can't or won't install the app. It works
// like the app wherever a browser allows: the fixed link with a name of its own, who's watching (remove,
// lock), the quick pause, the camera over the picture, group streaming and, from 3 viewers on, one copy to
// the media server instead of one per viewer. The browser's own picker chooses what to show; the room page
// works unchanged. The picture goes through a worker (web-pipe-worker.js) where the browser has the APIs
// for it (Chrome, Edge): hardware encoding, the size cap, the camera and the "já volto" card.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    getJson(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    setJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const ROOM_KEY = 'fs-web-room';
  const OWNED_KEY = 'fs-web-owned-rooms';
  const NAME_KEY = 'fs-web-name';
  const GAME_KEY = 'fs-web-game';
  const QUALITY_KEY = 'fs-web-quality';
  const AUDIO_KEY = 'fs-web-audio';
  const CAM_KEY = 'fs-web-cam';
  const KICK_TIME_KEY = 'fs-kick-minutes';
  const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  let roomId = null, hostKey = null;
  function reportError(message, context) {
    try {
      fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ source: 'web-host', level: 'error', message: String(message).slice(0, 2000), context: context || null, room_id: roomId, app_version: 'web', user_agent: navigator.userAgent })
      }).catch(() => {});
    } catch {}
  }

  function showToast(msg) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ======== What this browser can do ========
  // Desktop Chrome, Edge, Firefox and Safari can share a screen; phones can't
  const supported = !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const canPipe = typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function'
    && typeof OffscreenCanvas === 'function' && typeof VideoFrame === 'function' && typeof Worker === 'function';
  const btnStart = $('wh-start');
  if (!supported) {
    $('wh-unsupported').hidden = false;
    btnStart.disabled = true;
  }

  // ======== Group: streaming into a friend's room (?grupo=<room>) ========
  const groupRoom = (() => {
    const id = new URLSearchParams(location.search).get('grupo');
    return id && ROOM_ID_RE.test(id) ? id : null;
  })();
  const group = { ownerName: '', enabled: false, hosts: [] };
  if (groupRoom) {
    document.body.classList.add('wh-guest');
    document.title = 'Transmitir no grupo · FrogShare';
    $('wh-title').textContent = 'Transmitir no grupo';
    $('wh-sub').textContent = 'Sua tela entra na sala do seu amigo, ao lado da dele. Escolha o que mostrar e pronto.';
    $('wh-stop-label').textContent = 'Sair do grupo';
  }

  // ======== Preferences ========
  const nameInput = $('wh-name');
  const gameInput = $('wh-game');
  nameInput.value = storage.get(NAME_KEY) || '';
  gameInput.value = storage.get(GAME_KEY) || '';
  $('wh-audio').checked = storage.get(AUDIO_KEY) !== '0';
  const displayName = () => nameInput.value.trim().slice(0, 24) || 'Amigo';
  const gameName = () => gameInput.value.trim().slice(0, 40) || null;

  // ======== Quality ========
  // 60 fps where the picture reaches the hardware encoder; elsewhere the browser encodes on the CPU
  const quality = { res: '1080', fps: canPipe ? 60 : 30 };
  (() => {
    const raw = storage.get(QUALITY_KEY);
    let q = null;
    try { q = JSON.parse(raw); } catch {}
    // Before 1.8 it was "1080-30"
    if ((!q || typeof q !== 'object') && /^\d+-\d+$/.test(raw || '')) { const [res, fps] = raw.split('-'); q = { res, fps: Number(fps) }; }
    if (q && ['720', '1080', 'native'].includes(String(q.res))) quality.res = String(q.res);
    if (q && [30, 60].includes(Number(q.fps))) quality.fps = Number(q.fps);
  })();
  const BOX = { 720: [1280, 720], 1080: [1920, 1080] };
  // The fps in use: the preset's, or 30 while the PC can't keep up with 60 (see "Load")
  const autoFps = { active: false, overTicks: 0, retryAt: 0, backoffMs: 3 * 60000, lastOffAt: 0 };
  const effFps = () => (autoFps.active ? Math.min(30, quality.fps) : quality.fps);
  const workerQuality = () => ({ ...quality, fps: effFps() });
  // Fits a 16:9 box whatever the shape: an ultrawide 2560x1080 goes as 1920x810, not 2560x1080
  function targetSize(w, h) {
    const box = BOX[quality.res];
    if (!box || !w || !h) return { w, h };
    const s = Math.min(1, box[0] / w, box[1] / h);
    if (s >= 1) return { w, h };
    return { w: Math.round(w * s / 2) * 2, h: Math.round(h * s / 2) * 2 };
  }
  const pipeInfo = { inFrames: 0, outFrames: 0, srcW: 0, srcH: 0, outW: 0, outH: 0 };
  function sourceSize() {
    if (pipeInfo.srcW) return [pipeInfo.srcW, pipeInfo.srcH];
    const s = current?.raw?.getSettings?.() || {};
    if (s.width && s.height) return [s.width, s.height];
    return [Math.round(screen.width * devicePixelRatio), Math.round(screen.height * devicePixelRatio)];
  }
  // Bits per pixel for fast-moving content, as in the app: 0.1 at 60 fps, 0.13 at 30 (more per frame)
  function presetBitrate() {
    const [sw, sh] = sourceSize();
    const { w, h } = targetSize(sw, sh);
    const fps = effFps();
    return Math.round(Math.min(20e6, Math.max(2e6, w * h * fps * (fps > 30 ? 0.1 : 0.13))));
  }
  const outHeight = () => pipeInfo.outH || targetSize(...sourceSize()).h || 1080;
  function videoConstraints() {
    const box = BOX[quality.res];
    return {
      ...(box ? { width: { max: box[0] }, height: { max: box[1] } } : {}),
      frameRate: { ideal: effFps(), max: effFps() },
      // As in the app: a fullscreen game shows only its own crosshair (where the browser supports it)
      cursor: 'never'
    };
  }
  function renderQuality() {
    document.querySelectorAll('input[name="wh-res"]').forEach(r => { r.checked = r.value === quality.res; });
    document.querySelectorAll('input[name="wh-fps"]').forEach(r => { r.checked = Number(r.value) === quality.fps; });
    $('wh-quality-hint').textContent = autoFps.active
      ? 'Em 30 fps por enquanto: o PC está ocupado e assim a imagem fica estável. Volta a 60 sozinho.'
      : `até ~${Math.round(presetBitrate() / 1e6)} Mbps de upload por pessoa assistindo`;
  }
  document.querySelectorAll('input[name="wh-res"], input[name="wh-fps"]').forEach(input => {
    input.addEventListener('change', async () => {
      if (input.name === 'wh-res') quality.res = input.value;
      else quality.fps = Number(input.value);
      storage.set(QUALITY_KEY, JSON.stringify(quality));
      // A choice made by hand starts over at the preset
      if (input.name === 'wh-fps') Object.assign(autoFps, { active: false, overTicks: 0, backoffMs: 3 * 60000 });
      pipe?.worker.postMessage({ quality: workerQuality() });
      if (current?.raw) await current.raw.applyConstraints(videoConstraints()).catch(() => {});
      renderQuality();
      applyAllSenders();
    });
  });

  // ======== State ========
  let socket = null, live = false, starting = false, rejectedOnce = false;
  // What's captured now: the browser's track, its sound (or a silent one) and what goes out
  let current = null;
  let stream = null;          // what goes out: picture + sound
  const pcs = new Map();      // viewerId -> RTCPeerConnection (direct)
  const pending = new Map();  // viewerId -> token of the offer being prepared (a 'viewer-left' cancels it)
  const low = new Set();      // viewers who asked for "Economizar dados"
  const watchOff = new Set(); // group rooms: viewers watching someone else (they get our sound, not our picture)
  let seq = 0, iceConfig = null, roomViewerCount = 0;

  async function getIce() {
    if (iceConfig) return iceConfig;
    try {
      iceConfig = { iceServers: (await (await fetch('/api/ice-servers')).json()).iceServers };
    } catch {
      iceConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
    }
    return iceConfig;
  }

  // ======== The picture's path (Chrome, Edge) ========
  // One generator and one worker for the whole stream: switching what's shown only hands the worker a new
  // capture, so the picture friends get is the same track throughout (no renegotiation, camera and card kept)
  let pipe = null;
  function makePipe() {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    generator.contentHint = 'motion';
    const writer = generator.writable.getWriter();
    const worker = new Worker('/js/web-pipe-worker.js');
    const p = { generator, writer, worker, inFlight: 0, camClones: [], dead: false };
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.frame) {
        // Never a queue: when the encoder's side is behind, this frame goes and the next is fresher. Messages
        // aren't held back in a background tab the way timers are, so nothing here waits on a timer.
        if (p.dead || p.inFlight >= 2) { m.frame.close(); return; }
        p.inFlight++;
        writer.write(m.frame).catch(() => {}).finally(() => { p.inFlight--; });
        return;
      }
      if (m.stats) Object.assign(pipeInfo, m.stats);
      if ('camRect' in m) placeCamHandle(m.camRect);
      if (m.error) reportError('Pipeline read failed: ' + m.error);
    };
    worker.onerror = (e) => reportError('Pipeline worker error: ' + (e.message || 'unknown'));
    worker.postMessage({ quality: workerQuality(), camLayout: camLayout() });
    return p;
  }
  function feedPipe(raw) {
    const processor = new MediaStreamTrackProcessor({ track: raw, maxBufferSize: 2 });
    const s = raw.getSettings();
    pipe.worker.postMessage({ readable: processor.readable, width: s.width, height: s.height }, [processor.readable]);
  }
  function closePipe() {
    if (!pipe) return;
    pipe.dead = true;
    pipe.worker.terminate();
    for (const t of pipe.camClones) t.stop();
    pipe.writer.close().catch(() => {});
    pipe.generator.stop();
    pipe = null;
    Object.assign(pipeInfo, { inFrames: 0, outFrames: 0, drawMs: 0, srcW: 0, srcH: 0, outW: 0, outH: 0 });
    placeCamHandle(null);
  }

  // The picture that goes out right now
  function outVideo() {
    if (pipe) return pipe.generator;
    if (privacy.away) return cardTrack();
    return current?.raw || null;
  }
  function renderPreview() {
    const v = outVideo();
    const preview = $('wh-preview');
    if (preview.srcObject?.getVideoTracks()[0] !== v) preview.srcObject = v ? new MediaStream([v]) : null;
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
    const media = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints(),
      audio: $('wh-audio').checked ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include'
    });
    const raw = media.getVideoTracks()[0];
    raw.contentHint = 'motion';
    // Every stream carries a sound channel (silent if needed), so switching later never renegotiates
    const audio = media.getAudioTracks()[0] || silentTrack();
    // "Parar de compartilhar" in the browser's own bar
    raw.addEventListener('ended', () => { if (live && current?.raw === raw) stop(); });
    return { raw, audio };
  }
  function release(c) {
    if (!c) return;
    c.raw.stop();
    if (c.audio !== silent?.track) c.audio.stop();
  }

  // ======== Sending ========
  function senderParams(viewerId) {
    const isSfu = viewerId === 'sfu';
    const isLow = !isSfu && low.has(viewerId);
    const h = outHeight();
    return {
      maxBitrate: isLow ? Math.min(LOW_BPS, presetBitrate()) : presetBitrate(),
      maxFramerate: isLow ? Math.min(30, effFps()) : effFps(),
      scaleResolutionDownBy: isLow && h > 540 ? +(h / 540).toFixed(3) : 1,
      active: isSfu || !watchOff.has(viewerId)
    };
  }
  const LOW_BPS = 1200000;
  async function applySender(pc, viewerId) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const want = senderParams(viewerId);
    const e = params.encodings[0];
    if (e.maxBitrate === want.maxBitrate && e.maxFramerate === want.maxFramerate && (e.scaleResolutionDownBy || 1) === want.scaleResolutionDownBy && e.active === want.active) return;
    Object.assign(e, want, { networkPriority: 'high', priority: 'high' });
    // maintain-framerate collapses resolution under bandwidth pressure, which is what makes it look blocky
    params.degradationPreference = 'balanced';
    try { await sender.setParameters(params); } catch {}
  }
  function applyAllSenders() {
    for (const [id, pc] of pcs) applySender(pc, id);
    if (sfu.pc) applySender(sfu.pc, 'sfu');
  }
  // Every connection that carries our picture, the media server's included while it's still connecting
  function sendingPcs() {
    const s = sfu.pc || sfu.startingPc;
    return s ? [...pcs.values(), s] : [...pcs.values()];
  }
  async function replaceOnAll(kind, track) {
    for (const pc of sendingPcs()) {
      const sender = pc.getSenders().find(s => s.track?.kind === kind);
      if (sender && sender.track !== track) await sender.replaceTrack(track).catch(() => {});
    }
  }

  // H264 first, Main before the others: the profile Chromium sends to the GPU encoder (Media Foundation,
  // NVENC, VideoToolbox); VP8, the browsers' default, is encoded on the CPU, which competes with the game
  const h264Rank = (c) => {
    if (!/h264/i.test(c.mimeType)) return /rtx|red|ulpfec|flexfec/i.test(c.mimeType) ? 9 : 5;
    const p = (/profile-level-id=([0-9a-f]{2})/i.exec(c.sdpFmtpLine || '') || [])[1];
    return p === '4d' ? 0 : p === '64' ? 1 : 2;
  };
  function preferH264(pc) {
    const tr = pc.getTransceivers().find(t => t.sender.track?.kind === 'video');
    if (!tr?.setCodecPreferences) return false;
    for (const caps of [RTCRtpSender.getCapabilities?.('video'), RTCRtpReceiver.getCapabilities?.('video')]) {
      if (!caps?.codecs?.length) continue;
      try { tr.setCodecPreferences(caps.codecs.slice().sort((a, b) => h264Rank(a) - h264Rank(b))); return true; } catch {}
    }
    return false;
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
      if (video.has(m[1]) && !m[2].includes('x-google-start-bitrate')) return l + ';x-google-start-bitrate=3000;x-google-max-bitrate=20000';
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
    const video = outVideo();
    if (!live || !stream || !video || pcs.has(viewerId)) return;
    const pc = new RTCPeerConnection(config);
    pc.sid = ++seq;
    pc.pendingIce = [];
    pc.createdAt = performance.now();
    pcs.set(viewerId, pc);
    pc.addTrack(video, stream);
    pc.addTrack(current.audio, stream);
    preferH264(pc);
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('ice-candidate', { to: viewerId, candidate: e.candidate, sid: pc.sid }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return;
      if (pcs.get(viewerId) === pc) pcs.delete(viewerId);
      if (pc.connectionState === 'failed') pc.close();
    };
    try {
      await applySender(pc, viewerId);
      await pc.setLocalDescription(await pc.createOffer());
      if (pcs.get(viewerId) !== pc) return;
      socket.emit('offer', { to: viewerId, offer: pc.localDescription, sid: pc.sid });
    } catch (err) {
      pc.close();
      if (pcs.get(viewerId) === pc) pcs.delete(viewerId);
      reportError('Offer failed: ' + err.message);
    }
  }

  // ======== Media server (Cloudflare) from 3 viewers on ========
  // Direct, every viewer costs one encode and one copy of the upload. From 3 on, publish once and let the
  // server fan it out; with 1-2 stay direct, which is free and has the lowest latency. As in the app.
  const SFU_MIN_VIEWERS = 3;
  const sfu = {
    active: false, starting: false, pc: null, startingPc: null, sessionId: null, tracks: [],
    cooldownUntil: 0, lowSince: 0, enabled: false, checkedAt: 0, plainProfile: false, silentFailures: 0, healedAt: 0,
    decodeFails: new Set()
  };
  // One viewer whose decoder can't take the "Main" picture gets a direct link; a second one on the same
  // link means it isn't a one-off: publish again as plain baseline, which every decoder takes (as in the app)
  function noteSfuDecodeFailure(viewerId, reason) {
    if (reason !== 'decode' || !sfu.active || sfu.plainProfile) return;
    sfu.decodeFails.add(viewerId);
    if (sfu.decodeFails.size < 2) return;
    reportError('SFU picture not decoding for 2 viewers, republishing as baseline', { viewers: roomViewerCount });
    sfu.plainProfile = true;
    sfu.cooldownUntil = Date.now() + 20000;
    stopSfu();
  }
  async function sfuFetch(method, path, body) {
    const res = await fetch(`/api/sfu${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.errorCode) throw new Error(data.errorDescription || data.errorCode || `SFU HTTP ${res.status}`);
    return data;
  }
  async function refreshSfuEnabled() {
    if (Date.now() - sfu.checkedAt < 60000) return sfu.enabled;
    sfu.checkedAt = Date.now();
    try { sfu.enabled = (await (await fetch('/api/sfu/status')).json()).enabled === true; } catch { sfu.enabled = false; }
    return sfu.enabled;
  }
  function waitConnected(pc, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SFU connection timeout')), ms);
      const check = () => {
        if (pc.connectionState === 'connected') { clearTimeout(timer); resolve(); }
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { clearTimeout(timer); reject(new Error('SFU connection ' + pc.connectionState)); }
      };
      pc.addEventListener('connectionstatechange', check);
      check();
    });
  }
  // The media server only negotiates H264 constrained baseline, which Chromium encodes on the CPU. It
  // forwards RTP untouched and decoders read the profile from the stream, so telling our encoder "Main"
  // keeps it on the GPU, where Main is hardware and baseline isn't (as in the app)
  async function hardwareProfileSdp(sdp) {
    if (/profile-level-id=4d/i.test(sdp) || !navigator.mediaCapabilities?.encodingInfo) return sdp;
    const hardware = async (profile) => (await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: { contentType: `video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`, width: 1920, height: 1080, bitrate: 8e6, framerate: 60 }
    })).powerEfficient;
    try {
      if (await hardware('42e01f') || !(await hardware('4d001f'))) return sdp;
    } catch {
      return sdp;
    }
    return sdp.replace(/profile-level-id=42e01f/gi, 'profile-level-id=4d001f');
  }
  async function startSfu() {
    if (sfu.active || sfu.starting || !live || !stream) return;
    sfu.starting = true;
    let pc;
    try {
      const { sessionId } = await sfuFetch('POST', '/sessions');
      const config = await getIce();
      pc = new RTCPeerConnection({ ...config, bundlePolicy: 'max-bundle' });
      pc.createdAt = performance.now();
      sfu.startingPc = pc;
      const published = [outVideo(), current.audio].map(track => ({ transceiver: pc.addTransceiver(track, { direction: 'sendonly' }), trackName: track.kind }));
      preferH264(pc);
      await applySender(pc, 'sfu');
      await pc.setLocalDescription(await pc.createOffer());
      const data = await sfuFetch('POST', `/sessions/${sessionId}/tracks`, {
        sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
        tracks: published.map(p => ({ location: 'local', mid: p.transceiver.mid, trackName: p.trackName }))
      });
      const failed = (data.tracks || []).find(t => t.errorCode);
      if (failed) throw new Error(failed.errorDescription || failed.errorCode);
      const answer = sfu.plainProfile ? data.sessionDescription.sdp : await hardwareProfileSdp(data.sessionDescription.sdp);
      // Viewers whose decoder can't take "Main" go straight to a direct link when they know
      sfu.main = answer !== data.sessionDescription.sdp;
      await pc.setRemoteDescription({ type: 'answer', sdp: tuneAnswer(answer) });
      await waitConnected(pc, 10000);
      if (!live || !stream) throw new Error('stream stopped during SFU start');
      sfu.pc = pc;
      sfu.sessionId = sessionId;
      sfu.tracks = published.map(p => p.trackName);
      sfu.active = true;
      sfu.lowSince = 0;
      sfu.healedAt = 0;
      sfu.decodeFails.clear();
      // And what's on air right now, in case it changed while the link was connecting
      for (const p of published) {
        const now = p.trackName === 'video' ? outVideo() : current?.audio;
        if (now && p.transceiver.sender.track !== now) await p.transceiver.sender.replaceTrack(now).catch(() => {});
      }
      pc.addEventListener('connectionstatechange', () => {
        if (sfu.pc === pc && pc.connectionState === 'failed') {
          reportError('SFU connection failed', { sessionId });
          sfu.cooldownUntil = Date.now() + 300000;
          stopSfu();
        }
      });
      socket.emit('sfu-start', { sessionId, tracks: sfu.tracks, main: sfu.main });
      // Viewers swap over on their own once the new picture decodes there; drop the direct links they no
      // longer use (one that fell back keeps its link or gets a fresh entry, which the identity check
      // spares). 15 s: a viewer checks the decoding for up to 6 s before giving up on the swap.
      const previous = [...pcs];
      setTimeout(() => {
        for (const [id, old] of previous) {
          if (sfu.active && !old.keepDirect && pcs.get(id) === old) { old.close(); pcs.delete(id); }
        }
      }, 15000);
      renderFacts();
    } catch (err) {
      if (pc) pc.close();
      sfu.cooldownUntil = Date.now() + 300000;
      reportError('SFU start failed: ' + err.message, { viewers: roomViewerCount });
    } finally {
      sfu.starting = false;
      sfu.startingPc = null;
    }
  }
  // Viewers answer 'sfu-stop' by asking again, which brings back one direct offer each
  function stopSfu(notify = true) {
    const pc = sfu.pc;
    if (!pc && !sfu.active) return;
    Object.assign(sfu, { active: false, pc: null, sessionId: null, tracks: [], lowSince: 0, healedAt: 0 });
    if (notify && socket) socket.emit('sfu-stop');
    if (pc) pc.close();
    renderFacts();
  }
  async function updateSfuMode() {
    if (!live || !stream) return;
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
  // A link that hasn't encoded a single frame after 10 s gets the picture put on it again; still nothing
  // 10 s later, it's dropped (viewers go direct) and the next one goes as plain baseline (as in the app)
  async function watchSfuSilence(samples) {
    const s = samples.find(x => x.sfu);
    if (!s || !sfu.pc || s.framesEncoded > 0 || s.ageMs < 10000) return;
    const sender = sfu.pc.getSenders().find(x => x.track?.kind === 'video');
    if (!sfu.healedAt) {
      sfu.healedAt = Date.now();
      reportError('SFU link sends no video, putting the picture on it again', { plain: sfu.plainProfile, piped: !!pipe });
      const v = outVideo();
      if (sender && v) await sender.replaceTrack(v).catch(() => {});
      return;
    }
    if (Date.now() - sfu.healedAt < 10000) return;
    sfu.silentFailures++;
    reportError('SFU link still sends no video, dropping it', { failures: sfu.silentFailures, plain: sfu.plainProfile });
    sfu.plainProfile = true;
    sfu.cooldownUntil = Date.now() + (sfu.silentFailures >= 2 ? 6 * 3600000 : 60000);
    stopSfu();
  }

  // ======== Room: the same one every time in this browser, so the link never changes ========
  function savedRoom() {
    const r = storage.getJson(ROOM_KEY);
    return r && ROOM_ID_RE.test(r.roomId || '') && typeof r.hostKey === 'string' ? r : null;
  }
  function keepRoom(r) {
    storage.setJson(ROOM_KEY, { roomId: r.roomId, hostKey: r.hostKey });
    // The keys of rooms used before, so a name you had can be taken back
    const owned = storage.getJson(OWNED_KEY) || {};
    delete owned[r.roomId];
    owned[r.roomId] = r.hostKey;
    storage.setJson(OWNED_KEY, Object.fromEntries(Object.entries(owned).slice(-10)));
  }
  async function newRoom() {
    const res = await fetch('/api/room/create');
    if (!res.ok) throw new Error('o servidor respondeu ' + res.status);
    const r = await res.json();
    keepRoom(r);
    return r;
  }
  let roomPromise = null;
  function fixedRoom() {
    const r = savedRoom();
    if (r) return Promise.resolve(r);
    roomPromise = roomPromise || newRoom().finally(() => { roomPromise = null; });
    return roomPromise;
  }
  const linkFor = (id) => `${location.origin}/s/${encodeURIComponent(id)}`;

  function joinRoom() {
    if (groupRoom) {
      // In a group there's a place only while streaming: stopping gives it back (see stop)
      if (live) socket.emit('join-room', { roomId, asHost: true, coHost: true, appVersion: 'web', name: displayName() });
    } else {
      socket.emit('join-room', { roomId, asHost: true, hostKey, appVersion: 'web', name: displayName() });
      // A restarted server forgets the room: bring the group and the lock back with it
      if (group.enabled) socket.emit('group-mode', { enabled: true });
      if (locked) socket.emit('lock-room', { locked: true });
      if (!live) socket.emit('host-pause');
    }
    if (!live) return;
    // The server forgets the media server session when the socket drops
    if (sfu.active) socket.emit('sfu-start', { sessionId: sfu.sessionId, tracks: sfu.tracks, main: sfu.main });
    sendGame();
  }

  // The owner closed the group or took this tab out of it, or it was closed or full from the start
  function leaveGroup(reason) {
    if (live) stop();
    $('wh-group-text').textContent = reason;
    $('wh-group-note').hidden = false;
  }

  async function ensureRoom() {
    if (socket) return;
    if (groupRoom) {
      roomId = groupRoom;
      hostKey = null;
    } else {
      ({ roomId, hostKey } = await fixedRoom());
    }
    socket = io();
    socket.on('connect', joinRoom);
    socket.on('host-rejected', async ({ reason } = {}) => {
      if (groupRoom) { leaveGroup(reason || 'O dono da sala não abriu a transmissão em grupo.'); return; }
      // The saved room went to someone else (a server restart and an unlucky claim): start a new one
      if (rejectedOnce) { showToast(reason || 'O servidor não aceitou a sala.'); return; }
      rejectedOnce = true;
      try {
        ({ roomId, hostKey } = await newRoom());
        renderLink();
        joinRoom();
        showToast('O link da sala mudou. Copie o novo para os seus amigos.');
      } catch (err) { showToast(err.message); }
    });
    socket.on('cohost-accepted', ({ ownerName } = {}) => {
      group.ownerName = String(ownerName || '').slice(0, 24);
      renderGroup();
    });
    socket.on('group-ended', ({ reason } = {}) => leaveGroup(reason || 'A transmissão em grupo acabou.'));
    socket.on('viewer-joined', ({ viewerId } = {}) => {
      // With the media server on, the server points the viewer at it instead
      if (live && stream && viewerId && !sfu.active) offer(viewerId);
    });
    socket.on('viewer-needs-p2p', ({ viewerId, reason } = {}) => {
      if (!live || !stream || !viewerId) return;
      noteSfuDecodeFailure(viewerId, reason);
      // Its direct link from before the switch may still be up: keep it rather than renegotiate
      const existing = pcs.get(viewerId);
      if (existing && existing.connectionState === 'connected') { existing.keepDirect = true; return; }
      offer(viewerId);
    });
    socket.on('viewer-left', ({ viewerId } = {}) => {
      pending.delete(viewerId);
      low.delete(viewerId);
      watchOff.delete(viewerId);
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
      } catch (err) {
        reportError('setRemoteDescription failed: ' + err.message);
      }
    });
    socket.on('ice-candidate', ({ from, candidate, sid } = {}) => {
      const pc = pcs.get(from);
      if (!pc || (sid !== undefined && sid !== pc.sid)) return;
      if (pc.remoteDescription) pc.addIceCandidate(candidate).catch(() => {});
      else pc.pendingIce.push(candidate);
    });
    socket.on('viewer-quality', ({ viewerId, low: isLow } = {}) => {
      if (!viewerId) return;
      if (isLow) low.add(viewerId); else low.delete(viewerId);
      const pc = pcs.get(viewerId);
      if (pc) applySender(pc, viewerId);
    });
    // Group rooms: a viewer watching someone else needs our sound, not our picture
    socket.on('viewer-watch', ({ viewerId, video } = {}) => {
      if (!viewerId) return;
      if (video) watchOff.delete(viewerId); else watchOff.add(viewerId);
      const pc = pcs.get(viewerId);
      if (pc) applySender(pc, viewerId);
    });
    socket.on('viewer-list', ({ viewers, banned } = {}) => {
      viewerList = Array.isArray(viewers) ? viewers : [];
      bannedCount = Number(banned) || 0;
      renderViewers();
    });
    socket.on('room-update', ({ viewerCount = 0, hosts, group: groupOn, locked: isLocked } = {}) => {
      roomViewerCount = viewerCount;
      group.hosts = Array.isArray(hosts) ? hosts : [];
      if (!groupRoom) {
        group.enabled = !!groupOn;
        if (typeof isLocked === 'boolean') locked = isLocked;
      }
      renderCount();
      renderGroup();
      renderViewers();
      updateSfuMode();
    });
    socket.on('reaction', ({ emoji, hostId } = {}) => {
      if (hostId && hostId !== socket.id) return;
      if (!emoji) return;
      reactionCounts.set(emoji, (reactionCounts.get(emoji) || 0) + 1);
      renderReactions();
    });
  }

  // ======== The link card (before going live) ========
  const linkText = $('wh-link-text');
  const linkForm = $('wh-link-form');
  const btnEditLink = $('wh-edit-link');
  function renderLink() {
    const id = groupRoom || roomId || savedRoom()?.roomId;
    const link = id ? linkFor(id) : '';
    linkText.textContent = link ? link.replace(/^https?:\/\//, '') : 'Não deu para preparar o link. Ele aparece quando você começar.';
    $('wh-copy-fixed').disabled = !link;
    $('wh-link').value = link;
    $('wh-link-prefix').textContent = location.host + '/s/';
  }
  function copyLink() {
    const id = groupRoom || roomId || savedRoom()?.roomId;
    if (!id) return;
    navigator.clipboard.writeText(linkFor(id))
      .then(() => showToast('Link copiado. É só mandar para quem quiser assistir.'))
      .catch(() => { $('wh-link').select(); showToast('Copie o link selecionado.'); });
  }
  $('wh-copy-fixed').addEventListener('click', copyLink);
  $('wh-copy').addEventListener('click', copyLink);
  btnEditLink.addEventListener('click', () => {
    const open = linkForm.hidden;
    linkForm.hidden = !open;
    btnEditLink.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const now = savedRoom()?.roomId || '';
    $('wh-link-name').value = /^[0-9a-f]{8}$/.test(now) ? '' : now;
    $('wh-link-name').focus();
  });
  // A new room while not live: drop the old connection so the next start joins the new one
  function moveToRoom(r) {
    keepRoom(r);
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
    roomId = r.roomId;
    hostKey = r.hostKey;
    locked = false;
    linkForm.hidden = true;
    btnEditLink.setAttribute('aria-expanded', 'false');
    renderLink();
  }
  linkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (live) { showToast('Pare a transmissão para mudar o link.'); return; }
    const name = $('wh-link-name').value.trim().toLowerCase();
    if (!name) { $('wh-link-name').focus(); return; }
    try {
      const owned = storage.getJson(OWNED_KEY) || {};
      const res = await fetch('/api/room/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, hostKey: owned[name] || undefined })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || 'Não deu para usar esse nome.'); $('wh-link-name').focus(); return; }
      moveToRoom(data);
      showToast('Pronto! Seu link agora é ' + linkFor(data.roomId).replace(/^https?:\/\//, ''));
    } catch (err) {
      showToast('Não deu para mudar o link: ' + err.message);
    }
  });
  $('wh-random-link').addEventListener('click', async () => {
    if (live) { showToast('Pare a transmissão para mudar o link.'); return; }
    try {
      moveToRoom(await newRoom());
      showToast('Link novo pronto. O antigo não leva mais à sua sala.');
    } catch (err) {
      showToast('Não deu para gerar outro link: ' + err.message);
    }
  });

  // ======== Who's watching ========
  let viewerList = [], bannedCount = 0, locked = false;
  let kickConfirm = { id: null, until: 0 };
  const kickTime = $('wh-kick-time');
  const savedKick = storage.get(KICK_TIME_KEY);
  if (savedKick && [...kickTime.options].some(o => o.value === savedKick)) kickTime.value = savedKick;
  kickTime.addEventListener('change', () => storage.set(KICK_TIME_KEY, kickTime.value));
  $('wh-clear-bans').addEventListener('click', () => {
    socket?.emit('clear-bans');
    showToast('Pronto: quem você expulsou já pode voltar.');
  });
  $('wh-lock').addEventListener('change', () => {
    locked = $('wh-lock').checked;
    socket?.emit('lock-room', { locked });
    showToast(locked ? 'Sala trancada: quem já está continua, ninguém novo entra.' : 'Sala aberta de novo.');
  });
  function renderCount() {
    $('wh-watchers-num').textContent = String(roomViewerCount);
    $('wh-count').textContent = `${roomViewerCount} assistindo`;
    $('wh-empty').hidden = roomViewerCount > 0;
  }
  function renderViewers() {
    const owner = !groupRoom;
    $('wh-lock').checked = locked;
    $('wh-kick-row').hidden = !owner || !viewerList.length;
    const undo = $('wh-clear-bans');
    undo.hidden = !owner || !bannedCount;
    undo.textContent = bannedCount > 1 ? `Deixar voltar as ${bannedCount} pessoas que eu expulsei` : 'Deixar voltar quem eu expulsei';
    const shown = viewerList.slice(0, 30);
    const items = shown.map(v => {
      const li = document.createElement('li');
      li.append(Object.assign(document.createElement('span'), { className: 'viewer-name', textContent: v.name, title: v.name }));
      // Only the room's owner removes people; two clicks, so a slip of the mouse doesn't. The pending
      // confirmation survives the list being redrawn (someone arriving or leaving in between).
      if (owner) {
        const confirming = kickConfirm.id === v.id && Date.now() < kickConfirm.until;
        const kick = Object.assign(document.createElement('button'), {
          type: 'button', className: 'btn btn-ghost viewer-kick' + (confirming ? ' confirm' : ''),
          textContent: confirming ? 'Expulsar mesmo?' : 'Expulsar', title: `Expulsar ${v.name} da sala`
        });
        kick.addEventListener('click', () => {
          if (!(kickConfirm.id === v.id && Date.now() < kickConfirm.until)) {
            kickConfirm = { id: v.id, until: Date.now() + 3500 };
            renderViewers();
            setTimeout(() => { if (kickConfirm.id === v.id && Date.now() >= kickConfirm.until) renderViewers(); }, 3600);
            return;
          }
          kickConfirm = { id: null, until: 0 };
          socket?.emit('kick-viewer', { viewerId: v.id, minutes: Number(kickTime.value) });
          showToast(`${v.name} foi expulso da sala e fica fora por ${kickTime.selectedOptions[0].textContent}. Para ninguém novo entrar, tranque a sala.`);
        });
        li.append(kick);
      }
      return li;
    });
    if (viewerList.length > shown.length) items.push(Object.assign(document.createElement('li'), { className: 'viewer-more', textContent: `e mais ${viewerList.length - shown.length}` }));
    $('wh-viewer-list').replaceChildren(...items);
  }

  // ======== Reactions ========
  const reactionCounts = new Map();
  function renderReactions() {
    const el = $('wh-reactions');
    el.hidden = !reactionCounts.size;
    el.replaceChildren(...[...reactionCounts].sort((a, b) => b[1] - a[1]).map(([emoji, n]) => {
      const s = document.createElement('span');
      s.title = `${n}× ${emoji}`;
      s.append(emoji, Object.assign(document.createElement('small'), { textContent: String(n) }));
      return s;
    }));
  }

  // ======== Group ========
  const frogIcon = (name) => /^big\s*frog$/i.test(String(name || '').trim()) ? '/brand/frog-head-big.svg' : '/brand/frog-head.svg';
  function setGroupEnabled(enabled) {
    group.enabled = enabled;
    // Without a room yet, joining it turns the group on (see joinRoom)
    if (socket && !groupRoom) socket.emit('group-mode', { enabled });
    renderGroup();
  }
  $('wh-group-setup').addEventListener('change', (e) => setGroupEnabled(e.target.checked));
  $('wh-group-live').addEventListener('change', (e) => setGroupEnabled(e.target.checked));
  function renderGroup() {
    $('wh-group-setup').checked = group.enabled;
    $('wh-group-live').checked = group.enabled;
    const me = socket?.id;
    const inGroup = !!groupRoom || (group.enabled && group.hosts.length > 1);
    $('wh-chip-group').hidden = !inGroup;
    $('wh-chip-frog').src = frogIcon(displayName());
    $('wh-chip-group-text').textContent = groupRoom ? `Em grupo${group.ownerName ? ' com ' + group.ownerName : ''}` : `${group.hosts.length} transmitindo em grupo`;
    const showList = !!groupRoom || group.enabled;
    const items = !showList ? [] : group.hosts.slice().sort((a, b) => a.slot - b.slot).map(h => {
      const li = document.createElement('li');
      li.className = `slot-${h.slot}`;
      li.append(Object.assign(document.createElement('img'), { className: 'group-frog', src: frogIcon(h.name), alt: '' }));
      li.append(Object.assign(document.createElement('span'), { className: 'group-name', textContent: h.name }));
      for (const t of [h.id === me ? 'você' : '', h.owner ? 'dono' : '', h.paused ? 'pausado' : ''].filter(Boolean)) {
        li.append(Object.assign(document.createElement('span'), { className: 'group-tag', textContent: t }));
      }
      if (!groupRoom && !h.owner) {
        const kick = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-ghost btn-icon', title: `Tirar ${h.name} do grupo` });
        kick.setAttribute('aria-label', kick.title);
        kick.innerHTML = '<svg class="ico" aria-hidden="true"><use href="/brand/icons.svg#i-x"/></svg>';
        kick.addEventListener('click', () => socket?.emit('kick-host', { hostId: h.id }));
        li.append(kick);
      }
      return li;
    });
    $('wh-group-list').replaceChildren(...items);
    $('wh-link-fine').textContent = groupRoom
      ? `${group.ownerName ? `No grupo de ${group.ownerName}. ` : ''}Quem abrir o link vê todo mundo do grupo. Deixe esta aba aberta: fechando, você sai do grupo.`
      : group.enabled
        ? (group.hosts.length >= 4 ? 'O grupo está cheio (4 pessoas).' : 'Quem estiver assistindo pode clicar em "Compartilhar a tela" na sala para transmitir junto.')
        : '';
  }

  // ======== The game or whatever is on screen, for viewers ========
  function sendGame() {
    if (socket?.connected && live) socket.emit('set-game', { game: gameName() });
  }
  let gameTimer = null;
  gameInput.addEventListener('input', () => {
    storage.set(GAME_KEY, gameInput.value.trim());
    clearTimeout(gameTimer);
    gameTimer = setTimeout(sendGame, 800);
  });
  nameInput.addEventListener('change', () => {
    storage.set(NAME_KEY, nameInput.value.trim());
    if (live) socket?.emit('set-name', { name: displayName() });
    renderGroup();
  });

  // ======== Privacy: the quick pause ========
  // A "já volto" card instead of the picture. With the worker it is drawn there, from the next frame on;
  // elsewhere a small canvas track takes the picture's place on every link.
  const privacy = { away: false, card: null, cardTimer: null };
  const cardFrog = new Image();
  cardFrog.src = '/brand/frog-sleep.svg';
  function drawAwayCard(c) {
    const g = c.getContext('2d');
    g.fillStyle = '#0B1A10';
    g.fillRect(0, 0, 1280, 720);
    if (cardFrog.complete && cardFrog.naturalWidth) g.drawImage(cardFrog, 560, 160, 160, 147);
    g.textAlign = 'center';
    g.fillStyle = '#F3F8EC';
    g.font = '600 46px Fredoka, sans-serif';
    const who = nameInput.value.trim();
    g.fillText(who ? `${who} já volta` : 'Já volto!', 640, 400);
    g.fillStyle = '#A9C6AC';
    g.font = '28px Inter, sans-serif';
    g.fillText('A transmissão continua sozinha em instantes.', 640, 452);
  }
  function awayCanvas() {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    drawAwayCard(c);
    return c;
  }
  function cardTrack() {
    if (!privacy.card) {
      const c = awayCanvas();
      privacy.card = c.captureStream(2).getVideoTracks()[0];
      // A canvas sends only when drawn: draw it now and then, so whoever arrives gets it
      privacy.cardTimer = setInterval(() => drawAwayCard(c), 1000);
    }
    return privacy.card;
  }
  function dropCardTrack() {
    clearInterval(privacy.cardTimer);
    privacy.cardTimer = null;
    if (privacy.card) { privacy.card.stop(); privacy.card = null; }
  }
  async function sendAwayToPipe() {
    if (!pipe) return;
    if (privacy.away) {
      try {
        const bitmap = await createImageBitmap(awayCanvas());
        pipe.worker.postMessage({ card: bitmap, away: true }, [bitmap]);
        return;
      } catch {}
    }
    pipe.worker.postMessage({ away: privacy.away });
  }
  async function setAway(on) {
    if (!live || privacy.away === on) return;
    privacy.away = on;
    if (pipe) {
      await sendAwayToPipe();
    } else {
      await replaceOnAll('video', outVideo());
      if (!on) dropCardTrack();
      renderPreview();
    }
    renderPause();
    // Viewers hear about it at once: a still card mustn't read as a frozen stream
    if (socket?.connected) socket.emit('host-health', { fps: null, target: effFps(), limit: 'none', away: on });
  }
  function renderPause() {
    const btn = $('wh-pause');
    btn.setAttribute('aria-pressed', String(privacy.away));
    $('wh-pause-label').textContent = privacy.away ? 'Voltar a mostrar a tela' : 'Pausa rápida';
  }
  $('wh-pause').addEventListener('click', () => setAway(!privacy.away));

  // ======== Camera over the picture (with the worker only) ========
  const CAM_SIZES = { s: 0.2, m: 0.28, l: 0.38 };
  const CAM_CORNERS = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] };
  const cam = (() => {
    const saved = storage.getJson(CAM_KEY) || {};
    const num = (v, fallback) => Number.isFinite(v) ? v : fallback;
    return { enabled: !!saved.enabled, deviceId: saved.deviceId || '', track: null, x: num(saved.x, 1), y: num(saved.y, 1), w: num(saved.w, CAM_SIZES.m) };
  })();
  const camLayout = () => ({ x: cam.x, y: cam.y, w: cam.w });
  const camNote = $('wh-cam-note');
  function saveCam() { storage.setJson(CAM_KEY, { enabled: cam.enabled, deviceId: cam.deviceId, x: cam.x, y: cam.y, w: cam.w }); }
  function setCamLayout(next, save = true) {
    Object.assign(cam, next);
    cam.x = Math.min(1, Math.max(0, cam.x));
    cam.y = Math.min(1, Math.max(0, cam.y));
    cam.w = Math.min(0.6, Math.max(0.1, cam.w));
    pipe?.worker.postMessage({ camLayout: camLayout() });
    if (save) { saveCam(); renderCam(); }
  }
  function attachCam() {
    if (!pipe || !cam.track || cam.track.readyState !== 'live') return;
    try {
      const clone = cam.track.clone();
      const processor = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 });
      for (const t of pipe.camClones) t.stop();
      pipe.camClones = [clone];
      pipe.worker.postMessage({ cam: processor.readable, camLayout: camLayout() }, [processor.readable]);
    } catch (err) {
      reportError('Camera attach failed: ' + err.message);
    }
  }
  const camConstraints = (deviceId) => ({
    video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    audio: false
  });
  async function openCamera() {
    try {
      return await navigator.mediaDevices.getUserMedia(camConstraints(cam.deviceId));
    } catch (err) {
      // The saved camera was unplugged: any camera will do
      if (cam.deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        cam.deviceId = '';
        return navigator.mediaDevices.getUserMedia(camConstraints(''));
      }
      throw err;
    }
  }
  function camError(err) {
    camNote.textContent = err.name === 'NotAllowedError'
      ? 'O navegador não liberou a câmera. Clique no cadeado ao lado do endereço e permita a câmera.'
      : err.name === 'NotReadableError' ? 'A câmera está sendo usada por outro programa.' : 'Não deu para abrir a câmera: ' + err.message;
  }
  async function startCam() {
    if (cam.track || !pipe) return;
    try {
      const media = await openCamera();
      cam.track = media.getVideoTracks()[0];
      cam.deviceId = cam.track.getSettings().deviceId || cam.deviceId;
      camNote.textContent = '';
      cam.track.addEventListener('ended', () => { if (cam.track?.readyState === 'ended') { cam.track = null; camNote.textContent = 'A câmera foi desligada.'; } });
      if (!live) { stopCam(); return; }
      attachCam();
      loadCamDevices();
    } catch (err) {
      camError(err);
    }
  }
  function stopCam() {
    if (cam.track) { cam.track.stop(); cam.track = null; }
    if (pipe) {
      pipe.worker.postMessage({ cam: null });
      for (const t of pipe.camClones) t.stop();
      pipe.camClones = [];
    }
    placeCamHandle(null);
  }
  async function loadCamDevices() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      $('wh-cam-device').replaceChildren(...devices.map((d, i) => Object.assign(document.createElement('option'), {
        value: d.deviceId, textContent: d.label || `Câmera ${i + 1}`, selected: d.deviceId === cam.deviceId
      })));
      if (!devices.length) camNote.textContent = 'Nenhuma câmera encontrada.';
    } catch {}
  }
  function renderCam() {
    $('wh-cam-toggle').checked = cam.enabled;
    $('wh-cam-options').hidden = !cam.enabled;
    // A shortcut stays lit only while the camera is exactly there (a drag puts it somewhere in between)
    document.querySelectorAll('input[name="wh-cam-pos"]').forEach(r => { r.checked = CAM_CORNERS[r.value][0] === cam.x && CAM_CORNERS[r.value][1] === cam.y; });
    document.querySelectorAll('input[name="wh-cam-size"]').forEach(r => { r.checked = Math.abs(CAM_SIZES[r.value] - cam.w) < 0.005; });
  }
  $('wh-cam-toggle').addEventListener('change', async (e) => {
    cam.enabled = e.target.checked;
    saveCam();
    renderCam();
    if (!cam.enabled) { stopCam(); return; }
    if (live) { await startCam(); return; }
    // Not live yet: open it once, to ask for permission and to learn the cameras' names
    try {
      const media = await openCamera();
      media.getTracks().forEach(t => t.stop());
      camNote.textContent = 'A câmera aparece quando você começar a transmitir.';
      loadCamDevices();
    } catch (err) {
      camError(err);
    }
  });
  $('wh-cam-device').addEventListener('change', (e) => {
    cam.deviceId = e.target.value;
    saveCam();
    if (live && cam.enabled) { stopCam(); startCam(); }
  });
  document.querySelectorAll('input[name="wh-cam-pos"], input[name="wh-cam-size"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.name === 'wh-cam-pos') setCamLayout({ x: CAM_CORNERS[input.value][0], y: CAM_CORNERS[input.value][1] });
      else setCamLayout({ w: CAM_SIZES[input.value] });
    });
  });
  if (canPipe && supported) {
    $('wh-cam-section').hidden = false;
    renderCam();
    if (cam.enabled) loadCamDevices();
  }

  // ---- Moving it on the preview ----
  // A frame over the camera in the preview: drag it anywhere, pull its corner to change the size
  const preview = $('wh-preview');
  const camHandle = $('wh-cam-handle');
  const camDrag = { active: null, startX: 0, startY: 0, start: null, rect: null, box: null, placed: '' };
  // Where the picture sits inside the preview element (object-fit: contain leaves bars on two sides)
  function previewBox() {
    const r = preview.getBoundingClientRect();
    const vw = preview.videoWidth, vh = preview.videoHeight;
    if (!vw || !vh || !r.width || !r.height) return null;
    const s = Math.min(r.width / vw, r.height / vh);
    const w = vw * s, h = vh * s;
    return { left: (r.width - w) / 2, top: (r.height - h) / 2, w, h };
  }
  function placeCamHandle(rect, force = false) {
    camDrag.rect = rect || null;
    if (camDrag.active) return;
    const box = rect && preview.srcObject && previewBox();
    const key = box ? `${rect.join()}|${box.left}|${box.top}|${box.w}` : '';
    if (key === camDrag.placed && !force) return;
    camDrag.placed = key;
    camHandle.hidden = !box;
    if (!box) return;
    camHandle.style.left = `${box.left + rect[0] * box.w}px`;
    camHandle.style.top = `${box.top + rect[1] * box.h}px`;
    camHandle.style.width = `${rect[2] * box.w}px`;
    camHandle.style.height = `${rect[3] * box.h}px`;
  }
  camHandle.addEventListener('pointerdown', (e) => {
    const box = previewBox();
    if (!box || !camDrag.rect || e.button !== 0) return;
    e.preventDefault();
    camHandle.setPointerCapture(e.pointerId);
    camDrag.active = e.target.closest('.cam-resize') ? 'resize' : 'move';
    camDrag.startX = e.clientX;
    camDrag.startY = e.clientY;
    camDrag.start = camDrag.rect.slice();
    camDrag.box = box;
    camHandle.classList.add('dragging');
  });
  camHandle.addEventListener('pointermove', (e) => {
    if (!camDrag.active) return;
    const { box, start } = camDrag;
    const dx = (e.clientX - camDrag.startX) / box.w, dy = (e.clientY - camDrag.startY) / box.h;
    // The margin the worker keeps around the camera, as shares of the picture
    const mx = 0.025 * box.h / box.w, my = 0.025;
    let [x, y, w, h] = start;
    if (camDrag.active === 'resize') {
      // The corner follows the pointer whichever way it goes more, keeping the camera's shape
      const dw = Math.abs(dx) >= Math.abs(dy * w / h) ? dx : dy * w / h;
      const k = Math.max(0.1, Math.min(0.6, w + dw)) / w;
      w *= k; h *= k;
    } else {
      x += dx; y += dy;
    }
    x = Math.min(Math.max(x, mx), Math.max(mx, 1 - mx - w));
    y = Math.min(Math.max(y, my), Math.max(my, 1 - my - h));
    camHandle.style.left = `${box.left + x * box.w}px`;
    camHandle.style.top = `${box.top + y * box.h}px`;
    camHandle.style.width = `${w * box.w}px`;
    camHandle.style.height = `${h * box.h}px`;
    const freeX = 1 - 2 * mx - w, freeY = 1 - 2 * my - h;
    setCamLayout({ w, x: freeX > 0 ? (x - mx) / freeX : 0, y: freeY > 0 ? (y - my) / freeY : 0 }, false);
  });
  function endCamDrag() {
    if (!camDrag.active) return;
    camDrag.active = null;
    camHandle.classList.remove('dragging');
    saveCam();
    renderCam();
  }
  camHandle.addEventListener('pointerup', endCamDrag);
  camHandle.addEventListener('pointercancel', endCamDrag);
  window.addEventListener('resize', () => placeCamHandle(camDrag.rect, true));
  preview.addEventListener('resize', () => placeCamHandle(camDrag.rect, true));

  // ======== Start, switch, stop ========
  async function start() {
    if (!supported || starting || live) return;
    starting = true;
    storage.set(NAME_KEY, nameInput.value.trim());
    storage.set(AUDIO_KEY, $('wh-audio').checked ? '1' : '0');
    btnStart.disabled = true;
    btnStart.textContent = 'Escolhendo a tela…';
    $('wh-group-note').hidden = true;
    let next;
    try {
      next = await capture();
    } catch (err) {
      starting = false;
      btnStart.disabled = false;
      btnStart.textContent = socket ? 'Voltar a transmitir' : 'Escolher a tela e começar';
      if (err.name !== 'NotAllowedError') showToast('Não deu para capturar a tela: ' + err.message);
      return;
    }
    current = next;
    if (canPipe) {
      try {
        pipe = makePipe();
        feedPipe(current.raw);
      } catch (err) {
        reportError('Pipeline start failed: ' + err.message);
        closePipe();
      }
    }
    live = true;
    privacy.away = false;
    stream = new MediaStream([outVideo(), current.audio]);
    renderPreview();
    const resume = !!socket;
    try {
      await ensureRoom();
    } catch (err) {
      showToast('Não deu para abrir a sala: ' + err.message);
      starting = false;
      stop();
      return;
    }
    if (resume && groupRoom) {
      joinRoom();
    } else if (resume) {
      socket.emit('set-name', { name: displayName() });
      socket.emit('host-resume');
      sendGame();
    }
    reactionCounts.clear();
    renderReactions();
    low.clear();
    watchOff.clear();
    Object.assign(autoFps, { active: false, overTicks: 0, backoffMs: 3 * 60000, lastOffAt: 0 });
    loadPipe = { outFrames: pipeInfo.outFrames, at: 0 };
    lastReport = { inFrames: pipeInfo.inFrames, outFrames: pipeInfo.outFrames, drawMs: pipeInfo.drawMs || 0, at: performance.now() };
    sfu.plainProfile = false;
    sfu.silentFailures = 0;
    renderLink();
    renderGroup();
    renderCount();
    renderViewers();
    renderPause();
    setState('live');
    if (cam.enabled) startCam();
    startStats();
    starting = false;
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
    if (!live) { release(next); return; }
    const previous = current;
    current = next;
    if (pipe) {
      // The same picture track goes on: the worker just reads the new capture
      feedPipe(current.raw);
    } else {
      await replaceOnAll('video', outVideo());
    }
    await replaceOnAll('audio', current.audio);
    stream = new MediaStream([outVideo(), current.audio]);
    renderPreview();
    applyAllSenders();
    release(previous);
    showToast('Pronto, mostrando o que você escolheu.');
  }

  function stop() {
    live = false;
    stopSfu(false);
    for (const pc of pcs.values()) pc.close();
    pcs.clear();
    pending.clear();
    stopCam();
    closePipe();
    dropCardTrack();
    privacy.away = false;
    release(current);
    current = null;
    stream = null;
    $('wh-preview').srcObject = null;
    // In a group, stopping gives the place back; the friend's room carries on without this tab
    socket?.emit(groupRoom ? 'leave-group' : 'host-pause');
    stopStats();
    lastSamples = [];
    viewerList = [];
    renderViewers();
    setState('setup');
    btnStart.textContent = 'Voltar a transmitir';
  }

  // ======== Numbers: what the room panel shows, what viewers' pages use, the media server switch ========
  let statsTimer = null, tick = 0;
  const prevBytes = new WeakMap();
  let health = { inFrames: 0, at: 0 };
  async function sampleSenders() {
    const out = [];
    const entries = [...pcs];
    if (sfu.pc) entries.push(['sfu', sfu.pc]);
    for (const [id, pc] of entries) {
      try {
        const stats = await pc.getStats();
        let v = null;
        for (const r of stats.values()) if (r.type === 'outbound-rtp' && r.kind === 'video') v = r;
        if (!v) continue;
        const prev = prevBytes.get(pc);
        prevBytes.set(pc, { bytes: v.bytesSent, ts: v.timestamp });
        const kbps = prev && v.timestamp > prev.ts ? Math.round((v.bytesSent - prev.bytes) * 8 / (v.timestamp - prev.ts)) : 0;
        out.push({
          id, sfu: id === 'sfu', ageMs: performance.now() - (pc.createdAt || 0),
          w: v.frameWidth || 0, h: v.frameHeight || 0, fps: Math.round(v.framesPerSecond || 0), framesEncoded: v.framesEncoded || 0,
          limit: v.qualityLimitationReason || 'none', enc: v.encoderImplementation || '', gpu: v.powerEfficientEncoder === true,
          codec: (stats.get(v.codecId)?.mimeType || '').replace('video/', ''), kbps, idle: watchOff.has(id)
        });
      } catch {}
    }
    return out;
  }
  let lastSamples = [];
  function renderFacts(samples = lastSamples) {
    const mode = $('wh-fact-mode'), video = $('wh-fact-video'), enc = $('wh-fact-encoder'), rate = $('wh-fact-rate');
    mode.textContent = sfu.active ? 'Servidor de mídia: uma cópia só para todos' : pcs.size ? `Direto: uma cópia para cada pessoa (${pcs.size})` : 'Esperando alguém entrar';
    const active = samples.filter(s => !s.idle);
    const main = active.find(s => s.sfu) || active.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!main) { video.textContent = '–'; enc.textContent = '–'; rate.textContent = '–'; delete enc.dataset.tone; return; }
    video.textContent = `${main.w}x${main.h} a ${main.fps} fps${autoFps.active ? ' (automático: o PC está ocupado)' : ''}`;
    enc.textContent = `${main.codec || 'vídeo'} ${main.gpu ? 'na placa de vídeo' : 'no processador'}`;
    enc.dataset.tone = main.gpu ? 'ok' : 'warn';
    const total = samples.reduce((sum, s) => sum + s.kbps, 0);
    rate.textContent = `${(total / 1000).toFixed(1)} Mbps`;
  }
  // Every ~6 s: how many frames the capture really delivers and what limits the encoder, so a friend whose
  // picture stutters is told whether it's this end or theirs
  function reportHealth(samples) {
    if (!socket?.connected || !live) return;
    const now = performance.now();
    let fps;
    if (pipe) {
      const secs = health.at ? (now - health.at) / 1000 : 0;
      fps = secs > 0 ? (pipeInfo.inFrames - health.inFrames) / secs : null;
      health = { inFrames: pipeInfo.inFrames, at: now };
      if (fps == null) return;
    } else {
      fps = Math.max(0, ...samples.map(s => s.fps));
    }
    const limits = samples.filter(s => !s.idle).map(s => s.limit).filter(l => l && l !== 'none');
    const limit = limits.includes('cpu') ? 'cpu' : limits.includes('bandwidth') ? 'bandwidth' : limits.length ? 'other' : 'none';
    socket.emit('host-health', { fps: Math.round(fps), target: effFps(), limit, away: privacy.away });
  }
  async function statsTick() {
    if (!live) return;
    tick++;
    lastSamples = await sampleSenders();
    if (!live) return;
    renderFacts(lastSamples);
    updateAutoFps(lastSamples);
    updateSfuMode();
    watchSfuSilence(lastSamples);
    if (tick % 3 === 0) reportHealth(lastSamples);
    if (tick % 30 === 0) reportQuality(lastSamples);
  }

  // ======== Load: 30 fps while the PC can't keep up with 60 (as in the app) ========
  // A steady 30 looks smoother than an uneven 60 with frames thrown away, and halves the encoding. Tries 60
  // again a few minutes later; struggling again right away keeps it at 30 longer (3, 6, 12 ... 30 min).
  let loadPipe = { outFrames: 0, at: 0 };
  function updateAutoFps(samples) {
    const now = performance.now();
    const secs = loadPipe.at ? (now - loadPipe.at) / 1000 : 0;
    const outFps = secs && pipe ? (pipeInfo.outFrames - loadPipe.outFrames) / secs : 0;
    loadPipe = { outFrames: pipeInfo.outFrames, at: now };
    // Links capped on purpose ("Economizar dados", someone watching another stream) say nothing about the PC
    const links = samples.filter(s => !s.idle && s.ageMs > 10000 && !low.has(s.id));
    if (!secs || quality.fps <= 30 || privacy.away || !links.length) { autoFps.overTicks = 0; return; }
    if (autoFps.active) {
      if (Date.now() >= autoFps.retryAt) setAutoFps(false);
      return;
    }
    const sent = Math.max(...links.map(s => s.fps || 0));
    const cpu = links.some(s => s.limit === 'cpu');
    // Without the worker there's no count of frames made, only the encoder's own word
    const struggling = cpu || (pipe && outFps >= 40 && sent < outFps * 0.75);
    autoFps.overTicks = struggling ? autoFps.overTicks + 1 : 0;
    if (autoFps.overTicks >= 5) setAutoFps(true);
  }
  function setAutoFps(on) {
    autoFps.active = on;
    autoFps.overTicks = 0;
    if (on) {
      autoFps.backoffMs = Date.now() - autoFps.lastOffAt < 90000 ? Math.min(30 * 60000, autoFps.backoffMs * 2) : 3 * 60000;
      autoFps.retryAt = Date.now() + autoFps.backoffMs;
    } else {
      autoFps.lastOffAt = Date.now();
    }
    pipe?.worker.postMessage({ quality: workerQuality() });
    current?.raw?.applyConstraints(videoConstraints()).catch(() => {});
    applyAllSenders();
    renderQuality();
    renderFacts();
  }

  // Each minute, what the links carried and how the picture's path kept up, like the app's report. No ids.
  let lastReport = { inFrames: 0, outFrames: 0, drawMs: 0, at: 0 };
  function reportQuality(samples) {
    const now = performance.now();
    const secs = lastReport.at ? (now - lastReport.at) / 1000 : 0;
    const out = pipeInfo.outFrames - lastReport.outFrames;
    const pipeline = pipe && secs ? {
      srcFps: +((pipeInfo.inFrames - lastReport.inFrames) / secs).toFixed(1),
      outFps: +(out / secs).toFixed(1),
      drawMs: out ? +(((pipeInfo.drawMs || 0) - lastReport.drawMs) / out).toFixed(2) : null,
      src: `${pipeInfo.srcW}x${pipeInfo.srcH}`,
      out: `${pipeInfo.outW}x${pipeInfo.outH}`
    } : null;
    lastReport = { inFrames: pipeInfo.inFrames, outFrames: pipeInfo.outFrames, drawMs: pipeInfo.drawMs || 0, at: now };
    if (!samples.length || !pipeline && pipe) return;
    const context = {
      viewers: samples.map(({ id, ...rest }) => rest),
      pipeline, piped: !!pipe, mode: sfu.active ? 'sfu' : 'p2p', main: sfu.active ? !!sfu.main : null,
      preset: `${quality.res}p${quality.fps}`, autoFps: autoFps.active, roomViewers: roomViewerCount
    };
    try {
      fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'web-host-stats', level: 'info', message: 'quality', context, room_id: roomId, app_version: 'web', user_agent: navigator.userAgent })
      }).catch(() => {});
    } catch {}
  }
  function startStats() {
    stopStats();
    tick = 0;
    health = { inFrames: pipeInfo.inFrames, at: performance.now() };
    statsTimer = setInterval(statsTick, 2000);
  }
  function stopStats() { clearInterval(statsTimer); statsTimer = null; }

  // ======== Page ========
  const camSection = $('wh-cam-section');
  const qualitySection = $('wh-quality-section');
  const camHome = camSection.nextElementSibling;
  function setState(state) {
    document.body.dataset.state = state;
    $('wh-setup').hidden = state === 'live';
    $('wh-live').hidden = state !== 'live';
    // Live, quality and camera sit under the preview (as in the app); before, they're steps of the setup
    if (state === 'live') {
      $('wh-main').append(qualitySection, camSection);
    } else {
      camHome.before(qualitySection, camSection);
    }
    btnEditLink.disabled = state === 'live';
    renderFacts();
  }

  btnStart.addEventListener('click', start);
  $('wh-stop').addEventListener('click', stop);
  $('wh-switch').addEventListener('click', switchSource);
  window.addEventListener('beforeunload', (e) => {
    if (!live) return;
    e.preventDefault();
    e.returnValue = '';
  });
  // A closed tab ends the stream at once for viewers, instead of after the socket times out
  window.addEventListener('pagehide', () => { if (live && socket) socket.emit(groupRoom ? 'leave-group' : 'host-pause'); });

  // For the page's tests and for a look from the console: state only, nothing that isn't on this page already
  window.webHost = {
    sfu, pcs, pipeInfo, quality, privacy, low, watchOff,
    autoFps, effFps, updateAutoFps, sfuDecodeFails: sfu.decodeFails,
    get pipe() { return pipe; }, get live() { return live; }, get samples() { return lastSamples; }, statsTick,
    set loadPipe(v) { loadPipe = v; }
  };

  renderQuality();
  renderGroup();
  renderCount();
  if (groupRoom) renderLink();
  else fixedRoom().then(r => { roomId = r.roomId; hostKey = r.hostKey; renderLink(); }).catch(() => renderLink());
})();
