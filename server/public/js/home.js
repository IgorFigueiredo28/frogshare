// Home page: join a room by code
const btnJoin = document.getElementById('btn-join');
const inputRoom = document.getElementById('input-room');

function showToast(msg) {
  // One at a time: a new message replaces the one on screen instead of piling on top of it
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// The code, or the whole link a friend pasted (…/room.html?room=8e1592c7)
function roomFromInput(text) {
  const fromLink = /[?&]room=([A-Za-z0-9_-]{1,64})/.exec(text);
  return (fromLink ? fromLink[1] : text).trim().toLowerCase();
}

btnJoin.addEventListener('click', () => {
  const text = inputRoom.value.trim();
  if (!text) {
    showToast('Digite o código da sala ou cole o link');
    inputRoom.focus();
    return;
  }
  const code = roomFromInput(text);
  if (!/^[a-z0-9_-]{1,64}$/.test(code)) {
    showToast('Esse código não parece certo. Confira o link que o seu amigo mandou.');
    inputRoom.focus();
    return;
  }
  window.location.href = `/room.html?room=${encodeURIComponent(code)}`;
});

inputRoom.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

// Download links live in one place (/api/app-version); the Mac button stays hidden until a build is published
fetch('/api/app-version').then(r => r.json()).then(({ url, macUrl }) => {
  if (url) document.getElementById('btn-download-win').href = url;
  if (!macUrl) return;
  const mac = document.getElementById('btn-download-mac');
  mac.href = macUrl;
  mac.hidden = false;
  document.getElementById('mac-note').hidden = false;
  // Put the visitor's own platform first
  if (/Mac/.test(navigator.platform)) mac.parentNode.prepend(mac);
}).catch(() => {});

const macGuide = document.getElementById('mac-guide');
// The link still opens the download; the guide shows on top of this page
document.getElementById('btn-download-mac').addEventListener('click', () => { macGuide.hidden = false; });
document.getElementById('btn-mac-guide-close').addEventListener('click', () => { macGuide.hidden = true; });
macGuide.addEventListener('click', (e) => { if (e.target === macGuide) macGuide.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') macGuide.hidden = true; });
