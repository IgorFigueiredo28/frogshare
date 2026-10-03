const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3030;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const app = express();
app.use(cors());
// SDP bodies for the SFU routes run to several KB
app.use(express.json({ limit: '64kb' }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

// Clean up stale rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (!room.host && room.viewers.size === 0 && now - room.createdAt > 600000) {
      rooms.delete(id);
    }
  }
}, 600000);

app.get('/health', (req, res) => res.send('ok'));

// ======== App version ========
// Hosts on old builds encode on the CPU once per viewer and stutter badly, and nothing told
// anyone. The app checks this on start; viewers are told when the room's host is behind.
const LATEST_APP = {
  version: '1.4.0',
  // Below this the host has no GPU encoding, TURN, upload sharing or SFU
  minimum: '1.3.0',
  // Direct download: skips Drive's preview page and goes straight to its virus-scan notice
  url: 'https://drive.usercontent.google.com/download?id=1h8kEmEb0XJpR4D42Z10YFKZ9il0cQPGu&export=download',
  // Apple Silicon .dmg; the site hides its download button while this is null
  macUrl: null
};

function versionOlder(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

app.get('/api/app-version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(LATEST_APP);
});

// STUN alone can't traverse symmetric NAT / mobile CGNAT; TURN relays those peers
const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];
let turnCache = { servers: null, expires: 0 };

async function getTurnServers() {
  if (turnCache.servers && Date.now() < turnCache.expires) return turnCache.servers;

  // Values pasted into a dashboard often carry stray whitespace
  const env = (name) => (process.env[name] || '').trim();
  const CF_TURN_KEY_ID = env('CF_TURN_KEY_ID');
  const CF_TURN_API_TOKEN = env('CF_TURN_API_TOKEN');
  const TURN_URLS = env('TURN_URLS');
  const TURN_USERNAME = env('TURN_USERNAME');
  const TURN_CREDENTIAL = env('TURN_CREDENTIAL');
  let servers = [];

  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        // Short-lived so the monthly cap takes effect within hours of being reached
        body: JSON.stringify({ ttl: 43200 })
      }
    );
    if (!resp.ok) throw new Error(`Cloudflare respondeu ${resp.status}`);
    const data = await resp.json();
    const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // Browsers time out on port-53 TURN URLs, which delays ICE gathering
    servers = list
      .map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) }))
      .filter(s => s.urls.length > 0);
  } else if (TURN_URLS && TURN_USERNAME && TURN_CREDENTIAL) {
    servers = [{ urls: TURN_URLS.split(',').map(u => u.trim()), username: TURN_USERNAME, credential: TURN_CREDENTIAL }];
  }

  if (servers.length > 0) turnCache = { servers, expires: Date.now() + 6 * 3600 * 1000 };
  return servers;
}

// ======== TURN relay budget ========
// Cloudflare bills relayed traffic beyond 1,000 GB/month, so stop handing out TURN before that.
// Hosts report the bytes they pushed through a relay; the running total lives in Supabase
// because this process restarts whenever Render redeploys or sleeps.
const TURN_CAP_BYTES = (Number(process.env.TURN_MONTHLY_CAP_GB) || 900) * 1e9;
const relayUsage = { month: '', base: 0, session: 0, loaded: false, lastSave: 0 };
const currentMonth = () => new Date().toISOString().slice(0, 7);

function relayTotal() {
  if (relayUsage.month !== currentMonth()) {
    relayUsage.month = currentMonth();
    relayUsage.base = 0;
    relayUsage.session = 0;
  }
  return relayUsage.base + relayUsage.session;
}

function supabaseHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

async function loadRelayUsage() {
  if (relayUsage.loaded || !SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/error_logs?source=eq.turn-usage&order=created_at.desc&limit=1&select=context`,
      { headers: supabaseHeaders() }
    );
    if (!resp.ok) return;
    const rows = await resp.json();
    const ctx = rows[0]?.context;
    relayTotal();
    if (ctx?.month === relayUsage.month) relayUsage.base = Number(ctx.totalBytes) || 0;
    relayUsage.loaded = true;
  } catch {}
}

async function saveRelayUsage() {
  // Saving before the stored total is loaded would overwrite it with a smaller number
  if (!relayUsage.loaded || Date.now() - relayUsage.lastSave < 60000) return;
  const previousSave = relayUsage.lastSave;
  relayUsage.lastSave = Date.now();
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/error_logs`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        source: 'turn-usage',
        level: 'info',
        message: 'relay',
        context: { month: relayUsage.month, totalBytes: relayTotal() }
      })
    });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
  } catch {
    // Let the next report retry instead of waiting out the throttle with a stale stored total
    relayUsage.lastSave = previousSave;
  }
}

