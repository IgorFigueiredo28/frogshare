// Home page: join a room by code
const btnJoin = document.getElementById('btn-join');
const inputRoom = document.getElementById('input-room');

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

btnJoin.addEventListener('click', () => {
  const code = inputRoom.value.trim().toLowerCase();
  if (!code) {
    showToast('Digite o código da sala');
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
