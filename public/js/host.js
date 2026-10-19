// ======== Error Reporting ========
let _signalUrl = null;
async function getSignalUrl() {
  if (!_signalUrl) _signalUrl = await window.electronAPI.getSignalServer();
  return _signalUrl;
}

// 'wgc' or 'dxgi' once main has said which capturer this launch uses (see fastCapture below)
let captureModeLabel = null;
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
        context: { ...(context || {}), capture: captureModeLabel },
        room_id: roomId,
        app_version: '1.7.1',
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
// Offers still waiting for the ICE servers: viewerId -> token of the newest attempt. 'viewer-left' and
// pausing drop the token, so a viewer that left meanwhile never gets a peer that nothing would close.
const pendingOffers = new Map();
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
  // One at a time: a new message replaces the one on screen instead of piling on top of it
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Section heading in the screen lists, with an optional plain-language hint after it
function sourceSectionLabel(text, hint) {
  const label = document.createElement('div');
  label.className = 'source-section-label';
  label.textContent = text;
  if (hint) label.append(Object.assign(document.createElement('span'), { className: 'source-section-hint', textContent: hint }));
  return label;
}

// Programs show up by their process name, which for games often isn't the name people know
// (Deadlock ran as "project8"). Known ones get their real name; the rest keep the process name.
const APP_NAMES = {
  deadlock: 'Deadlock', project8: 'Deadlock', 'league of legends': 'League of Legends', leagueclientuxrender: 'Cliente do LoL',
  leagueclientux: 'Cliente do LoL', cs2: 'Counter-Strike 2', 'valorant-win64-shipping': 'Valorant',
  r5apex: 'Apex Legends', 'r5apex_dx12': 'Apex Legends', 'fortniteclient-win64-shipping': 'Fortnite',
  rocketleague: 'Rocket League', overwatch: 'Overwatch 2', dota2: 'Dota 2', gta5: 'GTA V',
  'gta5_enhanced': 'GTA V', eldenring: 'Elden Ring', javaw: 'Minecraft', minecraft: 'Minecraft',
  robloxplayerbeta: 'Roblox', msedge: 'Microsoft Edge', chrome: 'Google Chrome', brave: 'Brave',
  firefox: 'Firefox', opera: 'Opera', spotify: 'Spotify', discord: 'Discord', vlc: 'VLC'
};
function appName(processName) {
  const raw = String(processName || '');
  return APP_NAMES[raw.toLowerCase()] || raw;
}

