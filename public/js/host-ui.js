// Presentation only: turns the stats line host.js writes ("1920x1080 @ 57fps | GPU | 9.3 Mbps |
// servidor (SFU) | 4 viewer(s)") into the room panel, and shows a note while the preview is paused.
// Streaming logic stays in host.js.
(function () {
  const stats = document.getElementById('stream-stats');
  const viewers = document.getElementById('viewer-count');
  const watchersNum = document.getElementById('watchers-num');
  const preview = document.getElementById('local-preview');

  window.electronAPI.getAppVersion().then(v => {
    document.getElementById('app-version').textContent = 'v' + v;
  });
  const facts = {
    mode: document.getElementById('fact-mode'),
    video: document.getElementById('fact-video'),
    encoder: document.getElementById('fact-encoder'),
    rate: document.getElementById('fact-rate')
  };

  function renderStats() {
    const text = stats.textContent.trim();
    const parts = text.split('|').map(s => s.trim());
    if (parts.length < 5) {
      facts.mode.textContent = !text || text.startsWith('Transmitindo') ? 'Esperando alguém entrar' : text;
      facts.video.textContent = facts.encoder.textContent = facts.rate.textContent = '–';
      return;
    }
    const [video, encoder, rate, mode] = parts;
    facts.video.textContent = video.replace('@', '·').replace('fps', ' fps');
    facts.encoder.textContent = encoder === 'GPU' ? 'Placa de vídeo (leve)' : 'Processador (pesado)';
    facts.encoder.dataset.tone = encoder === 'GPU' ? 'ok' : 'warn';
    facts.rate.textContent = rate.replace('Mbps', ' Mbps').replace(/\s+/g, ' ') + (rate.includes('/') ? ' por pessoa' : '');
    facts.mode.textContent = mode.includes('SFU') ? 'Servidor (1 envio para todos)' : 'Direto (1 envio por pessoa)';
  }

  function renderViewers() {
    const n = parseInt(viewers.textContent, 10);
    watchersNum.textContent = Number.isFinite(n) ? n : 0;
  }

  // Behind a game or minimized, nothing on screen should animate: with background throttling off
  // the page keeps painting, and a single bobbing frog measured 1.5-3 CPU cores taken from the game
  window.electronAPI.onWindowFocus((focused) => document.body.classList.toggle('app-background', !focused));

  // host.js clears the preview while the app is in the background to spare the GPU
  function renderPreview() {
    document.body.classList.toggle('preview-off', !preview.srcObject);
  }

  // Tell the main process when we're live, so it can show the floating notice on minimize
  const panelStreaming = document.getElementById('panel-streaming');
  let lastStatus = '';
  function sendStatus() {
    const streaming = panelStreaming.style.display !== 'none';
    const count = parseInt(viewers.textContent, 10) || 0;
    const mode = stats.textContent.includes('SFU') ? 'sfu' : 'direto';
    const key = `${streaming}|${count}|${mode}`;
    if (key === lastStatus) return;
    lastStatus = key;
    document.title = streaming ? 'FrogShare · ao vivo' : 'FrogShare';
    window.electronAPI.setStreamStatus({ streaming, viewers: count, mode });
  }

  const overlayToggle = document.getElementById('overlay-toggle');
  window.electronAPI.getOverlayEnabled().then(enabled => { overlayToggle.checked = enabled; });
  overlayToggle.addEventListener('change', () => window.electronAPI.setOverlayEnabled(overlayToggle.checked));

  new MutationObserver(() => { renderStats(); sendStatus(); }).observe(stats, { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => { renderViewers(); sendStatus(); }).observe(viewers, { childList: true, characterData: true, subtree: true });
  setInterval(() => { renderPreview(); sendStatus(); }, 1000);

  renderStats();
  renderViewers();
  renderPreview();
  sendStatus();
})();
