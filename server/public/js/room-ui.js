// Presentation only: reads what room.js already shows (status text, video visibility) and mirrors it
// in the status chip and the mascot. Connection logic stays in room.js.
(function () {
  const body = document.body;
  const statusEl = document.getElementById('status-text');
  const video = document.getElementById('remote-video');
  const chip = document.getElementById('room-status');
  const frog = document.getElementById('placeholder-frog');
  const hint = document.getElementById('placeholder-hint');
  const bubbles = document.getElementById('placeholder-bubbles');
  const fullscreenBtn = document.getElementById('btn-fullscreen');

  const STATES = {
    live: { chip: 'Ao vivo', cls: 'chip-live', eyes: true },
    starting: { chip: 'Conectando', cls: 'chip-ok', frog: 'frog', hint: 'O host está ao vivo. Abrindo a transmissão…', bubbles: true },
    waiting: { chip: 'Esperando', cls: '', frog: 'frog-sleep', hint: 'A transmissão aparece aqui sozinha assim que começar.' },
    paused: { chip: 'Pausado', cls: 'chip-warn', frog: 'frog-sleep', hint: 'Fique por aqui: quando o host voltar, o vídeo reaparece sozinho.' },
    reconnecting: { chip: 'Reconectando', cls: 'chip-warn', frog: 'frog-sad', hint: 'A conexão oscilou. Já estamos tentando de novo.', bubbles: true },
    left: { chip: 'Host saiu', cls: 'chip-danger', frog: 'frog-sad', hint: 'Quando o host abrir a sala de novo, a transmissão volta aqui.' }
  };

  function detect() {
    if (video.style.display === 'block') return 'live';
    const text = statusEl.textContent.toLowerCase();
    if (text.includes('pausou')) return 'paused';
    if (text.includes('desconectou') || text.includes('saiu')) return 'left';
    if (text.includes('reconect') || text.includes('demorando') || text.includes('perdida')) return 'reconnecting';
    if (text.includes('conectado') || text.includes('abrindo')) return 'starting';
    return 'waiting';
  }

  function render() {
    const state = detect();
    if (body.dataset.state === state) return;
    body.dataset.state = state;
    const s = STATES[state];

    chip.className = 'chip ' + s.cls;
    chip.replaceChildren();
    if (s.eyes) {
      const eyes = document.createElement('span');
      eyes.className = 'live-eyes';
      eyes.setAttribute('aria-hidden', 'true');
      eyes.append(document.createElement('i'), document.createElement('i'));
      chip.append(eyes);
    }
    chip.append(s.chip);

    if (s.frog) {
      frog.src = '/brand/' + s.frog + '.svg';
      hint.textContent = s.hint;
      bubbles.style.display = s.bubbles ? '' : 'none';
    }
  }

  // room.js rewrites the fullscreen button label; add the icon back after it does
  function decorateFullscreen() {
    const exiting = !!document.fullscreenElement;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/brand/icons.svg#' + (exiting ? 'i-minimize' : 'i-maximize'));
    svg.append(use);
    const label = document.createElement('span');
    label.className = 'btn-label';
    label.textContent = exiting ? 'Sair da tela cheia' : 'Tela cheia';
    fullscreenBtn.replaceChildren(svg, label);
    fullscreenBtn.title = exiting ? 'Sair da tela cheia (F)' : 'Tela cheia (F)';
  }

  new MutationObserver(render).observe(statusEl, { childList: true, characterData: true, subtree: true });
  new MutationObserver(render).observe(video, { attributes: true, attributeFilter: ['style'] });
  document.addEventListener('fullscreenchange', decorateFullscreen);

  decorateFullscreen();
  render();
})();
