// /transmitir checks: the browser picker is replaced by a small canvas stream (nothing on the real
// screen is captured), viewers watch through the fixed link, react, get paused, locked out and removed;
// the media server is a stand-in peer inside the host page (nothing leaves this machine).
// Every window is muted. Usage: npx electron tests/e2e-webhost.js [base url]
const { app, BrowserWindow } = require('electron');
const BASE = process.argv.find(a => /^https?:\/\//.test(a)) || 'http://127.0.0.1:3041';
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
app.on('window-all-closed', () => {});
const js = (w, code) => w.webContents.executeJavaScript(code);
async function until(w, code, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await js(w, code)) return true; } catch {} await wait(250); }
  return false;
}
function mk(partition) {
  const w = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', partition } });
  w.webContents.setAudioMuted(true);
  return w;
}
// Stands in for the screen picker: a moving canvas
const FAKE_DISPLAY = `navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d');
  setInterval(() => { g.fillStyle = '#6a3fd0'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.fillRect((Date.now() / 6) % 600, 160, 40, 40); }, 33);
  return c.captureStream(30);
}; true`;
// A still screen: drawn once, then nothing changes (a capture only sends changes)
const FAKE_STILL = `navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d');
  g.fillStyle = '#1f6f8f'; g.fillRect(0, 0, 640, 360);
  return c.captureStream(30);
}; true`;
// Stands in for the camera: a small canvas
const FAKE_CAMERA = `navigator.mediaDevices.getUserMedia = async () => {
  const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d');
  setInterval(() => { g.fillStyle = '#d04f3f'; g.fillRect(0, 0, 320, 180); }, 50);
  return c.captureStream(15);
}; true`;
// Stands in for the media server: the host page's calls to /api/sfu answer from a peer in the same page.
// The viewers' pages still ask the real local server, which has no media server, so they fall back.
const FAKE_SFU = `(() => {
  const realFetch = window.fetch.bind(window);
  window.fakeSfu = { pc: null, sessions: 0 };
  const reply = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/sfu/status')) return reply({ enabled: true });
    if (u.endsWith('/api/sfu/sessions')) { fakeSfu.sessions++; return reply({ sessionId: 'abcdef0123456789' }); }
    if (/\\/api\\/sfu\\/sessions\\/[0-9a-f]+\\/tracks$/.test(u)) {
      const body = JSON.parse(opts.body);
      const pc = new RTCPeerConnection();
      fakeSfu.pc = pc;
      await pc.setRemoteDescription(body.sessionDescription);
      await pc.setLocalDescription(await pc.createAnswer());
      await new Promise(r => { if (pc.iceGatheringState === 'complete') r(); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') r(); }); setTimeout(r, 2000); });
      return reply({ sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp }, tracks: body.tracks.map(t => ({ trackName: t.trackName, mid: t.mid })) });
    }
    return realFetch(url, opts);
  };
  return true;
})()`;
// A room owner with the group open, like the app: a bare socket and a canvas (nothing captured)
const OWNER_JS = (roomId, hostKey) => `(async () => {
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/socket.io/socket.io.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d');
  setInterval(() => { g.fillStyle = '#2f8f4f'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.fillRect((Date.now() / 6) % 600, 40, 40, 40); }, 33);
  const ac = new AudioContext();
  const stream = new MediaStream([c.captureStream(15).getVideoTracks()[0], ac.createMediaStreamDestination().stream.getAudioTracks()[0]]);
  const pcs = new Map(); let seq = 0;
  const socket = io({ transports: ['websocket'] }); window.ownerSocket = socket;
  socket.on('connect', () => {
    socket.emit('join-room', { roomId: '${roomId}', asHost: true, hostKey: '${hostKey}', name: 'Dono', appVersion: '1.7.1' });
    socket.emit('group-mode', { enabled: true });
  });
  socket.on('viewer-joined', async ({ viewerId }) => {
    if (pcs.get(viewerId)) pcs.get(viewerId).close();
    const pc = new RTCPeerConnection(); pc.sid = ++seq; pc.pending = []; pcs.set(viewerId, pc);
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onicecandidate = e => e.candidate && socket.emit('ice-candidate', { to: viewerId, candidate: e.candidate, sid: pc.sid });
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit('offer', { to: viewerId, offer: pc.localDescription, sid: pc.sid });
  });
  socket.on('answer', async ({ from, answer, sid }) => { const pc = pcs.get(from); if (pc && pc.sid === sid) { await pc.setRemoteDescription(answer); pc.pending.splice(0).forEach(x => pc.addIceCandidate(x)); } });
  socket.on('ice-candidate', ({ from, candidate, sid }) => { const pc = pcs.get(from); if (!pc || pc.sid !== sid) return; if (pc.remoteDescription) pc.addIceCandidate(candidate); else pc.pending.push(candidate); });
  return true;
})()`;
const watching = `document.body.dataset.state === 'live' && remoteVideo.videoWidth > 0`;

