const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const inputRoom = document.getElementById('input-room');

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

btnCreate.addEventListener('click', async () => {
  btnCreate.disabled = true;
  btnCreate.textContent = 'Criando...';
  try {
    const res = await fetch('/api/room/create');
    const { roomId } = await res.json();
    window.location.href = `/room.html?room=${roomId}&host=1`;
  } catch {
    showToast('Erro ao criar sala');
    btnCreate.disabled = false;
    btnCreate.textContent = 'Criar Sala';
  }
});

btnJoin.addEventListener('click', () => {
  const code = inputRoom.value.trim().toLowerCase();
  if (!code) {
    showToast('Digite o codigo da sala');
    return;
  }
  window.location.href = `/room.html?room=${code}`;
});

inputRoom.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});
