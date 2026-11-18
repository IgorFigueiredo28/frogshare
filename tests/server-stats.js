// The monitoring snapshot (server-stats): a server of its own on port 3043 writes to a stand-in for the
// database on 3044 that only keeps what it receives (nothing leaves this machine), every 1.5 s instead of 5 min.
// Usage: node tests/server-stats.js
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require(path.join(__dirname, '..', 'node_modules', 'socket.io-client'));

const BASE = 'http://127.0.0.1:3043';
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const connect = () => new Promise(res => { const s = io(BASE, { transports: ['websocket'], forceNew: true }); s.on('connect', () => res(s)); });

// The database stand-in: reads answer "nothing stored", writes are kept
const rows = [];
const db = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST') { try { rows.push(JSON.parse(body)); } catch {} res.writeHead(201); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
});

(async () => {
  await new Promise(r => db.listen(3044, '127.0.0.1', r));
  const server = spawn(process.execPath, ['-e', "require('./server/index.js')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '3043', SUPABASE_URL: 'http://127.0.0.1:3044', SUPABASE_SERVICE_ROLE_KEY: 'teste', SERVER_STATS_MS: '1500' },
    stdio: 'ignore'
  });
  const sockets = [];
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await wait(250); }

    // An app streamer with two viewers, a browser streamer with one, and a paused room
    const room = async (appVersion, viewers, paused = false) => {
      const { roomId, hostKey } = await (await fetch(BASE + '/api/room/create')).json();
      const host = await connect();
      sockets.push(host);
      host.emit('join-room', { roomId, asHost: true, hostKey, appVersion, name: 'Teste' });
      await wait(150);
      if (paused) host.emit('host-pause');
      for (let i = 0; i < viewers; i++) {
        const v = await connect();
        sockets.push(v);
        v.emit('join-room', { roomId, asHost: false, name: 'Sapo', viewerKey: `chave-teste-${appVersion}-${i}-${Date.now()}` });
      }
      return host;
    };
    const app = await room('1.8.0', 2);
    await room('web', 1);
    await room('1.7.3', 1, true);
    app.emit('sfu-start', { sessionId: 'abcdef0123456789', tracks: ['video', 'audio'], main: true });
    await wait(2200);

    const snap = rows.filter(r => r.source === 'server-stats').pop()?.context;
    check('a cada intervalo o servidor grava o que está ao vivo', !!snap, `${rows.length} gravações`);
    check('conta salas, transmissões e quem assiste (a pausada fica de fora)', snap && snap.rooms === 2 && snap.streams === 2 && snap.viewers === 3, JSON.stringify(snap));
    check('separa navegador, servidor de mídia e versões', snap && snap.web === 1 && snap.sfu === 1 && snap.versions['1.8.0'] === 1 && snap.versions.navegador === 1 && !snap.versions['1.7.3'], JSON.stringify(snap?.versions));
    check('leva o limite da Cloudflare', snap && snap.cloudflare && snap.cloudflare.capGb === 900, JSON.stringify(snap?.cloudflare));
    const text = JSON.stringify(rows.filter(r => r.source === 'server-stats'));
    check('nenhum id de sala, de pessoa ou nome', !/[0-9a-f]{8}|Teste|Sapo/.test(text.replace(/"source":"server-stats"/g, '')), text.slice(0, 200));

    const forged = await fetch(BASE + '/api/errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'server-stats', message: 'live', context: { rooms: 999 } }) });
    check('ninguém grava esse registro pelo site', forged.status === 403, String(forged.status));

    app.emit('host-pause');
    await wait(1800);
    const after = rows.filter(r => r.source === 'server-stats').pop()?.context;
    check('pausar sai da contagem na gravação seguinte', after && after.rooms === 1 && after.streams === 1 && after.sfu === 0, JSON.stringify(after));
  } catch (err) {
    console.error(err);
    fail++;
  } finally {
    for (const s of sockets) s.disconnect();
    server.kill();
    db.close();
  }
  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
