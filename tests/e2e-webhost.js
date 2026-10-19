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
  } catch (err) {
    console.error(err);
    results.push(false);
  }
  console.log(`\n${results.filter(Boolean).length} de ${results.length} passaram`);
  app.exit(results.every(Boolean) ? 0 : 1);
});
