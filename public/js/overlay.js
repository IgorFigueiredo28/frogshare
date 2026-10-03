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
