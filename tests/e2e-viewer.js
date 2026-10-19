// 1.7 viewer page checks against the local server, with stand-in streamers (small canvas streams) and
// viewers in hidden windows. Every window is muted: nothing plays on the speakers.
// Usage: npx electron tests/e2e-viewer.js [base url, default http://127.0.0.1:3041]
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const BASE = process.argv.find(a => /^https?:\/\//.test(a)) || 'http://127.0.0.1:3041';
const DL = path.join(require('os').tmpdir(), 'frogshare-e2e-downloads');
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
app.on('window-all-closed', () => {});

const HOST_JS = (opts) => `(async () => {
  const opts = ${JSON.stringify(opts)};
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/socket.io/socket.io.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d');
  setInterval(() => { g.fillStyle = opts.color; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.fillRect((Date.now() / 8) % 300, 80, 20, 20); }, 66);
  const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
  const gain = ac.createGain(); gain.gain.value = opts.loud ? 0.5 : 0;
  const o = ac.createOscillator(); o.connect(gain); gain.connect(dest); o.start();
  const stream = new MediaStream([c.captureStream(15).getVideoTracks()[0], dest.stream.getAudioTracks()[0]]);
  const pcs = new Map(); let seq = 0;
  window.events = { viewerList: [], reactions: [], quality: [], left: [] };
  const socket = io({ transports: ['websocket'] }); window.hostSocket = socket;
  socket.on('connect', () => {
    socket.emit('join-room', opts.guest ? { roomId: opts.room, asHost: true, coHost: true, name: opts.name, appVersion: '1.7.0' } : { roomId: opts.room, asHost: true, hostKey: opts.hostKey, name: opts.name, appVersion: '1.7.0' });
    if (!opts.guest && opts.group) socket.emit('group-mode', { enabled: true });
    if (opts.game) socket.emit('set-game', { game: opts.game });
  });
  socket.on('viewer-list', d => events.viewerList.push(d.viewers));
  socket.on('reaction', d => events.reactions.push(d));
  socket.on('viewer-quality', d => events.quality.push(d));
  socket.on('viewer-left', d => events.left.push(d.viewerId));
  socket.on('viewer-joined', async ({ viewerId }) => {
    if (pcs.get(viewerId)) pcs.get(viewerId).close();
    const pc = new RTCPeerConnection(); pc.sid = ++seq; pc.pending = []; pcs.set(viewerId, pc);
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onicecandidate = e => e.candidate && socket.emit('ice-candidate', { to: viewerId, candidate: e.candidate, sid: pc.sid });
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    socket.emit('offer', { to: viewerId, offer, sid: pc.sid });
  });
  socket.on('answer', async ({ from, answer, sid }) => { const pc = pcs.get(from); if (pc && pc.sid === sid) { await pc.setRemoteDescription(answer); pc.pending.splice(0).forEach(x => pc.addIceCandidate(x)); } });
  socket.on('ice-candidate', ({ from, candidate, sid }) => { const pc = pcs.get(from); if (!pc || pc.sid !== sid) return; if (pc.remoteDescription) pc.addIceCandidate(candidate); else pc.pending.push(candidate); });
  return true;
})()`;

const downloads = [];
function mk(partition) {
  const w = new BrowserWindow({ show: false, width: 1280, height: 760, webPreferences: { offscreen: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', partition } });
  w.webContents.setAudioMuted(true);
  return w;
}
function watchDownloads(partition) {
  session.fromPartition(partition).on('will-download', (e, item) => {
    const file = path.join(DL, item.getFilename());
    item.setSavePath(file);
    item.once('done', (ev, state) => downloads.push({ name: item.getFilename(), state, size: fs.existsSync(file) ? fs.statSync(file).size : 0, file }));
  });
}
const js = (w, code) => w.webContents.executeJavaScript(code);
async function until(w, code, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await js(w, code)) return true; } catch {} await wait(250); }
  return false;
}
async function key(w, k) { await js(w, `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })); true`); }

app.whenReady().then(async () => {
  try {
    // ---------- One streamer ----------
    const { roomId, hostKey } = await (await fetch(BASE + '/api/room/create')).json();
    const host = mk('host-' + Date.now()); await host.loadURL(BASE + '/'); await js(host, HOST_JS({ room: roomId, hostKey, name: 'Igor', color: '#1fa83a', game: 'Deadlock' }));
    await wait(700);

    const P1 = 'v1-' + Date.now();
    watchDownloads(P1);
    const v1 = mk(P1);
    await v1.loadURL(`${BASE}/s/${roomId}`);
    check('link curto /s/<sala> abre a sala e mostra o vídeo', await until(v1, `document.body.dataset.state === 'live'`));
    const defName = await js(v1, `localStorage.getItem('fs-viewer-name')`);
    check('quem assiste ganha um nome automático', /^Sapo \d{3}$/.test(defName), defName);
    await wait(500);
    const lists = await js(host, `events.viewerList`);
    check('quem transmite recebe o nome automático', lists.some(l => l.some(v => v.name === defName)));

    await js(v1, `document.getElementById('btn-viewers').click(); document.getElementById('viewer-name').value = 'Ana'; document.getElementById('name-form').requestSubmit(); true`);
    await wait(500);
    check('trocar o nome pela lista de quem assiste', (await js(host, `events.viewerList.at(-1)`)).some(v => v.name === 'Ana'));
    const extrasShown = await js(v1, `!document.getElementById('player-extras').hidden && !document.getElementById('more-wrap').hidden`);
    check('botões novos aparecem com o vídeo na tela', extrasShown);

    // Reactions
    await js(v1, `document.getElementById('btn-react').click(); document.querySelector('.react-btn').click(); true`);
    await wait(400);
    const r1 = await js(host, `events.reactions`);
    check('reação chega a quem transmite com o nome', r1.some(r => r.emoji === '🔥' && r.name === 'Ana'), JSON.stringify(r1));
    check('a própria reação sobe na tela de quem mandou', await js(v1, `document.querySelectorAll('#reaction-layer .reaction.mine').length > 0`));

    const P2 = 'v2-' + Date.now();
    const v2 = mk(P2);
    await v2.loadURL(`${BASE}/room.html?room=${roomId}`);
    await until(v2, `document.body.dataset.state === 'live'`);
    await js(v1, `document.querySelectorAll('.react-btn')[1].click(); true`);
    check('outra pessoa vê a reação com o nome de quem mandou', await until(v2, `[...document.querySelectorAll('#reaction-layer .reaction')].some(el => el.textContent.includes('😂') && el.textContent.includes('Ana'))`, 3000));

    // Data saver and levelled sound
    await js(v1, `document.getElementById('btn-more').click(); document.getElementById('opt-data-saver').click(); true`);
    await wait(500);
    check('economizar dados pede a cópia leve a quem transmite', (await js(host, `events.quality`)).some(q => q.low === true));
    await js(v1, `document.getElementById('opt-levelling').click(); true`);
    await wait(600);
    const lev = await js(v1, `({ on: audioFx.levelling, vol: remoteVideo.volume, nodes: audioFx.nodes.size, gain: [...audioFx.nodes.values()][0]?.out.gain.value, ctx: audioFx.ctx?.state })`);
    check('volume equilibrado: o som sai pelo compressor', lev.on && lev.vol === 0 && lev.nodes === 1 && lev.gain > 0.9 && lev.ctx === 'running', JSON.stringify(lev));
    await js(v1, `document.getElementById('opt-levelling').click(); true`);
    await wait(300);
    check('desligar volta o som pelo vídeo', await js(v1, `remoteVideo.volume > 0.9 && !audioFx.levelling`));

    // Print and clip
    await js(v1, `document.body.click(); true`);
    await key(v1, 'p');
    await wait(1500);
    const png = downloads.find(d => /\.png$/.test(d.name));
    const sig = png && fs.readFileSync(png.file).subarray(0, 4).toString('hex');
    check('P salva um print em PNG', png && png.size > 500 && sig === '89504e47', png ? `${png.name} ${png.size} bytes` : 'nenhum download');
    // A 3 s clip out of ~8 s recorded: the cut and the clocks moved back to zero are what's checked
    await js(v1, `window.fsClipSeconds = 3; document.getElementById('btn-more').click(); document.getElementById('opt-clips').click(); document.body.click(); true`);
    check('ligar clipes mostra o botão de clipe', await until(v1, `!document.getElementById('btn-clip').hidden`, 3000));
    await wait(8000);
    await key(v1, 'c');
    await wait(4500);
    const clip = downloads.find(d => /clipe.*\.(mp4|webm)$/.test(d.name));
    check('C salva um clipe dos últimos segundos', clip && clip.size > 5000, clip ? `${clip.name} ${clip.size} bytes` : 'nenhum download');
    if (clip) {
      // Played back on its own: starts at zero, as long as asked (not all that was recorded), no frozen stretch
      const pv = mk('clip-' + Date.now());
      const page = path.join(DL, 'tocar-clipe.html');
      fs.writeFileSync(page, `<!doctype html><video src="${encodeURIComponent(clip.name)}" muted></video>`);
      await pv.loadFile(page);
      const play = await js(pv, `(async () => {
        const v = document.querySelector('video'); v.muted = true;
        if (v.readyState < 1) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
        const times = []; let first = null;
        const tick = (now, meta) => { times.push(now); if (first === null) first = meta.mediaTime; if (times.length < 400) v.requestVideoFrameCallback(tick); };
        v.requestVideoFrameCallback(tick);
        await v.play();
        await new Promise(r => setTimeout(r, 2000));
        const gaps = times.slice(1).map((t, i) => t - times[i]);
        return { duration: Math.round(v.duration * 10) / 10, frames: times.length, maxGapMs: Math.round(Math.max(0, ...gaps)), firstFrameAt: Math.round((first || 0) * 100) / 100 };
      })()`).catch(err => ({ error: err.message }));
      check('o clipe abre do começo, só com o trecho pedido, e toca sem travar',
        play.duration >= 2 && play.duration <= 7 && play.firstFrameAt < 0.5 && play.frames >= 18 && play.maxGapMs < 400, JSON.stringify(play));
      pv.destroy();
    }

    // Zoom, cinema, shortcuts
    await js(v1, `const a = document.getElementById('video-area'); const r = a.getBoundingClientRect(); a.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); true`);
    const z = await js(v1, `({ t: remoteVideo.style.transform, chip: !document.getElementById('zoom-chip').hidden, vol: masterVolume })`);
    check('Ctrl + roda aproxima a imagem (sem mexer no volume)', /scale\(/.test(z.t) && z.chip && z.vol === 1, JSON.stringify(z));
    await key(v1, 'z');
    check('Z volta ao tamanho normal', await js(v1, `remoteVideo.style.transform === '' && document.getElementById('zoom-chip').hidden`));
    await key(v1, 't');
    check('T liga o modo cinema (some o cabeçalho)', await js(v1, `document.body.classList.contains('cinema') && getComputedStyle(document.querySelector('.room-top')).display === 'none'`));
    await key(v1, 't');
    await key(v1, '?');
    check('? abre a lista de atalhos', await js(v1, `!document.getElementById('shortcuts').hidden`));
    await key(v1, 'Escape');
    check('Esc fecha a lista de atalhos', await js(v1, `document.getElementById('shortcuts').hidden`));

    // Why it stutters
    const d1 = await js(v1, `(() => {
      hostHealth.set(selectedId, { fps: 18, target: 60, limit: 'none', away: false, at: Date.now() });
      for (let i = 0; i < 6; i++) diagnose({ freezes: 1, freezeMs: 400, packets: 200, lost: 0, rttMs: 40, decoded: 30, dropped: 0, decodeMs: 3, fps: 18 });
      return { level: diag.level, reason: diag.reason, bubble: !document.getElementById('diag-bubble').hidden, text: document.getElementById('diag-text').textContent, dot: btnInfo.dataset.diag };
    })()`);
    check('travando sem perda de pacotes: explica que é o PC de quem transmite', d1.reason === 'host-capture' && d1.bubble && /PC de quem transmite/.test(d1.text) && d1.dot !== 'ok', JSON.stringify(d1));
    const d2 = await js(v1, `(() => {
      for (let i = 0; i < 6; i++) diagnose({ freezes: 1, freezeMs: 300, packets: 200, lost: 12, rttMs: 60, decoded: 30, dropped: 0, decodeMs: 3, fps: 20 });
      return { reason: diag.reason, text: diag.text };
    })()`);
    check('travando com perda: explica que é a internet de quem assiste', d2.reason === 'network-loss' && /Sua internet/.test(d2.text), JSON.stringify(d2));

    // Removing someone, locking the room
    const v2id = await js(v2, `socket.id`);
    await js(host, `hostSocket.emit('kick-viewer', { viewerId: ${JSON.stringify(v2id)} }); true`);
    check('quem foi tirado vê que foi removido', await until(v2, `document.body.dataset.state === 'kicked'`, 5000), await js(v2, `document.getElementById('status-text').textContent`));
    await js(host, `hostSocket.emit('lock-room', { locked: true }); true`);
    await wait(300);
    const v3 = mk('v3-' + Date.now());
    await v3.loadURL(`${BASE}/s/${roomId}`);
    check('sala trancada: gente nova vê que está trancada', await until(v3, `document.body.dataset.state === 'locked'`, 8000));
    await js(host, `hostSocket.emit('lock-room', { locked: false }); true`);
    check('destrancada: entra sozinho na próxima tentativa', await until(v3, `document.body.dataset.state === 'live'`, 22000));

    // Home: recent rooms; link preview
    await v1.loadURL(BASE + '/');
    check('início mostra a sala assistida, ao vivo', await until(v1, `!document.getElementById('recent').hidden && document.querySelector('.recent-item.is-live')?.textContent.includes('Sala de Igor')`, 6000),
      await js(v1, `document.getElementById('recent-list').textContent`));
    const page = await (await fetch(`${BASE}/s/${roomId}`)).text();
    check('prévia do link: nome, ao vivo e jogo', /og:title" content="Igor está ao vivo no FrogShare"/.test(page) && /Jogando Deadlock/.test(page));
    for (const w of [v1, v2, v3, host]) w.destroy();

    // ---------- Group: the mixer and the frogs that light up ----------
    const g = await (await fetch(BASE + '/api/room/create')).json();
    const owner = mk('o-' + Date.now()); await owner.loadURL(BASE + '/'); await js(owner, HOST_JS({ room: g.roomId, hostKey: g.hostKey, name: 'Igor', color: '#1fa83a', group: true }));
    await wait(700);
    const guest = mk('g-' + Date.now()); await guest.loadURL(BASE + '/'); await js(guest, HOST_JS({ room: g.roomId, guest: true, name: 'Tutu', color: '#2050e0', loud: true }));
    await wait(700);
    const v4 = mk('v4-' + Date.now());
    await v4.loadURL(`${BASE}/s/${g.roomId}`);
    await until(v4, `document.body.dataset.state === 'live' && document.querySelectorAll('.stream-item').length === 2 && [...channels.values()].every(c => c.stream)`, 20000);
    check('grupo: cada transmissão tem seu volume', await js(v4, `document.querySelectorAll('.stream-item .stream-vol').length === 2`));
    await js(v4, `const row = [...document.querySelectorAll('.stream-item')].find(r => r.textContent.includes('Tutu')); const s = row.querySelector('.stream-vol'); s.value = '30'; s.dispatchEvent(new Event('input', { bubbles: true })); true`);
    await wait(400);
    const mix = await js(v4, `(() => { const ch = [...channels.values()].find(c => infoFor(c.hostId)?.name === 'Tutu'); return { stored: JSON.parse(localStorage.getItem('fs-mix')).Tutu, el: ch.audioEl ? +ch.audioEl.volume.toFixed(2) : (ch.stream === remoteVideo.srcObject ? +remoteVideo.volume.toFixed(2) : null) }; })()`);
    check('mexer no volume de uma transmissão muda só ela', mix.stored === 0.3 && mix.el === 0.3, JSON.stringify(mix));
    check('o sapo de quem está com som acende', await until(v4, `[...document.querySelectorAll('.stream-item.speaking')].some(r => r.textContent.includes('Tutu')) && ![...document.querySelectorAll('.stream-item.speaking')].some(r => r.textContent.includes('Igor'))`, 6000));
    for (const w of [v4, owner, guest]) w.destroy();
  } catch (err) {
    console.error(err);
    results.push(false);
  }
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok} de ${results.length} passaram`);
  app.exit(results.every(Boolean) ? 0 : 1);
});