// Games whose name viewers may see next to the stream ("Igor · Deadlock"). Only these, by process
// name: a window title can carry anything (a chat, a document's name), so it never leaves the PC.
const GAME_NAMES = {
  deadlock: 'Deadlock', project8: 'Deadlock', 'league of legends': 'League of Legends', cs2: 'Counter-Strike 2',
  'valorant-win64-shipping': 'Valorant', r5apex: 'Apex Legends', r5apex_dx12: 'Apex Legends',
  'fortniteclient-win64-shipping': 'Fortnite', rocketleague: 'Rocket League', overwatch: 'Overwatch 2',
  dota2: 'Dota 2', gta5: 'GTA V', gta5_enhanced: 'GTA V', eldenring: 'Elden Ring', nightreign: 'Elden Ring Nightreign',
  javaw: 'Minecraft', minecraft: 'Minecraft', robloxplayerbeta: 'Roblox', 'marvel-win64-shipping': 'Marvel Rivals',
  rainbowsix: 'Rainbow Six Siege', rainbowsix_vulkan: 'Rainbow Six Siege', cod: 'Call of Duty', tslgame: 'PUBG',
  wow: 'World of Warcraft', cyberpunk2077: 'Cyberpunk 2077', bg3: "Baldur's Gate 3", bg3_dx11: "Baldur's Gate 3",
  helldivers2: 'Helldivers 2', 'palworld-win64-shipping': 'Palworld', 'deadbydaylight-win64-shipping': 'Dead by Daylight',
  pathofexile_x64: 'Path of Exile', pathofexilesteam: 'Path of Exile', pathofexile2: 'Path of Exile 2',
  'warframe.x64': 'Warframe', fallguys_client_game: 'Fall Guys', sekiro: 'Sekiro', darksoulsiii: 'Dark Souls III',
  hollow_knight: 'Hollow Knight', terraria: 'Terraria', 'stardew valley': 'Stardew Valley', 'among us': 'Among Us',
  discovery: 'The Finals', 'deltaforce-win64-shipping': 'Delta Force', witcher3: 'The Witcher 3', rdr2: 'Red Dead Redemption 2',
  sotgame: 'Sea of Thieves', forzahorizon5: 'Forza Horizon 5', eurotrucks2: 'Euro Truck Simulator 2',
  ffxiv_dx11: 'Final Fantasy XIV', genshinimpact: 'Genshin Impact', starrail: 'Honkai: Star Rail',
  zenlesszonezero: 'Zenless Zone Zero', 'osu!': 'osu!', fc25: 'EA Sports FC 25', fc26: 'EA Sports FC 26',
  'pioneergame': 'Arc Raiders', 'tarkov': 'Escape from Tarkov', 'escapefromtarkov': 'Escape from Tarkov',
  hogwartslegacy: 'Hogwarts Legacy', 'monsterhunterwilds': 'Monster Hunter Wilds', 'brawlhalla': 'Brawlhalla',
  'smite2-win64-shipping': 'Smite 2', 'tf_win64': 'Team Fortress 2', 'left4dead2': 'Left 4 Dead 2', 'rust': 'Rust'
};
const gameNameFor = (processName) => GAME_NAMES[String(processName || '').toLowerCase()] || null;

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
    sourceGrid.appendChild(sourceSectionLabel('Telas inteiras', 'melhor para jogos em tela cheia'));

    screens.forEach(source => {
      const item = createSourceItem(source);
      sourceGrid.appendChild(item);
    });

    sourceGrid.appendChild(sourceSectionLabel('Janelas'));
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

  let thumb;
  if (source.minimized) {
    // No picture of a minimized window: it comes on once it's back on screen
    thumb = document.createElement('div');
    thumb.className = 'source-thumb is-minimized';
    thumb.append(Object.assign(document.createElement('b'), { textContent: 'Minimizada' }),
      Object.assign(document.createElement('span'), { textContent: 'aparece quando você voltar para ela' }));
  } else {
    thumb = document.createElement('img');
    thumb.className = 'source-thumb';
    thumb.src = source.thumbnail;
    thumb.alt = source.name;
  }

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
  const name = span('session-name', appName(session.name));
  name.title = `${session.name} (processo ${session.pid})`;
  return [
    name,
    span('session-state ' + (active ? 'active' : 'inactive'), active ? 'Tocando' : 'Em silêncio')
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
  if (announce) showToast(`O som do ${appName(session.name)} foi escolhido junto com a janela.`);
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
    renderExcludeDiscord();
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
    // The same room every time, so the link friends saved keeps working (see "fixed link" below)
    const r = await fixedRoom();
    roomId = r.roomId;
    hostKey = r.hostKey;
  }

  socket = io(signalServer);
  const joinAsHost = () => {
    if (group.guestRoom) {
      socket.emit('join-room', { roomId, asHost: true, coHost: true, appVersion, name: nickname() });
    } else {
      socket.emit('join-room', { roomId, asHost: true, appVersion, hostKey, name: nickname() });
      // A restarted server forgets the room; bring the group and the lock back with it
      if (group.enabled) socket.emit('group-mode', { enabled: true });
      if (roomLocked) socket.emit('lock-room', { locked: true });
    }
    // The server forgets the SFU session when the host socket drops
    if (sfu.active) socket.emit('sfu-start', { sessionId: sfu.sessionId, tracks: sfu.tracks });
    viewerListPrimed = false;
    sendGame();
  };
  socket.on('connect', joinAsHost);

  let rejectedOnce = false;
  socket.on('host-rejected', ({ reason, group: isGroup }) => {
    if (isGroup && group.guestRoom) {
      showToast(reason || 'O servidor não aceitou esta sala.');
      if (isStreaming) pauseStreaming();
      else exitGuestMode();
      return;
    }
    reportError('Host join rejected', null, { roomId });
    // Our fixed room went to someone else (a server restart and an unlucky claim): take a new one, once
    if (group.guestRoom || rejectedOnce) { showToast(reason || 'O servidor não aceitou esta sala.'); return; }
    rejectedOnce = true;
    createRoom().then(r => {
      roomId = r.roomId;
      hostKey = r.hostKey;
      roomCodeEl.textContent = roomId;
      roomCodeBar.textContent = roomId;
      renderLinkCard();
      joinAsHost();
      showToast('O link da sala mudou. Copie o novo para os seus amigos.');
    }).catch(() => showToast(reason || 'O servidor não aceitou esta sala.'));
  });

  // Who's watching (with ids, for removing someone), their reactions and "Economizar dados"
  socket.on('viewer-list', ({ viewers, banned } = {}) => {
    const previous = viewerList;
    viewerList = Array.isArray(viewers) ? viewers : [];
    bannedCount = Number(banned) || 0;
    renderViewerList();
    // The first list after joining is everyone already there, not people arriving
    if (viewerListPrimed) announceViewers(previous, viewerList);
    viewerListPrimed = true;
  });
  socket.on('reaction', ({ emoji, name, hostId } = {}) => {
    if (hostId && hostId !== socket.id) return;
    reactionCounts.set(emoji, (reactionCounts.get(emoji) || 0) + 1);
    renderReactions();
    overlayEvent({ emoji, text: `${emoji} ${name || 'Sapo'}` });
  });
  socket.on('viewer-quality', ({ viewerId, low } = {}) => {
    if (!viewerId) return;
    if (low) lowViewers.add(viewerId);
    else lowViewers.delete(viewerId);
    applySenderLimits();
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
    pendingOffers.delete(viewerId);
    lowViewers.delete(viewerId);
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

  socket.on('room-update', ({ viewerCount: count, group: groupOn, hosts, locked }) => {
    roomViewerCount = count;
    group.hosts = Array.isArray(hosts) ? hosts : [];
    if (!group.guestRoom) group.enabled = !!groupOn;
    if (typeof locked === 'boolean' && !group.guestRoom) { roomLocked = locked; lockToggle.checked = locked; }
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
  // Bits per pixel per frame. At 0.075 (9.3 Mbps for 1080p60) the encoder sat at the cap in nearly
  // every session, so fast motion in games turned to blocks; 0.1 gives 1080p60 12.4 Mbps.
  const bpp = quality.fps > 30 ? 0.1 : 0.13;
  return Math.round(Math.min(25e6, Math.max(3e6, w * h * quality.fps * bpp)));
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
  // Never more than what was picked: a window asked for and a whole screen handed back goes nowhere
  if (String(sourceId).startsWith('window:') && source.getSettings().displaySurface === 'monitor') {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('veio a tela inteira em vez da janela escolhida, então nada foi transmitido');
  }
  // 'detail' puts the encoder in screencast mode, which drops frames to keep text sharp
  source.contentHint = 'motion';
  return gpuBackedTrack(source);
}

// A window that exists but is minimized can't be captured until it's back on screen
async function isMinimizedWindow(sourceId) {
  if (!String(sourceId || '').startsWith('window:') || !window.electronAPI.getWindowState) return false;
  const state = await window.electronAPI.getWindowState(sourceId).catch(() => null);
  return !!state?.minimized;
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
// "Já volto": drawn instead of the screen while the streamer took a quick pause
let away = false, card = null;
// The streamer's camera over the picture: the newest frame, replaced as the next one arrives.
// Layout: w is its width as a share of the picture's; x and y place it between the edges (0 = left or
// top, 1 = right or bottom), so it always stays inside whatever the picture's shape
let camFrame = null, camLayout = null, camReader = null, camRect = null;
// Output: the screen frame last drawn (kept while the camera is on, to redraw it under a new camera frame)
let canvas = null, ctx = null, lastScreen = null, lastScreenAt = 0, lastOutAt = 0, lastOutTs = -Infinity;
function targetSize(w, h) {
  const maxH = quality.res === 'native' ? h : Math.min(h, parseInt(quality.res, 10));
  if (maxH >= h) return { w, h };
  return { w: Math.round((w * maxH / h) / 2) * 2, h: Math.round(maxH / 2) * 2 };
}
function stopCam() {
  if (camReader) { camReader.cancel().catch(() => {}); camReader = null; }
  if (camFrame) { camFrame.close(); camFrame = null; }
}
async function readCam(readable) {
  stopCam();
  const reader = readable.getReader();
  camReader = reader;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (camReader !== reader) { value.close(); break; }
      if (camFrame) camFrame.close();
      camFrame = value;
      camTick();
    }
  } catch {}
}
// A still screen sends no frames (Windows Graphics Capture only sends changes) and a game's window
// capture can stall for a second: the camera would freeze with it. So a new camera frame redraws the
// last screen frame when nothing else has been drawn for a while.
function camTick() {
  if (!lastScreen || !ctx || !camLayout || (away && card)) return;
  const now = performance.now();
  if (now - lastOutAt < 20 || now - lastScreenAt < 50) return;
  render(lastScreen, lastOutTs + Math.round((now - lastOutAt) * 1000), { read: 0, bursts: 0, longGaps: 0, maxGap: 0 });
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
function drawCam(ctx, w, h) {
  camRect = null;
  if (!camFrame || !camLayout) return;
  const m = Math.round(h * 0.025);
  const aspect = camFrame.displayHeight / camFrame.displayWidth;
  let cw = Math.round(w * clamp(camLayout.w, 0.08, 0.9));
  if (cw * aspect > h - 2 * m) cw = Math.round((h - 2 * m) / aspect);
  const ch = Math.round(cw * aspect);
  const x = Math.round(m + clamp(camLayout.x, 0, 1) * Math.max(0, w - 2 * m - cw));
  const y = Math.round(m + clamp(camLayout.y, 0, 1) * Math.max(0, h - 2 * m - ch));
  camRect = [x / w, y / h, cw / w, ch / h];
  const r = Math.round(ch * 0.08);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, cw, ch, r);
  ctx.clip();
  ctx.drawImage(camFrame, x, y, cw, ch);
  ctx.restore();
  ctx.lineWidth = Math.max(2, Math.round(h / 360));
  ctx.strokeStyle = 'rgba(243, 248, 236, 0.85)';
  ctx.beginPath();
  ctx.roundRect(x, y, cw, ch, r);
  ctx.stroke();
}
function drawCard(ctx, w, h) {
  ctx.fillStyle = '#0B1A10';
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w / card.width, h / card.height);
  ctx.drawImage(card, (w - card.width * s) / 2, (h - card.height * s) / 2, card.width * s, card.height * s);
}
// Draws one output frame from a screen frame (new, or the last one again under a new camera frame)
function render(src, ts, stats) {
  const t0 = performance.now();
  const { w, h } = targetSize(src.displayWidth, src.displayHeight);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingQuality = 'high';
  }
  if (away && card) {
    drawCard(ctx, w, h);
    camRect = null;
  } else {
    ctx.drawImage(src, 0, 0, w, h);
    drawCam(ctx, w, h);
  }
  // Always later than the previous frame, whichever of the two drew it
  const outTs = Math.max(ts, lastOutTs + 1000);
  const out = new VideoFrame(canvas, { timestamp: outTs });
  lastOutTs = outTs;
  lastOutAt = performance.now();
  self.postMessage({ frame: out, ...stats, drawMs: lastOutAt - t0, srcW: src.displayWidth, srcH: src.displayHeight, outW: w, outH: h, camRect }, [out]);
}
self.onmessage = async (e) => {
  const d = e.data;
  if (d.quality) quality = d.quality;
  if ('away' in d) away = !!d.away;
  if (d.card) { if (card) card.close(); card = d.card; }
  if ('camLayout' in d) camLayout = d.camLayout;
  if ('cam' in d) { if (d.cam) readCam(d.cam); else stopCam(); }
  if (!e.data.readable) return;
  const reader = e.data.readable.getReader();
  canvas = new OffscreenCanvas(e.data.width || 1920, e.data.height || 1080);
  ctx = canvas.getContext('2d', { alpha: false });
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
      render(frame, frame.timestamp, { read, bursts, longGaps, maxGap });
      read = 0; bursts = 0; longGaps = 0; maxGap = 0;
      // Kept only while the camera is on, the one frame it may need to be redrawn under (see camTick)
      if (lastScreen) lastScreen.close();
      lastScreen = camFrame ? frame : null;
      lastScreenAt = t0;
      if (!lastScreen) frame.close();
    }
    self.postMessage({ done: true });
  } catch (err) {
    self.postMessage({ done: true, error: err.message });
  }
  if (lastScreen) { lastScreen.close(); lastScreen = null; }
  stopCam();
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
      // Where the camera landed in the picture, for the handle over the preview
      if (generator === localStream?.getVideoTracks()[0]) placeCamHandle(m.camRect);
      pacer.push(m.frame);
      return;
    }
    if (m.error && generator.readyState === 'live') reportError('GPU frame pipeline failed: ' + m.error);
    if (m.done) {
      pacer.clear();
      writer.close().catch(() => {});
      worker.terminate();
      for (const t of worker.camClones || []) t.stop();
    }
  };
  worker.onerror = (e) => reportError('GPU frame pipeline worker error: ' + e.message);

  const settings = source.getSettings();
  worker.postMessage(
    { readable: processor.readable, quality: { ...quality }, width: settings.width, height: settings.height },
    [processor.readable]
  );
  // A new capture (another window, the source coming back) gets the camera and the away card again
  attachWorkerExtras(worker);
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
    let videoTrack;
    let waiting = false;
    try {
      videoTrack = await captureVideo(selectedSourceId);
      captureStartedAt = Date.now();
    } catch (err) {
      // Minimized (a game in exclusive fullscreen minimizes itself when FrogShare is clicked): live with
      // the "já volta" card, and the window comes on by itself once it's back on screen
      if (!await isMinimizedWindow(selectedSourceId)) {
        offerOldCapture('start', err);
        throw err;
      }
      waiting = true;
      videoTrack = standbyCardTrack();
    }
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
      const result = await window.electronAPI.startAudioCapture(await systemAudioTarget());
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
    // Waiting for a window: its program is one of the ways to find it again
    const remembering = rememberSource(sourceById(selectedSourceId));
    if (waiting) await remembering;
    syncPreview();

    // 3. Create or reuse room
    await ensureRoom();
    isStreaming = true;
    renderExcludeDiscord();
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
    document.getElementById('stream-main').append(qualitySection, camSection, privacySection);

    startStatsUpdate();
    startLiveExtras();
    if (waiting) await waitForWindow(true);

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
    params.encodings[0].maxFramerate = viewerFps(label);
    params.encodings[0].scaleResolutionDownBy = lowScale(label);
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

  const token = {};
  pendingOffers.set(viewerId, token);
  // The first fetch after the app opens is a round trip, long enough for a viewer to leave
  const iceConfig = await getIceConfig();
  if (pendingOffers.get(viewerId) !== token) return;
  pendingOffers.delete(viewerId);
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
      // Read the ICE state before closing: closing first left every report with empty candidate lists
      if (peerConnections.get(viewerId) === pc) peerConnections.delete(viewerId);
      iceDiagnostics(pc)
        .then(diag => reportError('PeerConnection failed', null, { viewerId, sid: pc.sid, ...diag }))
        .finally(() => pc.close());
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
  queueMicrotask(renderExcludeDiscord);
  isStreaming = false;
  stopStandby();
  stopLiveExtras();
  window.electronAPI.setStreamingPriority(false);
  flushRelayUsage();
  panelSetup.insertBefore(qualitySection, btnStart);
  panelSetup.insertBefore(camSection, btnStart);
  panelSetup.insertBefore(privacySection, btnStart);

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
  pendingOffers.clear();
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
      ? `Você vai transmitir na sala de ${group.ownerName} (${group.guestRoom}), junto com a tela dele. Escolha a tela e o som aqui embaixo.`
      : `Você vai transmitir na sala ${group.guestRoom}, junto com o dono. Escolha a tela e o som aqui embaixo.`;
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
  chipGroupText.textContent = guest ? `Em grupo${group.ownerName ? ' com ' + group.ownerName : ''}` : `${group.hosts.length} transmitindo em grupo`;

  const items = group.hosts.slice().sort((a, b) => a.slot - b.slot).map(h => {
    const li = document.createElement('li');
    li.className = `slot-${h.slot}`;
    const frog = Object.assign(document.createElement('img'), { className: 'group-frog' + (frogIcon(h.name).includes('big') ? ' is-big' : ''), src: frogIcon(h.name), alt: '' });
    const name = Object.assign(document.createElement('span'), { className: 'group-name', textContent: h.name });
    const tags = [h.id === me ? 'você' : '', h.owner ? 'dono' : '', h.paused ? 'pausado' : ''].filter(Boolean)
      .map(t => Object.assign(document.createElement('span'), { className: 'group-tag', textContent: t }));
    li.append(frog, name, ...tags);
    if (!guest && !h.owner) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'btn btn-ghost btn-icon';
      kick.title = `Expulsar ${h.name} da transmissão`;
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
  const link = await roomLink(roomId);
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
// Sharing never squeezes a viewer below this. The budget is learned from what the encoders send, so
// a cap below what a stream needs reads as "uplink full" on the next pass and ratchets down: seen
// live in 1.6.3, 2 Mbps -> 63 kbps in two minutes, 320x180 on the CPU encoder until a reconnect.
const MIN_SHARE_BPS = 1200000;

function isExcluded(viewerId) {
  const until = share.excluded.get(viewerId);
  if (until && until > Date.now()) return true;
  share.excluded.delete(viewerId);
  return false;
}

// "Economizar dados": a viewer on a phone plan asked for a lighter copy, at most 540p30 and 1.2 Mbps
// (~0.5 GB an hour instead of up to ~5). Direct connections only; through the SFU everyone shares one copy.
const lowViewers = new Set();
const LOW_VIEWER_BPS = 1200000;
function lowScale(viewerId) {
  if (!lowViewers.has(viewerId)) return 1;
  const h = pipe.outH || 1080;
  return h > 540 ? +(h / 540).toFixed(3) : 1;
}
const viewerFps = (viewerId) => (lowViewers.has(viewerId) ? Math.min(30, quality.fps) : quality.fps);

function viewerBitrateCap(viewerId) {
  const preset = presetBitrate();
  if (viewerId && lowViewers.has(viewerId)) return Math.min(LOW_VIEWER_BPS, preset);
  if (share.mode === 'off' || (viewerId && isExcluded(viewerId))) return preset;
  const sharing = [...peerConnections.keys()].filter(id => !isExcluded(id) && viewerWatch.get(id) !== false && !lowViewers.has(id)).length || 1;
  return Math.round(Math.min(preset, Math.max(MIN_SHARE_BPS, share.budget / sharing)));
}

function applySenderLimits() {
  const entries = [...peerConnections];
  if (sfu.pc) entries.push([null, sfu.pc]);
  for (const [viewerId, pc] of entries) {
    // The SFU link carries the one copy everybody watches, so it always gets the full preset
    const isSfu = pc === sfu.pc;
    const cap = isSfu ? presetBitrate() : viewerBitrateCap(viewerId);
    const fps = isSfu ? quality.fps : viewerFps(viewerId);
    const scale = isSfu ? 1 : lowScale(viewerId);
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    const e = params.encodings[0];
    if (e.maxBitrate === cap && e.maxFramerate === fps && (e.scaleResolutionDownBy || 1) === scale) continue;
    e.maxBitrate = cap;
    e.maxFramerate = fps;
    e.scaleResolutionDownBy = scale;
    sender.setParameters(params).catch(() => {});
  }
}

function resetShare() {
  share.mode = 'off';
  share.budget = Infinity;
  share.trialIds = [];
}

function updateUploadBudget(samples, captureSteady) {
  // Viewers on "Economizar dados" have their own small cap and stay out of the sharing
  const eligible = samples.filter(s => !isExcluded(s.id) && !lowViewers.has(s.id));
  // A fresh connection is still ramping up bandwidth estimation, which looks like throttling.
  // So does a capture that stalled (a game hitch, a window switch): fewer frames, lower bitrate,
  // nothing to do with the uplink. Neither may move the budget.
  if (eligible.length < 2 || samples.some(s => s.ageMs < 10000) || !captureSteady) {
    if (eligible.length < 2) resetShare();
    applySenderLimits();
    return;
  }
  // Throttled means WebRTC itself says bandwidth is the limit, not just "sending less than the cap"
  const limited = eligible.filter(s => s.limit === 'bandwidth' && s.targetBitrate < viewerBitrateCap(s.id) * 0.85);
  const total = Math.max(eligible.reduce((sum, s) => sum + s.targetBitrate, 0), MIN_SHARE_BPS * eligible.length);

  if (share.mode === 'off') {
    if (limited.length > 0 && limited.length < eligible.length) {
      share.mode = 'trial';
      share.budget = total;
      share.trialStart = Date.now();
      share.trialIds = limited.map(s => s.id);
    }
  } else if (share.mode === 'trial') {
    if (Date.now() - share.trialStart >= 10000) {
      const stillLow = eligible.filter(s => share.trialIds.includes(s.id) && s.limit === 'bandwidth' && s.targetBitrate < viewerBitrateCap(s.id) * 0.85);
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

// ======== Stuck encoder recovery ========
// When a link's bitrate drops very low, or the hardware encoder hiccups, WebRTC switches that sender to
// the software encoder (OpenH264) and keeps it there for good, even after things recover: viewers got
// 320x180 at 7 fps until someone reconnected. While the GPU encoder works here, rebuild just that link
// (the viewer swaps to the new one on its own). Not during the standby card, which is software on purpose.
const encoderHeal = { gpuSeen: false, softTicks: new Map(), lastAt: new Map() };
function healStuckEncoders(samples) {
  if (samples.some(s => s.gpu)) encoderHeal.gpuSeen = true;
  for (const s of samples) {
    const stuck = encoderHeal.gpuSeen && !s.gpu && !s.idle && !standby.active && s.ageMs > 15000 && /openh264/i.test(s.enc || '');
    const ticks = stuck ? (encoderHeal.softTicks.get(s.id) || 0) + 1 : 0;
    encoderHeal.softTicks.set(s.id, ticks);
    if (ticks < 3 || Date.now() - (encoderHeal.lastAt.get(s.id) || 0) < 60000) continue;
    encoderHeal.lastAt.set(s.id, Date.now());
    encoderHeal.softTicks.set(s.id, 0);
    reportError('Encoder stuck on software, rebuilding link', null, { viewer: s.viewer, sfu: s.sfu, res: s.res, kbps: Math.round(s.targetBitrate / 1000) });
    if (s.sfu) stopSfu(); // the next stats pass publishes again on a fresh connection
    else createOfferForViewer(s.id).catch(() => {});
  }
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
            // Seconds this link has spent limited by CPU / bandwidth since it was created
            limitCpuS: Math.round(r.qualityLimitationDurations?.cpu || 0),
            limitBwS: Math.round(r.qualityLimitationDurations?.bandwidth || 0),
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

let tickPipe = { inFrames: 0, longGaps: 0 };
function captureSteadySinceLastTick() {
  const steady = pipe.inFrames > tickPipe.inFrames && pipe.longGaps === tickPipe.longGaps;
  tickPipe = { inFrames: pipe.inFrames, longGaps: pipe.longGaps };
  return steady;
}

function startStatsUpdate() {
  clearInterval(statsInterval);
  lastPipe = { ...pipe, at: performance.now() };
  tickPipe = { inFrames: pipe.inFrames, longGaps: pipe.longGaps };
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
    updateUploadBudget(samples.filter(x => !x.sfu && !x.idle), captureSteadySinceLastTick() && !standby.active);
    healStuckEncoders(samples);
    updateSfuMode();
    if (statsTicks % 3 === 0) reportHealth(samples);
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

async function reportQuality(samples, pipeline) {
  const health = await window.electronAPI.getAppHealth?.().catch(() => null);
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
    capture: fastCapture.active ? 'wgc' : 'dxgi',
    appCpu: health?.cpu || null,
    gpu: health?.gpu || null,
    roomViewers: roomViewerCount,
    preset: `${quality.res}p${quality.fps}`,
    share: share.mode,
    budgetKbps: share.budget === Infinity ? null : Math.round(share.budget / 1000)
  };
  getSignalUrl().then(url => fetch(`${url}/api/errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'host-stats', level: 'info', message: 'quality', context, room_id: roomId, app_version: '1.7.1', user_agent: navigator.userAgent })
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
    switchSourceGrid.appendChild(sourceSectionLabel('Telas inteiras', 'melhor para jogos em tela cheia'));
    screens.forEach(addItem);
    switchSourceGrid.appendChild(sourceSectionLabel('Janelas'));
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
  if (value === 'system') return systemAudioName();
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
  addOption('system', [nameSpan(systemAudioName())]);
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

// Puts a track on every live connection. A viewer can leave (its connection closes) while this runs;
// that one is skipped instead of aborting the swap for everybody else.
async function replaceOnAllSenders(kind, track) {
  for (const pc of sendingPcs()) {
    if (pc.signalingState === 'closed') continue;
    const transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === kind && t.sender);
    if (!transceiver) continue;
    try {
      await transceiver.sender.replaceTrack(track);
    } catch (err) {
      if (pc.signalingState !== 'closed') reportError(`replaceTrack (${kind}) failed: ` + err.message, err.stack);
    }
  }
}

async function replaceVideoTrack(newVideoTrack) {
  await replaceOnAllSenders('video', newVideoTrack);
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
  captureStartedAt = Date.now();
  stopStandby();
  await replaceVideoTrack(newVideoTrack);
  selectedSourceId = source.id;
  await rememberSource(source);
  (newVideoTrack.sourceTrack || newVideoTrack).addEventListener('ended', (e) => onCaptureEnded(e.target));
  // Another screen or window: the game is found again from it
  sourceChanged();
}

// What was picked in "Trocar janela ou som". A minimized window gets the card until it's back on screen.
// Returns whether the picture changed now.
async function switchOrWait(source) {
  try {
    await switchVideo(source);
    return true;
  } catch (err) {
    // While waiting for a window to come back, a brief refusal is normal and retried (see checkStandby)
    if (await isMinimizedWindow(source.id)) {
      await rememberSource(source);
      await waitForWindow(false);
      sourceChanged();
      return false;
    }
    if (!standby.active) offerOldCapture('switch', err);
    throw err;
  }
}

// ======== Captured window closed or minimized ========
// A game's window closes at the end of every match. Pausing there (as before) dropped every viewer,
// unnoticed with the app minimized. Now the stream stays up with a "be right back" card, the host
// gets a notification, and the program's window is picked up again by itself when it reappears
// (the same window, the same title, or another window of the same program). A screen that goes away
// still pauses. A window picked while minimized waits the same way, until it's back on screen.
const standby = { active: false, timer: null, id: null, name: '', owner: '', lastIds: '', busy: false, failures: 0, retryAt: 0 };

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
  if (Date.now() - captureStartedAt < 5000) offerOldCapture('ended');
  if (!isStreaming || !localStream) return;
  const live = localStream.getVideoTracks()[0];
  if (!live || (live.sourceTrack || live) !== endedTrack) return; // already switched away
  if (currentSource.isScreen || !currentSource.id) { pauseStreaming(); return; }
  enterStandby();
}

// The card goes on air (unless it already is) and the window is looked for every 2 s
async function beginStandby(cardOnAir) {
  standby.active = true;
  standby.id = currentSource.id;
  standby.name = currentSource.name;
  standby.owner = currentSource.owner;
  standby.lastIds = '';
  standby.failures = 0;
  standby.retryAt = 0;
  if (!cardOnAir) await replaceVideoTrack(standbyCardTrack());
  selectedSourceId = null;
  clearInterval(standby.timer);
  standby.timer = setInterval(checkStandby, 2000);
}

async function enterStandby() {
  await beginStandby(false);
  const name = standby.name || 'A janela';
  showToast(`"${name}" fechou. Seus amigos veem um aviso; a transmissão volta sozinha quando ela abrir de novo.`);
  window.electronAPI.notify('A janela da transmissão fechou',
    `"${name}" fechou. Seus amigos veem um aviso de "já volta". A transmissão volta sozinha quando a janela abrir de novo, ou escolha outra em Trocar janela ou som.`);
}

// The picked window is minimized (currentSource): the card until it's back on screen
async function waitForWindow(cardOnAir) {
  await beginStandby(cardOnAir);
  showToast(`"${standby.name || 'A janela'}" está minimizada. Seus amigos veem "já volta" até você voltar para ela.`);
}

function stopStandby() {
  clearInterval(standby.timer);
  standby.timer = null;
  standby.active = false;
}

async function checkStandby() {
  if (!isStreaming || !standby.active) return stopStandby();
  if (standby.busy || Date.now() < (standby.retryAt || 0)) return;
  standby.busy = true;
  let match = null;
  try {
    // Cheap check first; the full list (thumbnails) only when a window opened, closed, was minimized or came back
    const ids = await window.electronAPI.getSourceIds();
    if (ids === standby.lastIds) return;
    standby.lastIds = ids;
    // Minimized windows are listed without a picture and can't be captured yet
    const windows = (await window.electronAPI.getSources()).filter(s => !s.isScreen && !s.minimized);
    windows.forEach(s => knownSources.set(s.id, s));
    match = windows.find(s => s.id === standby.id) || windows.find(s => s.name === standby.name);
    if (!match && standby.owner) {
      for (const s of windows) {
        const owner = await window.electronAPI.getWindowOwner(s.id);
        if (owner && owner.name === standby.owner) { match = s; break; }
      }
    }
    if (!match || !standby.active) return;
    await switchVideo(match);
    standby.failures = 0;
    standby.retryAt = 0;
    showToast(`Voltou: mostrando ${match.name}`);
    window.electronAPI.notify('A transmissão voltou', `Mostrando "${match.name}" de novo.`);
  } catch (err) {
    // Minimized again before it could be captured: it comes on when it's back (the list changes then)
    if (match && await isMinimizedWindow(match.id)) return;
    // A window that just reappeared can refuse capture for a moment ("Could not start video source",
    // e.g. a game still switching to fullscreen). Forget the window list so the next pass tries again,
    // instead of waiting for some other window to open or close (seen live: stuck on the standby card).
    standby.lastIds = '';
    standby.failures = (standby.failures || 0) + 1;
    standby.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** standby.failures);
    if (standby.failures <= 3) reportError('Standby recovery failed: ' + err.message, err.stack, { attempt: standby.failures });
    // Refused again and again: likely a game the fast capturer can't take (exclusive fullscreen)
    if (standby.failures === 3) offerOldCapture('standby', err);
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

async function switchAudio(newPid, label = '', { quiet = false } = {}) {
  // Stop old audio
  await window.electronAPI.stopAudioCapture();
  window.electronAPI.removeAudioListeners();
  if (audioWorkletNode) { audioWorkletNode.disconnect(); audioWorkletNode = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }

  // The new sound, or the silent channel for "Sem som" (also the fallback if capture fails)
  let newAudioTrack = silentAudioTrack();
  if (newPid !== 'none') {
    const result = await window.electronAPI.startAudioCapture(newPid === 'system' ? await systemAudioTarget() : newPid);
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
  await replaceOnAllSenders('audio', newAudioTrack);

  if (typeof newPid === 'number') selectedPid = newPid;
  liveAudio = newPid;
  if (newPid !== 'system') excludedDiscordPid = 0;
  renderExcludeDiscord();
  if (!quiet) showToast(`Som trocado para ${label || 'o app escolhido'}`);
}

// ======== "Todo o PC" without Discord ========
// Windows can capture everything the PC plays except one program's process tree. Discord is the one
// people want out (friends would hear the call). On by default, remembered, and switchable live.
const EXCLUDE_KEY = 'fs-exclude-discord';
const excludeDiscord = document.getElementById('exclude-discord');
const excludeDiscordRow = document.getElementById('exclude-discord-row');
const excludeDiscordLive = document.getElementById('exclude-discord-live');
const excludeDiscordLiveRow = document.getElementById('exclude-discord-live-row');
let excludeSupported = false;
let excludedDiscordPid = 0; // Discord's top process left out of the live sound, 0 when none
function excludeWanted() {
  try { return localStorage.getItem(EXCLUDE_KEY) !== '0'; } catch { return true; }
}

// What to ask the capture helper for when "Todo o PC" is picked
async function systemAudioTarget() {
  excludedDiscordPid = 0;
  if (!excludeSupported || !excludeWanted()) return 'system';
  const root = await window.electronAPI.findAppRoot('Discord.exe').catch(() => 0);
  excludedDiscordPid = root || 0;
  return root ? `system-except:${root}` : 'system';
}

const systemAudioName = () => (excludeSupported && excludeWanted() ? 'Todo o PC, menos o Discord' : 'Todo o PC');

function renderExcludeDiscord() {
  const wanted = excludeWanted();
  excludeDiscord.checked = wanted;
  excludeDiscordLive.checked = wanted;
  excludeDiscordRow.hidden = !excludeSupported || getAudioMode() !== 'system';
  excludeDiscordLiveRow.hidden = !excludeSupported || !isStreaming || liveAudio !== 'system';
}

async function setExcludeDiscord(on) {
  try { localStorage.setItem(EXCLUDE_KEY, on ? '1' : '0'); } catch {}
  renderExcludeDiscord();
  // Live with the whole PC's sound: apply right away
  if (isStreaming && liveAudio === 'system') {
    await switchAudio('system', '', { quiet: true });
    showToast(on ? 'O som do Discord saiu da transmissão' : 'O som do Discord voltou para a transmissão');
  }
}
excludeDiscord.addEventListener('change', () => setExcludeDiscord(excludeDiscord.checked));
excludeDiscordLive.addEventListener('change', () => setExcludeDiscord(excludeDiscordLive.checked));

// Discord opened after the stream started, or restarted (updates do that): its new process isn't
// excluded yet, so pick it up. A cheap helper call every 8 s, only while live with the whole PC.
let excludeWatchBusy = false;
setInterval(async () => {
  if (!excludeSupported || !isStreaming || liveAudio !== 'system' || !excludeWanted() || excludeWatchBusy) return;
  excludeWatchBusy = true;
  try {
    const root = await window.electronAPI.findAppRoot('Discord.exe').catch(() => 0);
    if (root && root !== excludedDiscordPid && isStreaming && liveAudio === 'system') {
      await switchAudio('system', '', { quiet: true });
    }
  } finally {
    excludeWatchBusy = false;
  }
}, 8000);

window.electronAPI.getPlatform().then(p => {
  // Process loopback (and so leaving one program out) exists on Windows only
  excludeSupported = p === 'win32' && typeof window.electronAPI.findAppRoot === 'function';
  renderExcludeDiscord();
});

async function applySwitch() {
  const source = switchPick.sources.find(s => s.id === switchPick.sourceId);
  const videoChanged = !!source && source.id !== selectedSourceId;
  const newAudio = switchPick.audio;
  const audioChanged = newAudio !== 'keep' && newAudio !== liveAudio;
  const audioName = audioChanged ? switchAudioLabel(newAudio) : '';
  switchModal.style.display = 'none';
  if (!videoChanged && !audioChanged) return;

  try {
    // Switch video (a minimized window: the card until it's back, with its own message)
    const shown = videoChanged ? await switchOrWait(source) : true;

    // Switch audio
    if (audioChanged) {
      await switchAudio(newAudio, audioName);
    }

    if (!shown) return;
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

// ======== Fast capture switch ========
// Windows Graphics Capture instead of Chromium's default capturer (see main.js). Takes effect on launch.
const fastCapture = { supported: false, active: false, wanted: false };
const fastCaptureRow = document.getElementById('fast-capture-row');
const fastCaptureInput = document.getElementById('fast-capture');
let captureStartedAt = 0;
const captureFallbackBanner = document.getElementById('capture-fallback-banner');

// Windows Graphics Capture failed on what was picked. The 1.0 era saw it fail on exclusive fullscreen
// games (error -2147467259) and 1.6.6 turned it on without testing that mode, so offer the old capturer
// (applied on relaunch) instead of leaving the person stuck. Reported so the field shows how often.
function offerOldCapture(when, err) {
  if (!fastCapture.active || captureFallbackBanner.style.display !== 'none') return;
  reportError('Fast capture failed (' + when + '): ' + (err?.message || 'track ended'), err?.stack, { source: currentSource?.isScreen ? 'screen' : 'window' });
  captureFallbackBanner.style.display = '';
}
document.getElementById('btn-capture-fallback').addEventListener('click', () => {
  fastCapture.wanted = false;
  showToast('Reiniciando o FrogShare com a captura antiga…');
  setTimeout(() => window.electronAPI.setFastCapture(false, true), 900);
});

window.electronAPI.getFastCapture?.().then(state => {
  Object.assign(fastCapture, state);
  captureModeLabel = state.active ? 'wgc' : 'dxgi';
  fastCaptureRow.hidden = !state.supported;
  fastCaptureInput.checked = state.wanted;
}).catch(() => {});
fastCaptureInput.addEventListener('change', async () => {
  const on = fastCaptureInput.checked;
  fastCapture.wanted = on;
  if (isStreaming) {
    await window.electronAPI.setFastCapture(on, false);
    showToast('Vale na próxima vez que você abrir o FrogShare.');
  } else {
    showToast('Reiniciando o FrogShare para trocar a captura…');
    setTimeout(() => window.electronAPI.setFastCapture(on, true), 900);
  }
});

// ======== The room's fixed link ========
// The app keeps one room for good (its id and owner key), so the link friends saved keeps working.
// It can also get a name of its own (frogshare.onrender.com/s/igor); the server keeps that bond.
const ROOM_KEY = 'fs-room';
const OWNED_KEY = 'fs-owned-rooms';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
function savedRoom() {
  const r = store.get(ROOM_KEY);
  return r && /^[A-Za-z0-9_-]{1,64}$/.test(r.roomId || '') && typeof r.hostKey === 'string' ? r : null;
}
function keepRoom(r) {
  store.set(ROOM_KEY, { roomId: r.roomId, hostKey: r.hostKey });
  // The keys of rooms used before, so a name you had can be taken back
  const owned = store.get(OWNED_KEY) || {};
  delete owned[r.roomId];
  owned[r.roomId] = r.hostKey;
  store.set(OWNED_KEY, Object.fromEntries(Object.entries(owned).slice(-10)));
}
async function createRoom() {
  const url = await getSignalUrl();
  const res = await fetch(`${url}/api/room/create`);
  if (!res.ok) throw new Error(`o servidor respondeu ${res.status}`);
  const r = await res.json();
  keepRoom(r);
  return r;
}
let roomPromise = null;
function fixedRoom() {
  const r = savedRoom();
  if (r) return Promise.resolve(r);
  roomPromise = roomPromise || createRoom().finally(() => { roomPromise = null; });
  return roomPromise;
}
async function roomLink(id = roomId || savedRoom()?.roomId) {
  const url = await getSignalUrl();
  return id ? `${url}/s/${encodeURIComponent(id)}` : '';
}

const linkText = document.getElementById('room-link-text');
const btnCopyFixed = document.getElementById('btn-copy-fixed-link');
const btnEditLink = document.getElementById('btn-edit-link');
const linkForm = document.getElementById('link-form');
const linkName = document.getElementById('link-name');

async function renderLinkCard() {
  const link = await roomLink(group.guestRoom ? savedRoom()?.roomId : undefined).catch(() => '');
  linkText.textContent = link ? link.replace(/^https?:\/\//, '') : 'O link aparece aqui quando o servidor responder.';
  btnCopyFixed.disabled = !link;
  const url = await getSignalUrl();
  document.getElementById('link-prefix').textContent = url.replace(/^https?:\/\//, '') + '/s/';
  btnEditLink.disabled = isStreaming;
  btnEditLink.title = isStreaming ? 'Pare a transmissão para mudar o link' : '';
}
btnCopyFixed.addEventListener('click', async () => {
  const link = await roomLink(savedRoom()?.roomId);
  navigator.clipboard.writeText(link).then(() => showToast('Link copiado. É só mandar para os amigos.'));
});
btnEditLink.addEventListener('click', () => {
  const open = linkForm.hidden;
  linkForm.hidden = !open;
  btnEditLink.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const current = savedRoom()?.roomId || '';
  linkName.value = /^[0-9a-f]{8}$/.test(current) ? '' : current;
  linkName.focus();
});

// A new room while not live: drop the old connection so the next start joins the new one
function moveToRoom(r) {
  keepRoom(r);
  if (!group.guestRoom && socket) leaveRoomConnection();
  roomLocked = false;
  lockToggle.checked = false;
  linkForm.hidden = true;
  btnEditLink.setAttribute('aria-expanded', 'false');
  btnStart.textContent = startLabel();
  renderLinkCard();
}

linkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isStreaming) { showToast('Pare a transmissão para mudar o link.'); return; }
  const name = linkName.value.trim().toLowerCase();
  if (!name) { linkName.focus(); return; }
  try {
    const url = await getSignalUrl();
    const owned = store.get(OWNED_KEY) || {};
    const res = await fetch(`${url}/api/room/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hostKey: owned[name] || undefined })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Não deu para usar esse nome.'); linkName.focus(); return; }
    moveToRoom(data);
    showToast('Pronto! Seu link agora é ' + (await roomLink(data.roomId)).replace(/^https?:\/\//, ''));
  } catch (err) {
    showToast('Não deu para mudar o link: ' + err.message);
  }
});
document.getElementById('btn-random-link').addEventListener('click', async () => {
  if (isStreaming) { showToast('Pare a transmissão para mudar o link.'); return; }
  try {
    const url = await getSignalUrl();
    const res = await fetch(`${url}/api/room/create`);
    if (!res.ok) throw new Error(`o servidor respondeu ${res.status}`);
    moveToRoom(await res.json());
    showToast('Link novo pronto. O antigo não leva mais à sua sala.');
  } catch (err) {
    showToast('Não deu para gerar outro link: ' + err.message);
  }
});

// ======== Who's watching ========
const viewerListEl = document.getElementById('viewer-list');
const lockToggle = document.getElementById('lock-toggle');
let viewerList = [];
let viewerListPrimed = false;
let roomLocked = false;
// How long someone removed stays out (the owner's pick, remembered), and how many are out right now
const KICK_TIME_KEY = 'fs-kick-minutes';
const kickTime = document.getElementById('kick-time');
const btnClearBans = document.getElementById('btn-clear-bans');
let bannedCount = 0;
try {
  const saved = localStorage.getItem(KICK_TIME_KEY);
  if (saved && [...kickTime.options].some(o => o.value === saved)) kickTime.value = saved;
} catch {}
kickTime.addEventListener('change', () => { try { localStorage.setItem(KICK_TIME_KEY, kickTime.value); } catch {} });
btnClearBans.addEventListener('click', () => {
  socket?.emit('clear-bans');
  showToast('Pronto: quem você expulsou já pode voltar.');
});

function renderViewerList() {
  const owner = !group.guestRoom;
  document.getElementById('lock-row').hidden = !owner;
  document.getElementById('kick-row').hidden = !owner || !viewerList.length;
  btnClearBans.hidden = !owner || !bannedCount;
  btnClearBans.textContent = bannedCount > 1 ? `Deixar voltar as ${bannedCount} pessoas que eu expulsei` : 'Deixar voltar quem eu expulsei';
  const shown = viewerList.slice(0, 30);
  const items = shown.map(v => {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('span'), { className: 'viewer-name', textContent: v.name, title: v.name }));
    // Only the room's owner removes people; two clicks, so a slip of the mouse doesn't
    if (owner) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'btn btn-ghost viewer-kick';
      kick.textContent = 'Expulsar';
      kick.title = `Expulsar ${v.name} da sala`;
      kick.addEventListener('click', () => {
        if (!kick.classList.contains('confirm')) {
          kick.classList.add('confirm');
          kick.textContent = 'Expulsar mesmo?';
          setTimeout(() => { kick.classList.remove('confirm'); kick.textContent = 'Expulsar'; }, 3500);
          return;
        }
        socket?.emit('kick-viewer', { viewerId: v.id, minutes: Number(kickTime.value) });
        showToast(`${v.name} foi expulso da sala e fica fora por ${kickTime.selectedOptions[0].textContent}. Para ninguém novo entrar, tranque a sala.`);
      });
      li.append(kick);
    }
    return li;
  });
  if (viewerList.length > shown.length) items.push(Object.assign(document.createElement('li'), { className: 'viewer-more', textContent: `e mais ${viewerList.length - shown.length}` }));
  viewerListEl.replaceChildren(...items);
}

lockToggle.addEventListener('change', () => {
  roomLocked = lockToggle.checked;
  socket?.emit('lock-room', { locked: roomLocked });
  showToast(roomLocked ? 'Sala trancada: quem já está continua, ninguém novo entra.' : 'Sala aberta de novo.');
});

const listNames = (names) => (names.length > 2 ? `${names.slice(0, 2).join(', ')} e mais ${names.length - 2}` : names.join(' e '));
function announceViewers(previous, next) {
  if (!isStreaming) return;
  const before = new Set(previous.map(v => v.id));
  const after = new Set(next.map(v => v.id));
  const joined = next.filter(v => !before.has(v.id)).map(v => v.name);
  const left = previous.filter(v => !after.has(v.id)).map(v => v.name);
  if (joined.length) overlayEvent({ text: `${listNames(joined)} ${joined.length > 1 ? 'entraram' : 'entrou'}`, expand: true });
  else if (left.length) overlayEvent({ text: `${listNames(left)} ${left.length > 1 ? 'saíram' : 'saiu'}` });
}

// ======== Reactions ========
const reactionCounts = new Map();
function renderReactions() {
  const el = document.getElementById('reaction-counts');
  el.hidden = !reactionCounts.size;
  el.replaceChildren(...[...reactionCounts].sort((a, b) => b[1] - a[1]).map(([emoji, n]) => {
    const s = document.createElement('span');
    s.title = `${n}× ${emoji}`;
    s.append(emoji, Object.assign(document.createElement('small'), { textContent: String(n) }));
    return s;
  }));
}

// The "ao vivo" notice over the game shows who arrived and the reactions (see overlay.js)
function overlayEvent(ev) {
  window.electronAPI.overlayEvent?.(ev);
}

// ======== What viewers see when their picture stutters ========
// Every ~6 s: how many frames the capture really delivers, against the target, and what (if anything)
// limits the encoders. The room page uses it to say whether the problem is here or on their side.
let healthPipe = { inFrames: 0, at: 0 };
function reportHealth(samples) {
  if (!socket?.connected || !isStreaming) return;
  const now = performance.now();
  const secs = healthPipe.at ? (now - healthPipe.at) / 1000 : 0;
  const fps = secs > 0 ? (pipe.inFrames - healthPipe.inFrames) / secs : null;
  healthPipe = { inFrames: pipe.inFrames, at: now };
  if (fps == null) return;
  const limits = samples.filter(s => !s.idle).map(s => s.limit).filter(l => l && l !== 'none');
  const limit = limits.includes('cpu') ? 'cpu' : limits.includes('bandwidth') ? 'bandwidth' : limits.length ? 'other' : 'none';
  socket.emit('host-health', { fps: Math.round(fps), target: quality.fps, limit, away: privacyAway() || standby.active });
}

// ======== Privacy: the quick pause ========
// A "já volto" card instead of the picture, from the app or from a global shortcut (with a game in
// front). The card is drawn by the pipeline worker, so it takes effect on the very next frame.
const HOTKEY_KEY = 'fs-hotkey';
const GAME_NAME_KEY = 'fs-game-name';
const camSection = document.getElementById('cam-section');
const privacySection = document.getElementById('privacy-section');
const hotkeySelect = document.getElementById('hotkey-select');
const btnQuickPause = document.getElementById('btn-quick-pause');
const privacyStatus = document.getElementById('privacy-status');
const gameNameToggle = document.getElementById('game-name-toggle');
const privacy = { manual: false };
try {
  gameNameToggle.checked = localStorage.getItem(GAME_NAME_KEY) !== '0';
  const savedHotkey = localStorage.getItem(HOTKEY_KEY);
  if (savedHotkey !== null && [...hotkeySelect.options].some(o => o.value === savedHotkey)) hotkeySelect.value = savedHotkey;
} catch {}

const privacyAway = () => privacy.manual;
const currentWorker = () => localStream?.getVideoTracks()[0]?.pipelineWorker || null;

const cardFrog = new Image();
cardFrog.src = '/brand/frog-sleep.svg';
function awayCardCanvas() {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  g.fillStyle = '#0B1A10';
  g.fillRect(0, 0, 1280, 720);
  if (cardFrog.complete && cardFrog.naturalWidth) g.drawImage(cardFrog, 560, 160, 160, 147);
  g.textAlign = 'center';
  g.fillStyle = '#F3F8EC';
  g.font = '600 46px Fredoka, sans-serif';
  const who = nickname();
  g.fillText(who ? `${who} já volta` : 'Já volto!', 640, 400);
  g.fillStyle = '#A9C6AC';
  g.font = '28px Inter, sans-serif';
  g.fillText('A transmissão continua sozinha em instantes.', 640, 452);
  return c;
}
async function sendAwayState(worker) {
  if (!worker) return;
  if (privacyAway()) {
    try {
      const bitmap = await createImageBitmap(awayCardCanvas());
      worker.postMessage({ card: bitmap, away: privacyAway() }, [bitmap]);
      return;
    } catch {}
  }
  worker.postMessage({ away: privacyAway() });
}
function setAway() {
  sendAwayState(currentWorker());
  renderPrivacy();
  window.electronAPI.setAway?.(privacyAway());
  // Viewers hear about it at once: a still card mustn't read as a frozen stream
  if (socket?.connected && isStreaming) socket.emit('host-health', { fps: null, target: quality.fps, limit: 'none', away: privacyAway() || standby.active });
}

function renderPrivacy() {
  const live = isStreaming;
  btnQuickPause.hidden = !live;
  btnQuickPause.setAttribute('aria-pressed', String(privacy.manual));
  const key = hotkeySelect.value ? ` (${hotkeySelect.selectedOptions[0].textContent})` : '';
  document.getElementById('quick-pause-label').textContent = privacy.manual ? 'Voltar a mostrar a tela' : `Pausa rápida${key}`;
  const away = live && privacy.manual;
  privacyStatus.hidden = !away;
  privacyStatus.classList.toggle('is-away', away);
  privacyStatus.textContent = away ? 'Pausa rápida ligada: seus amigos veem "já volto".' : '';
}

// The quick pause from anywhere, a game in front included (a global shortcut, registered while live)
async function applyHotkey() {
  const accelerator = isStreaming ? hotkeySelect.value : '';
  const result = await window.electronAPI.setHotkey?.(accelerator).catch(() => null);
  if (accelerator && result && !result.ok) {
    showToast(`O atalho ${hotkeySelect.selectedOptions[0].textContent} já é usado por outro programa. Escolha outro em Privacidade.`);
  }
}
hotkeySelect.addEventListener('change', () => {
  try { localStorage.setItem(HOTKEY_KEY, hotkeySelect.value); } catch {}
  applyHotkey();
  renderPrivacy();
});
function toggleQuickPause() {
  if (!isStreaming) return;
  privacy.manual = !privacy.manual;
  setAway();
  overlayEvent({ text: privacy.manual ? 'Pausa rápida: seus amigos veem "já volto"' : 'Sua tela voltou para a transmissão', expand: true });
}
btnQuickPause.addEventListener('click', toggleQuickPause);
window.electronAPI.onPrivacyHotkey?.(toggleQuickPause);

// ======== The game's name, for viewers ========
// A window: the program it belongs to. A whole screen: the last known game seen in front on it, from
// the capture helper's foreground watcher (which runs only then).
let currentGame = null;
const fgWatch = { source: null, supported: false };
function setGame(name) {
  if (currentGame === name) return;
  currentGame = name;
  sendGame();
}
function sendGame() {
  if (socket?.connected && isStreaming) socket.emit('set-game', { game: gameNameToggle.checked ? currentGame : null });
}

function onForeground(fg) {
  if (!isStreaming || !fgWatch.source || !fg?.onCaptured) return;
  const name = gameNameFor(fg.exe);
  if (name) setGame(name);
}
window.electronAPI.onForeground?.(onForeground);

function syncForegroundWatch() {
  const want = fgWatch.supported && isStreaming && currentSource.isScreen && gameNameToggle.checked;
  const source = want ? currentSource.id : null;
  if (source === fgWatch.source) return;
  fgWatch.source = source;
  window.electronAPI.watchForeground?.(source)?.catch?.(() => {});
}

gameNameToggle.addEventListener('change', () => {
  try { localStorage.setItem(GAME_NAME_KEY, gameNameToggle.checked ? '1' : '0'); } catch {}
  sendGame();
  syncForegroundWatch();
});
async function updateGameFromSource() {
  // A whole screen: named once the watcher sees a known game in front
  if (currentSource.isScreen) { setGame(null); return; }
  const id = currentSource.id;
  const owner = id ? await window.electronAPI.getWindowOwner(id).catch(() => null) : null;
  if (currentSource.id === id) setGame(owner ? gameNameFor(owner.name) : null);
}

// ======== Camera in a corner ========
// Composited into the stream by the pipeline worker (one drawImage per frame), so it costs little and
// follows any change of window. Hidden while "já volto" is up.
const CAM_KEY = 'fs-cam';
// Anywhere and any size, like in OBS: dragged on the preview while live, or from the corner and size
// shortcuts. w is the camera's width as a share of the picture's; x and y place it between the edges
// (0 = left or top, 1 = right or bottom). 1.7.0 saved a corner and a size instead.
const CAM_SIZES = { s: 0.2, m: 0.28, l: 0.38 };
const CAM_CORNERS = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] };
const cam = (() => {
  const saved = store.get(CAM_KEY) || {};
  const corner = CAM_CORNERS[saved.pos] || CAM_CORNERS.br;
  const num = (v, fallback) => Number.isFinite(v) ? v : fallback;
  return {
    enabled: !!saved.enabled, deviceId: saved.deviceId || '', track: null,
    x: num(saved.x, corner[0]), y: num(saved.y, corner[1]), w: num(saved.w, CAM_SIZES[saved.size] || CAM_SIZES.m)
  };
})();
const camToggle = document.getElementById('cam-toggle');
const camOptions = document.getElementById('cam-options');
const camDevice = document.getElementById('cam-device');
const camNote = document.getElementById('cam-note');
const camLayout = () => ({ x: cam.x, y: cam.y, w: cam.w });
function saveCam() { store.set(CAM_KEY, { enabled: cam.enabled, deviceId: cam.deviceId, x: cam.x, y: cam.y, w: cam.w }); }
function setCamLayout(next, save = true) {
  Object.assign(cam, next);
  cam.x = Math.min(1, Math.max(0, cam.x));
  cam.y = Math.min(1, Math.max(0, cam.y));
  cam.w = Math.min(0.6, Math.max(0.1, cam.w));
  currentWorker()?.postMessage({ camLayout: camLayout() });
  if (save) { saveCam(); renderCam(); }
}

function attachCam(worker) {
  if (!worker || !cam.track || cam.track.readyState !== 'live') return;
  try {
    // A clone per worker: each one reads (and ends) its own
    const clone = cam.track.clone();
    const processor = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 });
    for (const t of worker.camClones || []) t.stop();
    worker.camClones = [clone];
    worker.postMessage({ cam: processor.readable, camLayout: camLayout() }, [processor.readable]);
  } catch (err) {
    reportError('Camera attach failed: ' + err.message, err.stack);
  }
}
function attachWorkerExtras(worker) {
  if (privacyAway()) sendAwayState(worker);
  if (cam.track) attachCam(worker);
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
    ? 'O Windows bloqueou a câmera. Libere em Configurações > Privacidade e segurança > Câmera.'
    : err.name === 'NotReadableError' ? 'A câmera está sendo usada por outro programa.' : 'Não deu para abrir a câmera: ' + err.message;
}
async function startCam() {
  if (cam.track) return;
  try {
    const stream = await openCamera();
    cam.track = stream.getVideoTracks()[0];
    cam.deviceId = cam.track.getSettings().deviceId || cam.deviceId;
    camNote.textContent = '';
    cam.track.addEventListener('ended', () => { if (cam.track?.readyState === 'ended') { cam.track = null; camNote.textContent = 'A câmera foi desligada.'; } });
    if (!isStreaming) { stopCam(); return; }
    attachCam(currentWorker());
    loadCamDevices();
  } catch (err) {
    camError(err);
  }
}
function stopCam() {
  if (cam.track) { cam.track.stop(); cam.track = null; }
  const worker = currentWorker();
  if (worker) {
    worker.postMessage({ cam: null });
    for (const t of worker.camClones || []) t.stop();
    worker.camClones = [];
  }
}
async function loadCamDevices() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    camDevice.replaceChildren(...devices.map((d, i) => Object.assign(document.createElement('option'), {
      value: d.deviceId, textContent: d.label || `Câmera ${i + 1}`, selected: d.deviceId === cam.deviceId
    })));
    if (!devices.length) camNote.textContent = 'Nenhuma câmera encontrada.';
  } catch {}
}
function renderCam() {
  camToggle.checked = cam.enabled;
  camOptions.hidden = !cam.enabled;
  // A shortcut stays lit only while the camera is exactly there (a drag puts it somewhere in between)
  document.querySelectorAll('input[name="cam-pos"]').forEach(r => { r.checked = CAM_CORNERS[r.value][0] === cam.x && CAM_CORNERS[r.value][1] === cam.y; });
  document.querySelectorAll('input[name="cam-size"]').forEach(r => { r.checked = Math.abs(CAM_SIZES[r.value] - cam.w) < 0.005; });
}
camToggle.addEventListener('change', async () => {
  cam.enabled = camToggle.checked;
  saveCam();
  renderCam();
  if (!cam.enabled) { stopCam(); return; }
  if (isStreaming) { await startCam(); return; }
  // Not live yet: open it once, to ask for permission and to learn the cameras' names
  try {
    const stream = await openCamera();
    stream.getTracks().forEach(t => t.stop());
    camNote.textContent = 'A câmera aparece quando você começar a transmitir.';
    loadCamDevices();
  } catch (err) {
    camError(err);
  }
});
camDevice.addEventListener('change', () => {
  cam.deviceId = camDevice.value;
  saveCam();
  if (isStreaming && cam.enabled) { stopCam(); startCam(); }
});
document.querySelectorAll('input[name="cam-pos"], input[name="cam-size"]').forEach(input => {
  input.addEventListener('change', () => {
    if (input.name === 'cam-pos') setCamLayout({ x: CAM_CORNERS[input.value][0], y: CAM_CORNERS[input.value][1] });
    else setCamLayout({ w: CAM_SIZES[input.value] });
  });
});
renderCam();

