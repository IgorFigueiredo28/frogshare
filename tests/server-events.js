// Socket-level checks of the server events (names, reactions, data saver, health, kick/lock, named rooms,
// link previews) against a running local server. Usage: node tests/server-events.js http://127.0.0.1:3041
const { io } = require(require('path').join(__dirname, '..', 'node_modules', 'socket.io-client'));
const BASE = process.argv[2] || 'http://127.0.0.1:3042';
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const connect = () => new Promise(res => { const s = io(BASE, { transports: ['websocket'], forceNew: true }); s.on('connect', () => res(s)); });
const next = (s, ev, ms = 2000) => new Promise(res => { const t = setTimeout(() => res(null), ms); s.once(ev, (d) => { clearTimeout(t); res(d ?? {}); }); });
const collect = (s, ev) => { const arr = []; s.on(ev, d => arr.push(d)); return arr; };

(async () => {
  const { roomId, hostKey } = await (await fetch(BASE + '/api/room/create')).json();
  const host = await connect();
  const viewerList = collect(host, 'viewer-list');
  host.emit('join-room', { roomId, asHost: true, hostKey, appVersion: '1.7.0', name: 'Igor' });
  await wait(300);

  // Names
  const v1 = await connect();
  const v1Updates = collect(v1, 'room-update');
  v1.emit('join-room', { roomId, asHost: false, name: 'Ana', viewerKey: 'key-ana-123456' });
  await wait(400);
  const lastList = viewerList[viewerList.length - 1];
  check('dono recebe a lista com o nome de quem assiste', !!lastList && lastList.viewers.some(v => v.name === 'Ana' && v.id === v1.id), JSON.stringify(lastList));
  const lastUpd = v1Updates[v1Updates.length - 1];
  check('quem assiste recebe os nomes (sem ids)', !!lastUpd && lastUpd.viewerNames.includes('Ana') && !JSON.stringify(lastUpd.viewerNames).includes(v1.id));
  v1.emit('set-name', { name: 'Ana <b>' });
  await wait(300);
  check('trocar o nome limpa < e >', viewerList[viewerList.length - 1].viewers.some(v => v.name === 'Ana b'), JSON.stringify(viewerList[viewerList.length - 1]));

  // Reactions
  const hostReactions = collect(host, 'reaction');
  const v1Reactions = collect(v1, 'reaction');
  v1.emit('reaction', { emoji: '🔥', hostId: host.id });
  v1.emit('reaction', { emoji: '💩', hostId: host.id });
  await wait(300);
  check('reação chega ao dono com o nome', hostReactions.length === 1 && hostReactions[0].emoji === '🔥' && hostReactions[0].name === 'Ana b' && hostReactions[0].hostId === host.id, JSON.stringify(hostReactions));
  check('reação chega a quem assiste, marcada como sua', v1Reactions.length === 1 && v1Reactions[0].from === v1.id);
  check('emoji fora da lista é ignorado', hostReactions.every(r => r.emoji !== '💩'));
  for (let i = 0; i < 10; i++) v1.emit('reaction', { emoji: '😂' });
  await wait(400);
  check('reações em rajada são limitadas', hostReactions.length <= 7, `${hostReactions.length} recebidas`);
  host.emit('reaction', { emoji: '🔥' });
  await wait(200);
  check('quem transmite não manda reação', hostReactions.length <= 7);

  // Viewer quality
  const q = next(host, 'viewer-quality');
  v1.emit('viewer-quality', { hostId: host.id, low: true });
  const qd = await q;
  check('pedido de economia de dados chega ao dono', qd && qd.viewerId === v1.id && qd.low === true, JSON.stringify(qd));

  // Host health
  const h = next(v1, 'host-health');
  host.emit('host-health', { fps: 57.4, target: 60, limit: 'cpu', away: false, junk: 'x' });
  const hd = await h;
  check('saúde da transmissão chega a quem assiste, limpa', hd && hd.fps === 57 && hd.limit === 'cpu' && hd.hostId === host.id && !('junk' in hd), JSON.stringify(hd));
  const h2 = next(host, 'host-health', 500);
  v1.emit('host-health', { fps: 1 });
  check('quem assiste não manda saúde', (await h2) === null);

  // Game name
  const g = next(v1, 'room-update');
  host.emit('set-game', { game: 'Deadlock' });
  const gd = await g;
  check('nome do jogo aparece para quem assiste', gd && gd.hosts[0].game === 'Deadlock', JSON.stringify(gd?.hosts));

  // Lock
  host.emit('lock-room', { locked: true });
  await wait(300);
  const v2 = await connect();
  const locked = next(v2, 'room-locked');
  v2.emit('join-room', { roomId, asHost: false, name: 'Bia', viewerKey: 'key-bia-123456' });
  check('sala trancada barra gente nova', !!(await locked));
  const v1b = await connect();
  const back = next(v1b, 'room-update');
  v1b.emit('join-room', { roomId, asHost: false, name: 'Ana', viewerKey: 'key-ana-123456' });
  check('sala trancada deixa voltar quem já estava (mesma chave)', !!(await back));
  v1b.disconnect();
  await wait(200);
  host.emit('lock-room', { locked: false });
  await wait(200);
  const v2ok = next(v2, 'room-update');
  v2.emit('join-room', { roomId, asHost: false, name: 'Bia', viewerKey: 'key-bia-123456' });
  check('destrancada, gente nova entra', !!(await v2ok));

  // Kick
  await wait(200);
  const kicked = next(v2, 'kicked');
  const left = next(host, 'viewer-left');
  host.emit('kick-viewer', { viewerId: v2.id });
  check('quem foi tirado fica sabendo', !!(await kicked));
  check('dono recebe viewer-left de quem tirou', (await left)?.viewerId === v2.id);
  const v2r = collect(host, 'reaction');
  v2.emit('reaction', { emoji: '🔥' });
  await wait(300);
  check('quem foi tirado não manda mais reação', v2r.length === 0);
  const ghostOffers = collect(host, 'viewer-joined');
  v2.emit('request-offer', { hostId: host.id });
  v2.emit('watch', { hostId: host.id, video: false });
  await wait(1900);
  check('quem foi tirado não pede mais conexão a quem transmite', !ghostOffers.some(j => j.viewerId === v2.id));
  const v2again = await connect();
  const kicked2 = next(v2again, 'kicked');
  v2again.emit('join-room', { roomId, asHost: false, name: 'Bia', viewerKey: 'key-bia-123456' });
  check('quem foi tirado não volta recarregando a página', !!(await kicked2));
  const vKickByViewer = next(host, 'viewer-left', 600);
  v1.emit('kick-viewer', { viewerId: v1.id });
  check('quem assiste não consegue tirar ninguém', (await vKickByViewer) === null);

  // Named room
  const claim = await (await fetch(BASE + '/api/room/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'teste-sapo' + Math.floor(Math.random() * 1e6) }) })).json();
  check('nome de sala reservado', !!claim.roomId && !!claim.hostKey, JSON.stringify(claim));
  const owner2 = await connect();
  const rej = next(owner2, 'host-rejected', 600);
  owner2.emit('join-room', { roomId: claim.roomId, asHost: true, hostKey: claim.hostKey, appVersion: '1.7.0', name: 'Igor' });
  check('dono entra na sala com nome', (await rej) === null);
  const thief = await connect();
  const rej2 = next(thief, 'host-rejected');
  thief.emit('join-room', { roomId: claim.roomId, asHost: true, hostKey: 'outra-chave-qualquer-1234', appVersion: '1.7.0', name: 'Ladrao' });
  check('outra chave não pega a sala com nome', !!(await rej2));
  const again = await (await fetch(BASE + '/api/room/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: claim.roomId, hostKey: claim.hostKey }) })).json();
  check('pedir de novo o próprio nome devolve ele', again.roomId === claim.roomId);
  owner2.disconnect(); thief.disconnect();

  // Link preview and status
  const page = await (await fetch(`${BASE}/s/${roomId}`)).text();
  check('prévia do link diz quem está ao vivo e o jogo', /<meta property="og:title" content="Igor está ao vivo no FrogShare">/.test(page) && /Jogando Deadlock/.test(page), (page.match(/og:title" content="[^"]*"/) || [''])[0]);
  const plain = await (await fetch(`${BASE}/room.html?room=naoexiste123`)).text();
  check('sala desconhecida mantém a prévia padrão', /og:title" content="Assista à transmissão no FrogShare"/.test(plain));
  const status = await (await fetch(`${BASE}/api/rooms/status?ids=${roomId},naoexiste123`)).json();
  check('status das salas recentes', status[0].live === true && status[0].name === 'Igor' && status[0].game === 'Deadlock' && status[1].exists === false, JSON.stringify(status));

  // Web host is never "outdated"
  const { roomId: r2, hostKey: k2 } = await (await fetch(BASE + '/api/room/create')).json();
  const web = await connect();
  web.emit('join-room', { roomId: r2, asHost: true, hostKey: k2, appVersion: 'web', name: 'Navegador' });
  await wait(200);
  const v3 = await connect();
  const u3 = next(v3, 'room-update');
  v3.emit('join-room', { roomId: r2, asHost: false, name: 'Caio', viewerKey: 'key-caio-123456' });
  const u3d = await u3;
  check('transmissão pelo navegador não aparece como versão antiga', u3d && u3d.hostOutdated === false && u3d.hosts[0].web === true, JSON.stringify(u3d));

  for (const s of [host, v1, v2, v2again, web, v3]) s.disconnect();
  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