// ======== Official usage (Cloudflare Analytics) ========
// The host-reported total is an estimate and can't see traffic we didn't originate. When an
// analytics token is configured, Cloudflare's own egress numbers (what billing uses) drive the cap.
const CF_GRAPHQL_URL = process.env.CF_GRAPHQL_URL || 'https://api.cloudflare.com/client/v4/graphql';
const official = { turnBytes: null, sfuBytes: null, sfuDataset: null, at: 0, error: null, candidates: null };

function analyticsCredentials() {
  const accountId = (process.env.CF_ACCOUNT_ID || '').trim();
  const token = (process.env.CF_ANALYTICS_TOKEN || '').trim();
  return /^[a-f0-9]{32}$/i.test(accountId) && token ? { accountId, token } : null;
}

async function cfGraphql(token, query) {
  const resp = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw new Error(`Cloudflare Analytics respondeu ${resp.status}`);
  if (json.errors?.length) throw new Error(json.errors[0].message || 'erro GraphQL');
  return json.data;
}

async function monthEgress(creds, dataset) {
  const now = new Date();
  const from = now.toISOString().slice(0, 8) + '01';
  const to = now.toISOString().slice(0, 10);
  const data = await cfGraphql(creds.token, `{
    viewer { accounts(filter: { accountTag: "${creds.accountId}" }) {
      usage: ${dataset}(limit: 10000, filter: { date_geq: "${from}", date_leq: "${to}" }) { sum { egressBytes } }
    } }
  }`);
  const rows = data?.viewer?.accounts?.[0]?.usage || [];
  return rows.reduce((sum, r) => sum + (Number(r.sum?.egressBytes) || 0), 0);
}

// The SFU usage dataset isn't in the public docs, so find it in the schema next to the TURN one
async function discoverSfuDataset(creds) {
  for (const typeName of ['account', 'Account']) {
    try {
      const data = await cfGraphql(creds.token, `{ __type(name: "${typeName}") { fields { name } } }`);
      const names = (data?.__type?.fields || []).map(f => f.name).filter(n => /^calls/i.test(n));
      if (names.length) {
        official.candidates = names;
        return names.find(n => /usage/i.test(n) && !/turn/i.test(n)) || null;
      }
    } catch {}
  }
  return null;
}

async function refreshOfficialUsage() {
  const creds = analyticsCredentials();
  if (!creds || Date.now() - official.at < 5 * 60 * 1000) return;
  official.at = Date.now();
  try {
    official.turnBytes = await monthEgress(creds, 'callsTurnUsageAdaptiveGroups');
    if (!official.sfuDataset) official.sfuDataset = await discoverSfuDataset(creds);
    official.sfuBytes = official.sfuDataset ? await monthEgress(creds, official.sfuDataset) : null;
    official.error = null;
  } catch (err) {
    official.error = err.message;
  }
}

// Billing-relevant usage this month. Analytics lag a few minutes behind live traffic, so the
// larger of Cloudflare's figure and our own running estimate is the safe one to act on.
async function usedBytesThisMonth() {
  await loadRelayUsage();
  await refreshOfficialUsage();
  const estimate = relayTotal();
  if (official.turnBytes == null) return { bytes: estimate, source: 'estimativa' };
  const measured = official.turnBytes + (official.sfuBytes || 0);
  return { bytes: Math.max(measured, estimate), source: 'cloudflare' };
}

app.get('/api/usage', async (req, res) => {
  const used = await usedBytesThisMonth();
  const gb = (b) => (b == null ? null : +(b / 1e9).toFixed(3));
  res.set('Cache-Control', 'no-store');
  res.json({
    usedGb: gb(used.bytes),
    capGb: TURN_CAP_BYTES / 1e9,
    source: used.source,
    estimateGb: gb(relayTotal()),
    estimateLoaded: relayUsage.loaded,
    official: {
      configured: !!analyticsCredentials(),
      turnGb: gb(official.turnBytes),
      sfuGb: gb(official.sfuBytes),
      sfuDataset: official.sfuDataset,
      candidates: official.candidates,
      error: official.error
    }
  });
});

app.post('/api/relay-usage', async (req, res) => {
  const bytes = Number(req.body?.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 5e9) {
    return res.status(400).json({ error: 'invalid bytes' });
  }
  await loadRelayUsage();
  relayTotal();
  relayUsage.session += bytes;
  saveRelayUsage();
  res.json({ ok: true });
});