// ---- Moving it on the preview ----
// A frame over the camera in the preview: drag it anywhere, pull its corner to change the size. It
// follows where the pipeline really drew the camera (camRect, as shares of the picture).
const camHandle = document.getElementById('cam-handle');
const camDrag = { active: null, startX: 0, startY: 0, start: null, rect: null, box: null };
// Where the picture sits inside the preview element (object-fit: contain leaves bars on two sides)
function previewBox() {
  const r = localPreview.getBoundingClientRect();
  const vw = localPreview.videoWidth, vh = localPreview.videoHeight;
  if (!vw || !vh || !r.width || !r.height) return null;
  const s = Math.min(r.width / vw, r.height / vh);
  const w = vw * s, h = vh * s;
  return { left: (r.width - w) / 2, top: (r.height - h) / 2, w, h };
}
function placeCamHandle(rect, force = false) {
  camDrag.rect = rect || null;
  if (camDrag.active) return;
  const box = rect && localPreview.srcObject && previewBox();
  // Called for every frame: only touch the page when something moved
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
  // The margin the pipeline keeps around the camera, as shares of the picture
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
  // The same placement in the pipeline's terms: between the edges, minus the margins
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
if (cam.enabled) loadCamDevices();

// ======== Live extras on and off ========
function startLiveExtras() {
  reactionCounts.clear();
  renderReactions();
  lowViewers.clear();
  privacy.manual = false;
  healthPipe = { inFrames: pipe.inFrames, at: performance.now() };
  syncForegroundWatch();
  applyHotkey();
  if (cam.enabled) startCam();
  updateGameFromSource();
  sendGame();
  renderPrivacy();
  renderLinkCard();
  renderViewerList();
}
function stopLiveExtras() {
  stopCam();
  privacy.manual = false;
  syncForegroundWatch();
  applyHotkey();
  window.electronAPI.setAway?.(false);
  currentGame = null;
  lowViewers.clear();
  viewerList = [];
  renderViewerList();
  renderPrivacy();
  setTimeout(renderLinkCard);
}
function sourceChanged() {
  syncForegroundWatch();
  updateGameFromSource();
}

window.electronAPI.getPlatform().then(p => {
  // The foreground watcher is part of the Windows capture helper
  fgWatch.supported = p === 'win32' && typeof window.electronAPI.watchForeground === 'function';
});
renderPrivacy();
fixedRoom().then(renderLinkCard).catch(() => renderLinkCard());

// ======== Init ========
initPermissions();
loadSources();
loadAudioSessions();
renderQualityControls();
checkForUpdate();
// For sessions left open for days: look again every few hours
setInterval(checkForUpdate, 6 * 3600 * 1000);

// Wake the Render free-tier server early so "Iniciar" doesn't wait on a cold start. It sleeps after
// 15 idle minutes and the app can stay open for days, so also wake it when the window gets focus
// (someone about to start), at most every 10 minutes. While live, Socket.IO's pings keep it awake.
let lastWarmAt = 0;
function warmServer() {
  if (Date.now() - lastWarmAt < 10 * 60 * 1000) return;
  lastWarmAt = Date.now();
  getSignalUrl().then(url => {
    fetch(`${url}/health`).catch(() => {});
    getIceConfig();
  });
}
warmServer();
window.electronAPI.onWindowFocus((focused) => { if (focused && !isStreaming) warmServer(); });
