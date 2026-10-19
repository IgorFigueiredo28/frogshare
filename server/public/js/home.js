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

// The code, or the whole link a friend pasted (…/s/igor or …/room.html?room=8e1592c7)
function roomFromInput(text) {
  const fromLink = /[?&]room=([A-Za-z0-9_-]{1,64})/.exec(text) || /\/s\/([A-Za-z0-9_-]{1,64})/.exec(text);
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
  window.location.href = `/s/${encodeURIComponent(code)}`;
});

// ======== Rooms you watched ========
// The room page remembers each room it opened (who streams there); here they come back with whether
// that person is live right now, so a friend's fixed link is one click away
const RECENT_KEY = 'fs-recent-rooms';
const recentBox = document.getElementById('recent');
const recentList = document.getElementById('recent-list');
const frogFor = (name) => /^big\s*frog$/i.test(String(name || '').trim()) ? '/brand/frog-head-big.svg' : '/brand/frog-head.svg';

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter(r => r && /^[A-Za-z0-9_-]{1,64}$/.test(r.id)).slice(0, 8) : [];
  } catch { return []; }
}
function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

function renderRecent(list, status = {}) {
  recentBox.hidden = !list.length;
  recentList.replaceChildren(...list.map(r => {
    const s = status[r.id];
    const li = document.createElement('li');
    li.className = 'recent-item' + (s?.live ? ' is-live' : '');
    const link = document.createElement('a');
    link.className = 'recent-link';
    link.href = `/s/${encodeURIComponent(r.id)}`;
    const name = s?.name || r.name || r.id;
    const frog = Object.assign(document.createElement('img'), { src: frogFor(name), alt: '', width: 34, height: 30 });
    const text = document.createElement('span');
    text.className = 'recent-text';
    const state = !s ? '' : s.live
      ? (s.game ? `Ao vivo · ${s.game}` : 'Ao vivo agora') + (s.viewers ? ` · ${s.viewers} assistindo` : '')
      : 'Não está transmitindo';
    text.append(
      Object.assign(document.createElement('b'), { textContent: `Sala de ${name}` }),
      Object.assign(document.createElement('small'), { textContent: state || r.id })
    );
    link.append(frog, text);
    if (s?.live) link.append(Object.assign(document.createElement('span'), { className: 'chip chip-live', textContent: 'Ao vivo' }));
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'btn btn-ghost btn-icon recent-forget';
    forget.title = 'Tirar da lista';
    forget.setAttribute('aria-label', `Tirar a sala de ${name} da lista`);
    forget.innerHTML = '<svg class="ico ico-sm" aria-hidden="true"><use href="/brand/icons.svg#i-x"/></svg>';
    forget.addEventListener('click', () => {
      const next = loadRecent().filter(x => x.id !== r.id);
      saveRecent(next);
      renderRecent(next, status);
    });
    li.append(link, forget);
    return li;
  }));
}

async function refreshRecent() {
  const list = loadRecent();
  renderRecent(list);
  if (!list.length) return;
  try {
    const res = await fetch('/api/rooms/status?ids=' + list.map(r => encodeURIComponent(r.id)).join(','), { cache: 'no-store' });
    if (!res.ok) return;
    const status = Object.fromEntries((await res.json()).map(s => [s.id, s]));
    // Whoever is live goes first
    list.sort((a, b) => (status[b.id]?.live ? 1 : 0) - (status[a.id]?.live ? 1 : 0));
    renderRecent(list, status);
  } catch {}
}
refreshRecent();
// Someone may go live while the page is open
setInterval(() => { if (!document.hidden) refreshRecent(); }, 30000);

inputRoom.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

// Streaming from the site needs screen sharing, which phones' browsers don't have
if (!navigator.mediaDevices?.getDisplayMedia) document.getElementById('host-way-web').hidden = true;

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