// Which TURN variables are present, without revealing their values
function turnConfigState() {
  const has = (name) => !!(process.env[name] || '').trim();
  if (has('CF_TURN_KEY_ID') || has('CF_TURN_API_TOKEN')) {
    if (!has('CF_TURN_KEY_ID')) return 'falta CF_TURN_KEY_ID';
    if (!has('CF_TURN_API_TOKEN')) return 'falta CF_TURN_API_TOKEN';
    return 'cloudflare';
  }
  if (has('TURN_URLS')) return 'static';
  return 'nao configurado';
}

app.get('/api/ice-servers', async (req, res) => {
  let turn = [];
  let turnStatus = turnConfigState();
  const used = await usedBytesThisMonth();
  const usedBytes = used.bytes;
  if (usedBytes >= TURN_CAP_BYTES) {
    turnStatus = 'limite mensal de relay atingido';
  } else {
    try {
      turn = await getTurnServers();
      if (turn.length > 0) turnStatus = 'ok';
    } catch (err) {
      console.error('TURN credentials failed:', err.message);
      turnStatus = err.message;
    }
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    iceServers: [...STUN_SERVERS, ...turn],
    hasTurn: turn.length > 0,
    turnStatus,
    relayUsedGb: +(usedBytes / 1e9).toFixed(2),
    relayCapGb: TURN_CAP_BYTES / 1e9,
    usageSource: used.source
  });
});

// ======== SFU (Cloudflare Realtime) ========
// With 3+ viewers the host publishes once to the SFU instead of encoding and uploading a copy
// per viewer. The app secret never leaves this server; clients go through these routes.
// SFU egress shares the TURN free tier, so it is gated by the same monthly cap.
const SFU_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
const SFU_ID_RE = /^[a-f0-9]{16,64}$/i;

function sfuCredentials() {
  const appId = (process.env.CF_SFU_APP_ID || '').trim();
  const secret = (process.env.CF_SFU_APP_SECRET || '').trim();
  return appId && secret ? { appId, secret } : null;
}

async function sfuState() {
  if (!sfuCredentials()) return { enabled: false, reason: 'nao configurado' };
  const used = await usedBytesThisMonth();
  // The SFU carries every viewer's video, so never run it blind: without Cloudflare's figure
  // or the stored monthly total, a restart would forget what was already spent.
  if (used.source !== 'cloudflare' && SUPABASE_URL && SUPABASE_KEY && !relayUsage.loaded) {
    return { enabled: false, reason: 'contador de uso indisponivel' };
  }
  if (used.bytes >= TURN_CAP_BYTES) return { enabled: false, reason: 'limite mensal atingido' };
  return { enabled: true, reason: 'ok' };
}