app.whenReady().then(async () => {
  try {
    // The address: /transmitir. The old one (with .html), a trailing slash or capitals lead there, the group kept
    const moved = async p => { const r = await fetch(BASE + p, { redirect: 'manual' }); return `${r.status} ${r.headers.get('location')}`; };
    const olds = [await moved('/transmitir.html?grupo=abc'), await moved('/transmitir/'), await moved('/Transmitir')];
    check('o endereço antigo leva para /transmitir, com o grupo', olds.join(' | ') === '301 /transmitir?grupo=abc | 301 /transmitir | 301 /transmitir', olds.join(' | '));
    const pagePolicy = (await fetch(BASE + '/transmitir')).headers.get('permissions-policy') || '';
    const homePolicy = (await fetch(BASE + '/')).headers.get('permissions-policy') || '';
    check('a câmera continua liberada só em /transmitir', pagePolicy.includes('camera=(self)') && homePolicy.includes('camera=()'), `${pagePolicy} | ${homePolicy}`);

    const PH = 'wh-' + Date.now();
    const host = mk(PH);
    await host.loadURL(BASE + '/transmitir');
    check('a página de transmitir abre', await until(host, `document.body.dataset.state === 'setup' && !document.getElementById('wh-start').disabled`, 5000));
    check('o link fixo aparece antes de começar, como no app', await until(host, `/\\/s\\/[0-9a-f]{8}$/.test(document.getElementById('wh-link-text').textContent)`, 5000),
      await js(host, `document.getElementById('wh-link-text').textContent`));
    check('a câmera aparece como opção (navegador com o caminho pela placa de vídeo)', await js(host, `!document.getElementById('wh-cam-section').hidden`));

    // A name of its own for the link
    const NAME = 'web-teste-' + Math.floor(Math.random() * 1e6);
    await js(host, `document.getElementById('wh-edit-link').click(); document.getElementById('wh-link-name').value = '${NAME}'; document.getElementById('wh-link-form').requestSubmit(); true`);
    check('dá para escolher o nome do link', await until(host, `document.getElementById('wh-link-text').textContent.endsWith('/s/${NAME}')`, 5000),
      await js(host, `document.getElementById('wh-link-text').textContent`));

    await js(host, FAKE_DISPLAY);
    await js(host, `document.getElementById('wh-name').value = 'Navegador Teste'; document.getElementById('wh-game').value = 'Jogo Teste'; document.getElementById('wh-start').click(); true`);
    check('começa a transmitir no link escolhido', await until(host, `document.body.dataset.state === 'live' && document.getElementById('wh-link').value.endsWith('/s/${NAME}')`, 10000));
    check('a imagem passa pelo worker (placa de vídeo, tamanho, câmera, pausa)', await until(host, `!!webHost.pipe && webHost.pipeInfo.outFrames > 0`, 5000), await js(host, `JSON.stringify(webHost.pipeInfo)`));
    check('qualidade e câmera vão para baixo da prévia, como no app', await js(host, `document.getElementById('wh-main').contains(document.getElementById('wh-quality-section'))`));
    const link = await js(host, `document.getElementById('wh-link').value`);
    const saved = await js(host, `localStorage.getItem('fs-web-room')`);

    const viewer = mk('whv-' + Date.now());
    await viewer.loadURL(link);
    check('quem assiste pelo link vê o vídeo do navegador', await until(viewer, watching, 15000), await js(viewer, `remoteVideo.videoWidth + 'x' + remoteVideo.videoHeight`));
    check('sem aviso de "versão antiga" para quem transmite pelo navegador', await js(viewer, `hostOutdatedNow === false && !document.querySelector('.host-notice')`));
    check('o jogo aparece para quem assiste', await until(viewer, `document.getElementById('stage-game').textContent === 'Jogando Jogo Teste'`, 5000), await js(viewer, `document.getElementById('stage-game').textContent`));
    check('vai em H264, o que a placa de vídeo codifica (não VP8 no processador)', await until(host, `webHost.samples.some(s => /H264/i.test(s.codec))`, 10000), await js(host, `JSON.stringify(webHost.samples)`));
    check('quem transmite vê quantos assistem', await until(host, `document.getElementById('wh-count').textContent.startsWith('1 ')`, 5000));
    check('e quem está assistindo, com "Expulsar"', await until(host, `document.querySelectorAll('#wh-viewer-list .viewer-kick').length === 1`, 5000));
    await js(viewer, `document.getElementById('btn-react').click(); document.querySelector('.react-btn').click(); true`);
    check('reações aparecem para quem transmite pelo navegador', await until(host, `document.getElementById('wh-reactions').textContent.includes('🔥')`, 4000));
    const og = await (await fetch(link)).text();
    check('prévia do link com o nome de quem transmite pelo navegador', /og:title" content="Navegador Teste está ao vivo no FrogShare"/.test(og));

    // A busy PC: the worker makes ~55 frames a second, the encoder sends 30 -> 30 fps by itself, then 60 again
    const auto = await js(host, `(() => {
      const busy = [{ id: 'x', sfu: false, idle: false, ageMs: 60000, fps: 30, limit: 'none' }];
      const tick = () => { webHost.loadPipe = { outFrames: webHost.pipeInfo.outFrames - 110, at: performance.now() - 2000 }; webHost.updateAutoFps(busy); };
      Object.assign(webHost.autoFps, { active: false, overTicks: 0, backoffMs: 180000, lastOffAt: 0 });
      for (let i = 0; i < 4; i++) tick();
      const notYet = !webHost.autoFps.active;
      tick();
      const on = webHost.autoFps.active && webHost.effFps() === 30 && /30 fps/.test(document.getElementById('wh-quality-hint').textContent);
      webHost.autoFps.retryAt = Date.now() - 1;
      tick();
      const back = !webHost.autoFps.active && webHost.effFps() === webHost.quality.fps;
      return { notYet, on, back, preset: webHost.quality.fps };
    })()`);
    check('PC ocupado: a transmissão pelo navegador cai para 30 fps e depois tenta 60 de novo', auto.notYet && auto.on && auto.back && auto.preset === 60, JSON.stringify(auto));

    // The camera over the picture, dragged on the preview
    await js(host, FAKE_CAMERA);
    await js(host, `document.getElementById('wh-cam-toggle').click(); true`);
    check('câmera por cima da imagem, com a moldura para arrastar', await until(host, `!document.getElementById('wh-cam-handle').hidden`, 6000));
    await js(host, `document.getElementById('wh-cam-toggle').click(); true`);
    check('desligar a câmera tira a moldura', await until(host, `document.getElementById('wh-cam-handle').hidden`, 4000));

    // The quick pause
    await js(host, `document.getElementById('wh-pause').click(); true`);
    check('pausa rápida: quem assiste fica sabendo (não parece travado)', await until(viewer, `[...hostHealth.values()].some(h => h.away)`, 5000));
    await wait(1500);
    check('pausa rápida: a imagem continua chegando (o cartão "já volto")', await js(viewer, watching));
    await js(host, `document.getElementById('wh-pause').click(); true`);
    check('voltar da pausa rápida', await until(viewer, `![...hostHealth.values()].some(h => h.away)`, 8000));

    // Stop and come back: same room, the viewer gets the picture again
    await js(host, `document.getElementById('wh-stop').click(); true`);
    check('parar deixa quem assiste esperando (pausado)', await until(viewer, `document.body.dataset.state === 'paused'`, 8000), await js(viewer, `document.body.dataset.state`));
    await js(host, FAKE_DISPLAY);
    await js(host, `document.getElementById('wh-start').click(); true`);
    check('voltar a transmitir: a mesma pessoa vê de novo, sem recarregar', await until(viewer, watching, 15000));
    check('o link continua o mesmo', (await js(host, `document.getElementById('wh-link').value`)) === link && (await js(host, `localStorage.getItem('fs-web-room')`)) === saved);

    // Locking the room, removing someone
    await js(host, `document.getElementById('wh-lock').click(); true`);
    await wait(400);
    const v2 = mk('whv2-' + Date.now());
    await v2.loadURL(link);
    check('sala trancada pelo navegador: gente nova não entra', await until(v2, `document.body.dataset.state === 'locked'`, 8000), await js(v2, `document.body.dataset.state`));
    v2.destroy();
    await js(host, `document.getElementById('wh-lock').click(); true`);
    await js(host, `document.querySelector('#wh-viewer-list .viewer-kick').click(); true`);
    const kick1 = await js(host, `document.querySelector('#wh-viewer-list .viewer-kick').textContent`);
    const still1 = await js(viewer, `document.body.dataset.state`);
    check('o primeiro clique em "Expulsar" só pede confirmação', kick1 === 'Expulsar mesmo?' && still1 === 'live', `${kick1} / ${still1}`);
    await js(host, `document.querySelector('#wh-viewer-list .viewer-kick').click(); true`);
    check('expulsar pelo navegador', await until(viewer, `document.body.dataset.state === 'kicked'`, 5000));
    check('aparece "Deixar voltar quem eu expulsei"', await until(host, `!document.getElementById('wh-clear-bans').hidden`, 4000));
    await js(host, `document.getElementById('wh-clear-bans').click(); true`);
    host.destroy();
    viewer.destroy();

    // ======== A still screen: whoever arrives later still gets the picture ========
    const still = mk('whs-' + Date.now());
    await still.loadURL(BASE + '/transmitir');
    await until(still, `document.body.dataset.state === 'setup' && !!document.getElementById('wh-link-text').textContent.match(/\\/s\\//)`, 5000);
    await js(still, FAKE_STILL);
    await js(still, `document.getElementById('wh-start').click(); true`);
    await until(still, `document.body.dataset.state === 'live'`, 10000);
    await wait(3000);
    const stillLink = await js(still, `document.getElementById('wh-link').value`);
    const sv = mk('whsv-' + Date.now());
    await sv.loadURL(stillLink);
    check('tela parada: quem chega depois vê a imagem mesmo assim', await until(sv, watching, 12000), await js(sv, `document.body.dataset.state + ' ' + remoteVideo.videoWidth`));
    still.destroy();
    sv.destroy();

    // ======== Three viewers: one copy to the media server (a stand-in), direct for whoever can't reach it ========
    const big = mk('whb-' + Date.now());
    await big.loadURL(BASE + '/transmitir');
    await until(big, `document.body.dataset.state === 'setup' && !!document.getElementById('wh-link-text').textContent.match(/\\/s\\//)`, 5000);
    await js(big, FAKE_DISPLAY);
    await js(big, FAKE_SFU);
    await js(big, `document.getElementById('wh-start').click(); true`);
    await until(big, `document.body.dataset.state === 'live'`, 10000);
    const bigLink = await js(big, `document.getElementById('wh-link').value`);
    const crowd = [];
    for (let i = 0; i < 3; i++) {
      const w = mk(`whc${i}-` + Date.now());
      await w.loadURL(bigLink);
      crowd.push(w);
    }
    check('com 3 assistindo, publica uma cópia só no servidor de mídia', await until(big, `webHost.sfu.active && !!fakeSfu.pc`, 25000), await js(big, `JSON.stringify({ active: webHost.sfu.active, sessions: fakeSfu.sessions })`));
    check('o servidor de mídia recebe a imagem', await until(big, `(async () => { for (const r of (await fakeSfu.pc.getStats()).values()) if (r.type === 'inbound-rtp' && r.kind === 'video' && r.bytesReceived > 20000) return true; return false; })()`, 10000));
    check('o painel da sala diz que está no servidor de mídia', await until(big, `document.getElementById('wh-fact-mode').textContent.startsWith('Servidor de mídia')`, 5000));
    await wait(9000);
    let all = true;
    for (const w of crowd) all = all && await js(w, watching);
    check('quem não alcança o servidor de mídia continua vendo direto', all);
    for (const w of [big, ...crowd]) w.destroy();

    // ======== Joining a friend's group from the browser ========
    const { roomId: groupId, hostKey: groupKey } = await (await fetch(BASE + '/api/room/create')).json();
    const owner = mk('who-' + Date.now());
    await owner.loadURL(BASE + '/');
    await js(owner, OWNER_JS(groupId, groupKey));
    const gv = mk('whgv-' + Date.now());
    await gv.loadURL(`${BASE}/s/${groupId}`);
    check('grupo aberto: o botão de compartilhar oferece entrar pelo navegador', await until(gv, `!document.getElementById('share-dot').hidden && !document.getElementById('share-group').hidden && document.getElementById('btn-share-web').getAttribute('href') === '/transmitir?grupo=${groupId}' && document.getElementById('share-owner').textContent === 'Dono'`, 15000));
    check('com uma pessoa só transmitindo, não há lista do lado', await js(gv, `document.getElementById('stream-list').hidden`));
    const guest = mk('whg-' + Date.now());
    // An invite saved before the address changed still works
    await guest.loadURL(`${BASE}/transmitir.html?grupo=${groupId}`);
    check('a página de transmitir abre no modo grupo, sem os controles do dono', await until(guest, `document.getElementById('wh-title').textContent === 'Transmitir no grupo' && getComputedStyle(document.getElementById('wh-link-card')).display === 'none'`, 5000));
    check('um convite com o endereço antigo cai em /transmitir', guest.webContents.getURL() === `${BASE}/transmitir?grupo=${groupId}`, guest.webContents.getURL());
    await js(guest, FAKE_DISPLAY);
    await js(guest, `document.getElementById('wh-name').value = 'Tutu'; document.getElementById('wh-start').click(); true`);
    check('entra no grupo do amigo, com o link da sala dele', await until(guest, `document.body.dataset.state === 'live' && document.getElementById('wh-link').value.endsWith('/s/${groupId}') && document.getElementById('wh-link-fine').textContent.startsWith('No grupo de Dono')`, 10000),
      await js(guest, `document.getElementById('wh-link-fine').textContent`));
    check('quem assiste vê as duas transmissões', await until(gv, `document.querySelectorAll('.stream-item').length === 2 && [...channels.values()].filter(c => c.stream).length === 2`, 20000),
      await js(gv, `document.querySelectorAll('.stream-item').length + ' na lista'`));
    // Watching the owner: the browser stops encoding a picture nobody looks at
    await js(gv, `select(hostsInfo.find(h => h.owner).id); true`);
    check('no grupo, quem assiste outra pessoa não recebe a imagem do navegador (só o som)', await until(guest, `webHost.watchOff.size === 1`, 8000));
    await js(guest, `document.getElementById('wh-stop').click(); true`);
    check('parar sai do grupo: fica só o dono (e a lista some)', await until(gv, `hostsInfo.length === 1 && document.getElementById('stream-list').hidden && !document.querySelector('.stream-item')`, 8000));
    check('quem está na tela aparece por cima do vídeo', await js(gv, `document.getElementById('stage-name').textContent === 'Dono' && !document.getElementById('stage-title').hidden`));
    // Closed group: the page says why instead of streaming into nothing
    await js(owner, `window.ownerSocket.emit('group-mode', { enabled: false }); true`);
    await wait(500);
    await js(guest, FAKE_DISPLAY);
    await js(guest, `document.getElementById('wh-start').click(); true`);
    check('grupo fechado: avisa e não transmite', await until(guest, `!document.getElementById('wh-group-note').hidden && document.body.dataset.state === 'setup'`, 8000),
      await js(guest, `document.getElementById('wh-group-text').textContent`));
    for (const w of [owner, gv, guest]) w.destroy();
  } catch (err) {
    console.error(err);
    results.push(false);
  }
  console.log(`\n${results.filter(Boolean).length} de ${results.length} passaram`);
  app.exit(results.every(Boolean) ? 0 : 1);
});
