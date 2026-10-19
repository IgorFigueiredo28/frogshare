// 1.7 app checks: the dev app (hidden, its own profile, pointed at the local server) streams a test
// window placed outside every monitor (nothing of the real screen is captured), with Chromium's fake
// camera. Viewers are hidden, muted windows. Usage: npx electron tests/e2e-app.js [base url]
const { app, BrowserWindow, screen } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const BASE = process.argv.find(a => /^https?:\/\//.test(a)) || 'http://127.0.0.1:3041';
const REPO = path.resolve(__dirname, '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9334;
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
app.on('window-all-closed', () => {});

let cdp = null, cdpId = 0;
const pendingCalls = new Map();
async function connectApp() {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = targets.find(x => x.type === 'page' && x.url.includes('host.html'));
      if (t) {
        cdp = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => { cdp.addEventListener('open', res); cdp.addEventListener('error', rej); });
        cdp.addEventListener('message', e => { const m = JSON.parse(e.data); const p = pendingCalls.get(m.id); if (p) { pendingCalls.delete(m.id); p(m); } });
        return;
      }
    } catch {}
    await wait(250);
  }
  throw new Error('app did not open');
}
async function evalApp(expression) {
  const id = ++cdpId;
  const reply = await new Promise(resolve => { pendingCalls.set(id, resolve); cdp.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || 'app error');
  return reply.result.result.value;
}
async function untilApp(code, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await evalApp(code)) return true; } catch {} await wait(250); }
  return false;
}
const js = (w, code) => w.webContents.executeJavaScript(code);
async function until(w, code, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await js(w, code)) return true; } catch {} await wait(250); }
  return false;
}
function viewer(partition) {
  const w = new BrowserWindow({ show: false, width: 1280, height: 760, webPreferences: { offscreen: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', partition } });
  w.webContents.setAudioMuted(true);
  return w;
}
// Average colour of a small area of what the viewer receives, from its video element
const SAMPLE = (fx, fy) => `(() => { const v = remoteVideo; if (!v.videoWidth) return null; const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0); const d = g.getImageData(Math.floor(c.width * ${fx}), Math.floor(c.height * ${fy}), 8, 8).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; } const n = d.length / 4; return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)]; })()`;
const near = (c, ref, tol = 40) => c && Math.abs(c[0] - ref[0]) <= tol && Math.abs(c[1] - ref[1]) <= tol && Math.abs(c[2] - ref[2]) <= tol;

app.whenReady().then(async () => {
  let devApp = null, source = null;
  try {
    // The window the app streams: solid orange, outside every monitor
    const all = screen.getAllDisplays().map(d => d.bounds);
    const minX = Math.min(...all.map(b => b.x)), minY = Math.min(...all.map(b => b.y));
    // Not a tool window (skipTaskbar): Chromium leaves those out of the list of windows to share
    source = new BrowserWindow({ x: minX - 2600, y: minY - 2000, width: 960, height: 540, show: false, frame: false, focusable: false, title: 'FS-TEST-SOURCE', backgroundColor: '#FF8800' });
    await source.loadURL('data:text/html,<title>FS-TEST-SOURCE</title><body style="margin:0;background:%23FF8800"></body>');
    source.showInactive();
    source.setPosition(minX - 2600, minY - 2000);

    devApp = spawn(ELECTRON, [REPO, '--hidden', `--remote-debugging-port=${PORT}`, '--use-fake-device-for-media-stream'], {
      env: { ...process.env, SIGNAL_SERVER: BASE, FROGSHARE_MULTI: '1' }, stdio: 'ignore'
    });
    await connectApp();
    await wait(2000);

    // Fixed link, prepared on launch
    check('o app prepara o link fixo ao abrir', await untilApp(`document.getElementById('room-link-text').textContent.includes('/s/') && !document.getElementById('btn-copy-fixed-link').disabled`, 10000),
      await evalApp(`document.getElementById('room-link-text').textContent`));
    const name = 'teste-' + Math.floor(Math.random() * 1e6);
    await evalApp(`document.getElementById('btn-edit-link').click(); document.getElementById('link-name').value = '${name}'; document.getElementById('link-form').requestSubmit(); true`);
    check('mudar o link para um nome próprio', await untilApp(`savedRoom()?.roomId === '${name}' && document.getElementById('room-link-text').textContent.endsWith('/s/${name}')`, 6000));

    // Pick the test window, no sound, 720p30 (light)
    check('a janela de teste aparece na lista', await untilApp(`(async () => { await loadSources({ silent: true }); return [...document.querySelectorAll('#source-grid .source-item')].some(el => el.textContent.includes('FS-TEST-SOURCE')); })()`, 15000));
    await evalApp(`(() => {
      [...document.querySelectorAll('#source-grid .source-item')].find(el => el.textContent.includes('FS-TEST-SOURCE')).click();
      const pick = (sel) => { const el = document.querySelector(sel); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); };
      pick('input[name="audio-mode"][value="none"]'); pick('input[name="q-res"][value="720"]'); pick('input[name="q-fps"][value="30"]');
      document.getElementById('cam-toggle').checked = true; document.getElementById('cam-toggle').dispatchEvent(new Event('change'));
      return true;
    })()`);
    await wait(800);
    // Windows Graphics Capture refuses a window outside the monitors, so the capture itself is a solid
    // orange canvas here; everything after it (the pipeline, camera, card, connections) is the real code
    await evalApp(`navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas'); c.width = 960; c.height = 540; const g = c.getContext('2d');
      setInterval(() => { g.fillStyle = '#FF8800'; g.fillRect(0, 0, 960, 540); g.fillStyle = '#FF8801'; g.fillRect((Date.now() / 10) % 900, 10, 4, 4); }, 33);
      return c.captureStream(30);
    }; true`);
    await evalApp(`updateStartButton(); btnStart.click(); true`);
    check('começa a transmitir no próprio link', await untilApp(`isStreaming && roomId === '${name}'`, 15000));

    const v1 = viewer('a1-' + Date.now());
    await v1.loadURL(`${BASE}/s/${name}`);
    check('quem assiste vê a transmissão do app', await until(v1, `document.body.dataset.state === 'live' && remoteVideo.videoWidth > 0`, 20000));
    await wait(2500);
    const centre = await js(v1, SAMPLE(0.45, 0.45));
    const corner = await js(v1, SAMPLE(0.85, 0.8));
    check('a imagem é a janela de teste (laranja)', near(centre, [255, 136, 0], 60), JSON.stringify(centre));
    check('a câmera aparece no canto de baixo à direita', corner && !near(corner, [255, 136, 0], 60), JSON.stringify(corner));

    // Names, removing, locking, reactions, data saver, health
    await js(v1, `setViewerName('Ana'); true`);
    check('o app lista quem assiste pelo nome', await untilApp(`[...document.querySelectorAll('#viewer-list .viewer-name')].some(el => el.textContent === 'Ana')`, 5000));
    await js(v1, `document.getElementById('btn-react').click(); document.querySelectorAll('.react-btn')[2].click(); true`);
    check('reações contadas no app', await untilApp(`document.getElementById('reaction-counts').textContent.includes('👏')`, 4000));
    await js(v1, `document.getElementById('btn-more').click(); document.getElementById('opt-data-saver').click(); true`);
    const lowId = await js(v1, `socket.id`);
    check('economizar dados: o app manda a cópia leve para essa pessoa', await untilApp(`(() => { const pc = peerConnections.get('${lowId}'); const e = pc?.getSenders().find(s => s.track?.kind === 'video')?.getParameters().encodings[0]; return !!e && e.maxBitrate === 1200000; })()`, 5000),
      JSON.stringify(await evalApp(`peerConnections.get('${lowId}')?.getSenders().find(s => s.track?.kind === 'video')?.getParameters().encodings[0]`)));
    check('quem assiste recebe a saúde da transmissão', await until(v1, `(() => { const h = hostHealth.get(selectedId); return !!h && h.target === 30 && typeof h.fps === 'number'; })()`, 12000),
      JSON.stringify(await js(v1, `hostHealth.get(selectedId)`)));

    // Quick pause: the "já volto" card replaces the picture, and comes off again
    await evalApp(`document.getElementById('btn-quick-pause').click(); true`);
    await wait(1500);
    const away = await js(v1, SAMPLE(0.1, 0.1));
    check('pausa rápida: quem assiste vê o "já volto"', near(away, [11, 26, 16], 25), JSON.stringify(away));
    check('quem assiste fica sabendo que é pausa, não travamento', await until(v1, `hostHealth.get(selectedId)?.away === true`, 4000));
    await evalApp(`document.getElementById('btn-quick-pause').click(); true`);
    await wait(1500);
    check('desligar a pausa volta a imagem', near(await js(v1, SAMPLE(0.45, 0.45)), [255, 136, 0], 60));

    // Leaving the game (decision logic, with the window events the helper would send)
    const fgLogic = await evalApp(`(() => {
      privacy.watching = true; privacy.protect = true; resetGame();
      // A browser in fullscreen (a video) is never taken for the game
      onForeground({ hwnd: 8, pid: 3131, exe: 'brave', covers: true, onCaptured: true, own: false, shell: false });
      const browserTaken = !!privacy.game;
      onForeground({ hwnd: 1, pid: 4242, exe: 'project8', covers: true, onCaptured: true, own: false, shell: false });
      const game = !browserTaken && privacy.game?.name;
      onForeground({ hwnd: 2, pid: 5151, exe: 'discord', covers: false, onCaptured: true, own: false, shell: false });
      const leftGame = privacy.auto;
      onForeground({ hwnd: 3, pid: 6161, exe: 'chrome', covers: true, onCaptured: false, own: false, shell: false });
      const otherMonitor = privacy.auto;
      onForeground({ hwnd: 1, pid: 4242, exe: 'project8', covers: true, onCaptured: true, own: false, shell: false });
      const back = privacy.auto;
      onForeground({ switching: true });
      const altTab = privacy.auto;
      onForeground({ hwnd: 9, pid: 7, exe: 'explorer', covers: true, onCaptured: true, own: false, shell: true });
      const desktop = privacy.auto;
      onForeground({ hwnd: 1, pid: 4242, exe: 'project8', covers: true, onCaptured: true, own: false, shell: false });
      return { game, leftGame, otherMonitor, back: !back, altTab, desktop, end: !privacy.auto };
    })()`);
    check('acha o jogo e cobre a tela ao sair dele (Alt+Tab, outro app, área de trabalho)', fgLogic.game === 'Deadlock' && fgLogic.leftGame && fgLogic.otherMonitor && fgLogic.back && fgLogic.altTab && fgLogic.desktop && fgLogic.end, JSON.stringify(fgLogic));
    check('o nome do jogo chega a quem assiste', await until(v1, `infoFor(selectedId)?.game === 'Deadlock'`, 4000));
    await evalApp(`privacy.watching = false; privacy.auto = false; setAway(); true`);

    // The real helper: one event for the window in front right now
    const fgReal = await evalApp(`new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 4000);
      window.electronAPI.onForeground(fg => { clearTimeout(t); resolve(fg); });
      window.electronAPI.watchForeground('screen:' + 0 + ':0');
    })`);
    check('o vigia da janela da frente responde', !!fgReal && typeof fgReal.exe === 'string' && 'covers' in fgReal && 'onCaptured' in fgReal, fgReal ? `exe ${fgReal.exe}, cobre ${fgReal.covers}` : 'nada');
    await evalApp(`window.electronAPI.watchForeground(null); true`);
    const hk = await evalApp(`window.electronAPI.setHotkey('CommandOrControl+Shift+F9')`);
    check('o atalho global de pausa registra', hk && hk.ok === true, JSON.stringify(hk));

    // Lock, then remove the viewer from the app's list (two clicks)
    await evalApp(`document.getElementById('lock-toggle').click(); true`);
    const v2 = viewer('a2-' + Date.now());
    await v2.loadURL(`${BASE}/s/${name}`);
    check('trancar no app barra gente nova', await until(v2, `document.body.dataset.state === 'locked'`, 8000));
    await evalApp(`document.getElementById('lock-toggle').click(); true`);
    v2.destroy();
    await evalApp(`(() => { const li = [...document.querySelectorAll('#viewer-list li')].find(l => l.textContent.includes('Ana')); const b = li.querySelector('.viewer-kick'); b.click(); b.click(); return true; })()`);
    check('tirar alguém pela lista do app', await until(v1, `document.body.dataset.state === 'kicked'`, 6000));
    v1.destroy();

    await evalApp(`pauseStreaming(); true`);
    check('parar: câmera e atalho desligados, cartões de volta à configuração', await untilApp(`!isStreaming && !cam.track && document.getElementById('cam-section').parentElement === panelSetup && document.getElementById('privacy-section').parentElement === panelSetup`, 5000));
  } catch (err) {
    console.error(err);
    results.push(false);
  } finally {
    try { cdp?.close(); } catch {}
    if (devApp) { try { execSync(`taskkill /PID ${devApp.pid} /T /F`, { stdio: 'ignore' }); } catch {} }
    source?.destroy();
  }
  console.log(`\n${results.filter(Boolean).length} de ${results.length} passaram`);
  app.exit(results.every(Boolean) ? 0 : 1);
});