async function sfuProxy(req, res, method, path, body) {
  const state = await sfuState();
  if (!state.enabled) return res.status(503).json({ errorDescription: state.reason });
  // Only rooms that exist on this server may spend the SFU quota
  const roomId = String(req.body?.roomId || req.query.roomId || '');
  if (!rooms.has(roomId)) return res.status(403).json({ errorDescription: 'sala invalida' });
  const { appId, secret } = sfuCredentials();
  try {
    const resp = await fetch(`${SFU_BASE}/${appId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await resp.text();
    res.status(resp.status).type('application/json').send(text || '{}');
  } catch (err) {
    res.status(502).json({ errorDescription: 'SFU inacessivel: ' + err.message });
  }
}

app.get('/api/sfu/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await sfuState());
});

app.post('/api/sfu/sessions', (req, res) => sfuProxy(req, res, 'POST', '/sessions/new'));

app.post('/api/sfu/sessions/:sid/tracks', (req, res) => {
  if (!SFU_ID_RE.test(req.params.sid)) return res.status(400).json({ errorDescription: 'sessao invalida' });
  const { sessionDescription, tracks } = req.body || {};
  sfuProxy(req, res, 'POST', `/sessions/${req.params.sid}/tracks/new`, { sessionDescription, tracks });
});

app.put('/api/sfu/sessions/:sid/renegotiate', (req, res) => {
  if (!SFU_ID_RE.test(req.params.sid)) return res.status(400).json({ errorDescription: 'sessao invalida' });
  sfuProxy(req, res, 'PUT', `/sessions/${req.params.sid}/renegotiate`, { sessionDescription: req.body?.sessionDescription });
});

// ======== Moderation ========
// Media flows peer to peer, so restarting this server doesn't end a stream and the host simply
// rejoins. Closing a room tells both sides to drop their connections and blocks the room id.
const BLOCK_MS = 24 * 3600 * 1000;
const blockedRooms = new Map();

function isBlocked(roomId) {
  const until = blockedRooms.get(roomId);
  if (!until) return false;
  if (until < Date.now()) { blockedRooms.delete(roomId); return false; }
  return true;
}

function closeRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return { hadHost: false, viewers: 0 };
  const result = { hadHost: !!room.host, viewers: room.viewers.size };
  for (const viewerId of room.viewers) {
    // Viewer pages tear down on 'host-left'; the host app drops each peer on 'viewer-left'
    io.to(viewerId).emit('host-left');
    if (room.host) io.to(room.host).emit('viewer-left', { viewerId });
  }
  io.to(roomId).emit('room-update', { hasHost: false, viewerCount: 0, hostOutdated: false });
  rooms.delete(roomId);
  return result;
}

// Blocks have to survive restarts, or a reconnecting host would bring the room straight back
async function loadBlockedRooms() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const since = new Date(Date.now() - BLOCK_MS).toISOString();
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/error_logs?source=eq.blocked-room&created_at=gte.${since}&select=room_id,created_at`,
      { headers: supabaseHeaders() }
    );
    if (!resp.ok) return;
    for (const row of await resp.json()) {
      if (!row.room_id) continue;
      blockedRooms.set(row.room_id, new Date(row.created_at).getTime() + BLOCK_MS);
      if (isBlocked(row.room_id)) closeRoom(row.room_id);
    }
  } catch {}
}

