// Presentation only: turns the stats line host.js writes ("1920x1080 @ 57fps | GPU | 9.3 Mbps |
// servidor (SFU) | 4 viewer(s)") into the room panel, and shows a note while the preview is paused.
// Streaming logic stays in host.js.
(function () {
  const stats = document.getElementById('stream-stats');
  const viewers = document.getElementById('viewer-count');
  const watchersNum = document.getElementById('watchers-num');
  const preview = document.getElementById('local-preview');
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

  // host.js clears the preview while the app is in the background to spare the GPU
  function renderPreview() {
    document.body.classList.toggle('preview-off', !preview.srcObject);
  }

  new MutationObserver(renderStats).observe(stats, { childList: true, characterData: true, subtree: true });
  new MutationObserver(renderViewers).observe(viewers, { childList: true, characterData: true, subtree: true });
  setInterval(renderPreview, 1000);

  renderStats();
  renderViewers();
  renderPreview();
})();
