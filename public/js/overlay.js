// Floating notice: mirrors the stream status the main process sends and offers "open" / "hide".
// Also shows, for a moment, who arrived or left and the reactions, and says so when the stream shows
// "já volto" (quick pause, or the streamer left the game). Nothing here repaints on its own.
const title = document.getElementById('ov-title');
const sub = document.getElementById('ov-sub');
const miniText = document.getElementById('ov-mini-text');
const miniEmoji = document.getElementById('ov-mini-emoji');
let status = { viewers: 0, mode: 'direto', away: false };
let eventText = '';
let eventTimer = null;
let emojiTimer = null;

function render() {
  const { viewers, mode, away } = status;
  document.body.classList.toggle('away', !!away);
  title.textContent = away ? 'Seus amigos veem "já volto"' : 'Você está ao vivo';
  const people = viewers === 1 ? '1 pessoa assistindo' : `${viewers} pessoas assistindo`;
  sub.textContent = eventText || (away
    ? 'A sua tela não aparece para ninguém agora'
    : viewers > 0 ? `${people}${mode === 'sfu' ? ' · via servidor' : ''}` : 'Esperando alguém entrar');
  miniText.textContent = away ? 'Já volto' : viewers > 0 ? `Ao vivo · ${viewers}` : 'Ao vivo';
}

window.electronAPI.onOverlayStatus((s) => {
  status = { ...status, ...s };
  render();
});

window.electronAPI.onOverlayEvent?.(({ text, emoji } = {}) => {
  if (text) {
    eventText = text;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => { eventText = ''; render(); }, 5000);
  }
  if (emoji) {
    miniEmoji.textContent = emoji;
    miniEmoji.hidden = false;
    miniEmoji.classList.remove('pop');
    void miniEmoji.offsetWidth;
    miniEmoji.classList.add('pop');
    clearTimeout(emojiTimer);
    emojiTimer = setTimeout(() => { miniEmoji.hidden = true; }, 4000);
  }
  render();
});

document.getElementById('ov-open').addEventListener('click', () => window.electronAPI.overlayOpenApp());
document.getElementById('ov-hide').addEventListener('click', () => window.electronAPI.overlayHide());

// Compact chip: the main process decides when to shrink; a click expands, a drag moves it.
// It can't use the drag region like the full notice because that would swallow the click.
window.electronAPI.onOverlayCompact(({ compact }) => document.body.classList.toggle('compact', compact));

const expand = document.getElementById('ov-expand');
let drag = null;
expand.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY, moved: false };
  expand.setPointerCapture(e.pointerId);
});
expand.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  drag.x = e.screenX; drag.y = e.screenY;
  window.electronAPI.overlayDrag(dx, dy);
});
expand.addEventListener('pointerup', () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  if (moved) window.electronAPI.overlayDragEnd();
  else window.electronAPI.overlayExpand();
});
expand.addEventListener('pointercancel', () => { drag = null; });
document.getElementById('ov-mini-hide').addEventListener('click', () => window.electronAPI.overlayHide());
render();
