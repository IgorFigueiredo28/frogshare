// Floating notice: mirrors the stream status the main process sends and offers "open" / "hide"
const sub = document.getElementById('ov-sub');

window.electronAPI.onOverlayStatus(({ viewers, mode }) => {
  const people = viewers === 1 ? '1 pessoa assistindo' : `${viewers} pessoas assistindo`;
  sub.textContent = viewers > 0
    ? `${people}${mode === 'sfu' ? ' · via servidor' : ''}`
    : 'Esperando alguém entrar';
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
