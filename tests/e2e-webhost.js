// transmitir.html checks: the browser picker is replaced by a small canvas stream (nothing on the real
// screen is captured), a viewer watches through the fixed link, reacts and asks for the light copy.
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

app.whenReady().then(async () => {
  try {
    const PH = 'wh-' + Date.now();
    const host = mk(PH);
    await host.loadURL(BASE + '/transmitir.html');
    check('a página de transmitir abre', await until(host, `document.body.dataset.state === 'setup' && !document.getElementById('wh-start').disabled`, 5000));
    await js(host, FAKE_DISPLAY);
    await js(host, `document.getElementById('wh-name').value = 'Navegador Teste'; document.getElementById('wh-start').click(); true`);
    check('começa a transmitir e mostra o link', await until(host, `document.body.dataset.state === 'live' && /\\/s\\//.test(document.getElementById('wh-link').value)`, 10000));
    const link = await js(host, `document.getElementById('wh-link').value`);
    const saved = await js(host, `localStorage.getItem('fs-web-room')`);

    const viewer = mk('whv-' + Date.now());
    await viewer.loadURL(link);
    check('quem assiste pelo link vê o vídeo do navegador', await until(viewer, `document.body.dataset.state === 'live' && remoteVideo.videoWidth > 0`, 15000), await js(viewer, `remoteVideo.videoWidth + 'x' + remoteVideo.videoHeight`));
    check('sem aviso de "versão antiga" para quem transmite pelo navegador', await js(viewer, `document.getElementById('host-notice').style.display === 'none'`));
    check('quem transmite vê quantos assistem', await until(host, `document.getElementById('wh-count').textContent.startsWith('1 ')`, 5000));
    await js(viewer, `document.getElementById('btn-react').click(); document.querySelector('.react-btn').click(); true`);
    check('reações aparecem para quem transmite pelo navegador', await until(host, `document.getElementById('wh-reactions').textContent.includes('🔥')`, 4000));
    const og = await (await fetch(link)).text();
    check('prévia do link com o nome de quem transmite pelo navegador', /og:title" content="Navegador Teste está ao vivo no FrogShare"/.test(og));

    // Stop and come back: same room, the viewer gets the picture again
    await js(host, `document.getElementById('wh-stop').click(); true`);
    check('parar deixa quem assiste esperando (pausado)', await until(viewer, `document.body.dataset.state === 'paused'`, 8000), await js(viewer, `document.body.dataset.state`));
    await js(host, FAKE_DISPLAY);
    await js(host, `document.getElementById('wh-start').click(); true`);
    check('voltar a transmitir: a mesma pessoa vê de novo, sem recarregar', await until(viewer, `document.body.dataset.state === 'live' && remoteVideo.videoWidth > 0`, 15000));
    check('o link continua o mesmo', (await js(host, `document.getElementById('wh-link').value`)) === link && (await js(host, `localStorage.getItem('fs-web-room')`)) === saved);
    host.destroy();
    viewer.destroy();

    // ======== Joining a friend's group from the browser ========
    const { roomId: groupId, hostKey: groupKey } = await (await fetch(BASE + '/api/room/create')).json();
    const owner = mk('who-' + Date.now());
    await owner.loadURL(BASE + '/');
    await js(owner, OWNER_JS(groupId, groupKey));
    const gv = mk('whgv-' + Date.now());
    await gv.loadURL(`${BASE}/s/${groupId}`);
    check('grupo aberto: o botão de compartilhar oferece entrar pelo navegador', await until(gv, `!document.getElementById('share-dot').hidden && !document.getElementById('share-group').hidden && document.getElementById('btn-share-web').getAttribute('href') === '/transmitir.html?grupo=${groupId}' && document.getElementById('share-owner').textContent === 'Dono'`, 15000));
    check('com uma pessoa só transmitindo, não há lista do lado', await js(gv, `document.getElementById('stream-list').hidden`));
    const guest = mk('whg-' + Date.now());
    await guest.loadURL(`${BASE}/transmitir.html?grupo=${groupId}`);
    check('a página de transmitir abre no modo grupo', await until(guest, `document.getElementById('wh-title').textContent === 'Transmitir no grupo'`, 5000));
    await js(guest, FAKE_DISPLAY);
    await js(guest, `document.getElementById('wh-name').value = 'Tutu'; document.getElementById('wh-start').click(); true`);
    check('entra no grupo do amigo, com o link da sala dele', await until(guest, `document.body.dataset.state === 'live' && document.getElementById('wh-link').value.endsWith('/s/${groupId}') && document.getElementById('wh-link-fine').textContent.startsWith('No grupo de Dono')`, 10000),
      await js(guest, `document.getElementById('wh-link-fine').textContent`));
    check('quem assiste vê as duas transmissões', await until(gv, `document.querySelectorAll('.stream-item').length === 2 && [...channels.values()].filter(c => c.stream).length === 2`, 20000),
      await js(gv, `document.querySelectorAll('.stream-item').length + ' na lista'`));
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