function isAdmin(req) {
  const given = Buffer.from(req.get('x-admin-key') || '');
  const expected = Buffer.from(SUPABASE_KEY || '');
  return expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

app.post('/api/admin/close-room', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const roomId = String(req.body?.roomId || '').slice(0, 50);
  if (!roomId) return res.status(400).json({ error: 'roomId required' });
  blockedRooms.set(roomId, Date.now() + BLOCK_MS);
  const result = closeRoom(roomId);
  let persisted = false;
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/error_logs`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ source: 'blocked-room', level: 'info', message: 'room closed by admin', room_id: roomId, context: result })
    });
    persisted = resp.ok;
  } catch {}
  res.json({ ok: true, ...result, blockedHours: BLOCK_MS / 3600000, persisted });
});

// Error logging proxy — clients POST here, server forwards to Supabase
app.post('/api/errors', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(503).json({ error: 'Logging not configured' });
  }
  const { source, level, message, stack, context, room_id, app_version, user_agent } = req.body;
  if (!source || !message) {
    return res.status(400).json({ error: 'source and message required' });
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/error_logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        source: String(source).slice(0, 50),
        level: String(level || 'error').slice(0, 20),
        message: String(message).slice(0, 5000),
        stack: stack ? String(stack).slice(0, 10000) : null,
        context: context || null,
        room_id: room_id ? String(room_id).slice(0, 50) : null,
        app_version: app_version ? String(app_version).slice(0, 20) : null,
        user_agent: user_agent ? String(user_agent).slice(0, 500) : null
      })
    });
    res.status(resp.ok ? 200 : 502).json({ ok: resp.ok });
  } catch {
    res.status(502).json({ error: 'Supabase request failed' });
  }
});

app.get('/api/room/create', (req, res) => {
  const roomId = uuidv4().slice(0, 8);
  rooms.set(roomId, { host: null, viewers: new Set(), createdAt: Date.now() });
  res.json({ roomId });
});

app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ exists: true, hasHost: !!room.host, viewerCount: room.viewers.size });
});

// Hosts up to 1.1.2 offer H264 baseline first (CPU encoding, one encode per viewer); 1.1.3+ put
// Main first. Lets us spot the really problematic builds even though they never report a version.
function offerLooksLegacy(sdp) {
  const lines = String(sdp || '').split('\r\n');
  const mLine = lines.find(l => l.startsWith('m=video'));
  if (!mLine) return false;
  for (const pt of mLine.split(' ').slice(3)) {
    const fmtp = lines.find(l => l.startsWith(`a=fmtp:${pt} `));
    const profile = fmtp && /profile-level-id=([0-9a-f]{2})/i.exec(fmtp);
    if (profile) return profile[1].toLowerCase() !== '4d';
  }
  return false;
}

function hostOutdated(room) {
  if (!room.host) return false;
  if (room.hostVersion) return versionOlder(room.hostVersion, LATEST_APP.minimum);
  return room.hostLegacy === true;
}

function emitRoomUpdate(roomId, room) {
  io.to(roomId).emit('room-update', {
    hasHost: !!room.host,
    viewerCount: room.viewers.size,
    hostOutdated: hostOutdated(room)
  });
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let role = null;

  socket.on('join-room', ({ roomId, asHost, appVersion }) => {
    if (isBlocked(roomId)) {
      // A closed room stays closed: the host gets no viewers and viewers see no host
      if (!asHost) socket.emit('room-update', { hasHost: false, viewerCount: 0, hostOutdated: false });
      return;
    }
    let room = rooms.get(roomId);
    if (!room) {
      room = { host: null, viewers: new Set(), createdAt: Date.now() };
      rooms.set(roomId, room);
    }

    currentRoom = roomId;
    socket.join(roomId);

    if (asHost) {
      room.host = socket.id;
      // Builds before 1.3.1 don't send a version at all
      room.hostVersion = typeof appVersion === 'string' ? appVersion.slice(0, 20) : null;
      room.hostLegacy = undefined;
      role = 'host';
      socket.to(roomId).emit('host-joined');
      for (const viewerId of room.viewers) {
        socket.emit('viewer-joined', { viewerId });
      }
    } else {
      room.viewers.add(socket.id);
      role = 'viewer';
      if (room.host) {
        io.to(room.host).emit('viewer-joined', { viewerId: socket.id });
      }
      if (room.sfu) socket.emit('sfu-start', room.sfu);
    }

    emitRoomUpdate(roomId, room);
  });

  socket.on('offer', ({ to, offer, sid }) => {
    io.to(to).emit('offer', { from: socket.id, offer, sid });
    const room = currentRoom && rooms.get(currentRoom);
    if (room && role === 'host' && !room.hostVersion && room.hostLegacy === undefined) {
      room.hostLegacy = offerLooksLegacy(offer?.sdp);
      if (room.hostLegacy) emitRoomUpdate(currentRoom, room);
    }
  });

  socket.on('answer', ({ to, answer, sid }) => {
    io.to(to).emit('answer', { from: socket.id, answer, sid });
  });

  socket.on('ice-candidate', ({ to, candidate, sid }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate, sid });
  });

  // Host switched the room to the SFU: viewers pull the published tracks instead of a P2P offer
  socket.on('sfu-start', ({ sessionId, tracks }) => {
    if (!currentRoom || role !== 'host') return;
    const room = rooms.get(currentRoom);
    if (!room || !SFU_ID_RE.test(String(sessionId)) || !Array.isArray(tracks)) return;
    room.sfu = { sessionId, tracks: tracks.slice(0, 4).map(t => String(t).slice(0, 32)) };
    socket.to(currentRoom).emit('sfu-start', room.sfu);
  });

  socket.on('sfu-stop', () => {
    if (!currentRoom || role !== 'host') return;
    const room = rooms.get(currentRoom);
    if (!room || !room.sfu) return;
    room.sfu = null;
    socket.to(currentRoom).emit('sfu-stop');
  });

  // A viewer that can't reach the SFU asks the host for a direct connection instead
  socket.on('sfu-fallback', () => {
    if (!currentRoom || role !== 'viewer') return;
    const room = rooms.get(currentRoom);
    if (room?.host) io.to(room.host).emit('viewer-needs-p2p', { viewerId: socket.id });
  });

  socket.on('host-pause', () => {
    if (!currentRoom || role !== 'host') return;
    const room = rooms.get(currentRoom);
    if (room) room.sfu = null;
    socket.to(currentRoom).emit('host-paused');
  });

  socket.on('host-resume', () => {
    if (!currentRoom || role !== 'host') return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    socket.to(currentRoom).emit('host-joined');
    for (const viewerId of room.viewers) {
      socket.emit('viewer-joined', { viewerId });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (role === 'host') {
      // A reconnected host may already own the room under a new socket id
      if (room.host === socket.id) {
        room.host = null;
        room.sfu = null;
        socket.to(currentRoom).emit('host-left');
      }
    } else {
      room.viewers.delete(socket.id);
      if (room.host) {
        io.to(room.host).emit('viewer-left', { viewerId: socket.id });
      }
    }

    emitRoomUpdate(currentRoom, room);

    if (!room.host && room.viewers.size === 0) {
      rooms.delete(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  loadBlockedRooms();
});
