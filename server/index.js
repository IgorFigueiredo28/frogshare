const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3030;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const app = express();
// Render sits behind a proxy; this makes req.ip the client's address for the rate limits
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors());

// Baseline browser protections for the site; it loads nothing from elsewhere except Google Fonts
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' wss: https://rtc.live.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  });
  next();
});

// Small per-IP limiter for the routes that write or allocate. In memory: resets on restart, which is fine.
function rateLimit(max, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > max) return res.status(429).json({ error: 'muitas requisicoes, tente de novo em instantes' });
    next();
  };
}

// Room ids come from links people paste; anything else is refused before it touches the room map
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
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
    if (hostSockets(room).length === 0 && room.viewers.size === 0 && now - room.createdAt > 600000) {
      rooms.delete(id);
    }
  }
}, 600000);

app.get('/health', (req, res) => res.send('ok'));

// ======== App version ========
// Hosts on old builds encode on the CPU once per viewer and stutter badly, and nothing told
// anyone. The app checks this on start; viewers are told when the room's host is behind.
const LATEST_APP = {
  version: '1.6.3',
  // Below this the host has no GPU encoding, TURN, upload sharing or SFU
  minimum: '1.3.0',
  // The Windows installer attached to this version's GitHub release (the repo is public)
  url: 'https://github.com/IgorFigueiredo28/frogshare/releases/download/v1.6.3/FrogShare.Setup.1.6.3.exe',
  // Exactly that file: the in-app updater refuses anything that doesn't match
  size: 112021630,
  sha512: '2JCC5lH2M56EBwJk8dhxuwEilce9Fy8kLfy0v4S8eZVkJUu2R21nslxM5zqEmvpmRZVLRDYoouW8+0aG5bhR1Q==',
  // Apple Silicon .dmg; the site hides its download button while this is null
  macUrl: 'https://drive.usercontent.google.com/download?id=17eAsGhGXXWTauVKpL8l7T2Xkyvn_wr-E&export=download'
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
  // Hosts report the estimate without any proof, so once Cloudflare's billing figure is available it
  // alone decides: otherwise anyone could post inflated numbers and switch relay off for everyone
  if (official.turnBytes == null || official.error) return { bytes: estimate, source: 'estimativa' };
  return { bytes: official.turnBytes + (official.sfuBytes || 0), source: 'cloudflare' };
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

app.post('/api/relay-usage', rateLimit(12, 60000), async (req, res) => {
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

const sfuLimit = rateLimit(120, 60000);
app.post('/api/sfu/sessions', sfuLimit, (req, res) => sfuProxy(req, res, 'POST', '/sessions/new'));

app.post('/api/sfu/sessions/:sid/tracks', sfuLimit, (req, res) => {
  if (!SFU_ID_RE.test(req.params.sid)) return res.status(400).json({ errorDescription: 'sessao invalida' });
  const { sessionDescription, tracks } = req.body || {};
  sfuProxy(req, res, 'POST', `/sessions/${req.params.sid}/tracks/new`, { sessionDescription, tracks });
});

app.put('/api/sfu/sessions/:sid/renegotiate', sfuLimit, (req, res) => {
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
  const hosts = hostSockets(room);
  for (const viewerId of room.viewers) {
    // Viewer pages tear down on 'host-left'; the host apps drop each peer on 'viewer-left'
    for (const hostId of hosts) {
      io.to(viewerId).emit('host-left', { hostId });
      io.to(hostId).emit('viewer-left', { viewerId });
    }
  }
  for (const [id] of room.cohosts || []) io.to(id).emit('group-ended', { reason: 'A sala foi fechada.' });
  io.to(roomId).emit('room-update', { hasHost: false, viewerCount: 0, hostOutdated: false, group: false, hosts: [] });
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

// A key of its own, so the database's master key never has to travel in a request.
// Without ADMIN_KEY set, the admin routes are simply off.
function isAdmin(req) {
  const given = Buffer.from(req.get('x-admin-key') || '');
  const expected = Buffer.from((process.env.ADMIN_KEY || '').trim());
  return expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

app.post('/api/admin/close-room', rateLimit(10, 60000), async (req, res) => {
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

// Recent stream quality reports (hosts every minute, viewers every minute), to diagnose stutter
// without a database login. Admin key only: rows carry room ids and user agents.
app.get('/api/admin/telemetry', rateLimit(20, 60000), async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ error: 'logging not configured' });
  const minutes = Math.min(Math.max(parseInt(req.query.minutes, 10) || 180, 1), 7 * 24 * 60);
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const sources = String(req.query.sources || 'host-stats,viewer-stats').split(',').filter(s => /^[a-z-]{1,30}$/.test(s));
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/error_logs?source=in.(${sources.join(',')})&created_at=gte.${since}` +
      '&order=created_at.desc&limit=1000&select=created_at,source,level,message,room_id,app_version,context',
      { headers: supabaseHeaders() }
    );
    res.set('Cache-Control', 'no-store');
    res.status(resp.ok ? 200 : 502).json(resp.ok ? await resp.json() : { error: `supabase ${resp.status}` });
  } catch {
    res.status(502).json({ error: 'Supabase request failed' });
  }
});

// Rows the server itself writes and later trusts (usage totals, room blocks) must not be forgeable here
const INTERNAL_LOG_SOURCES = new Set(['turn-usage', 'blocked-room']);

// Error logging proxy — clients POST here, server forwards to Supabase
app.post('/api/errors', rateLimit(60, 60000), async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(503).json({ error: 'Logging not configured' });
  }
  const { source, level, message, stack, context, room_id, app_version, user_agent } = req.body;
  if (!source || !message) {
    return res.status(400).json({ error: 'source and message required' });
  }
  if (INTERNAL_LOG_SOURCES.has(String(source))) return res.status(403).json({ error: 'reserved source' });
  const contextJson = context == null ? null : JSON.stringify(context);
  if (contextJson && contextJson.length > 16000) return res.status(413).json({ error: 'context too large' });
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

// The host key proves who created the room. Apps from 1.4.6 send it back when joining as host;
// without it, a viewer who knows the room id could claim to be the host and take over the stream.
const newHostKey = () => crypto.randomBytes(24).toString('base64url');
const sameKey = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

app.get('/api/room/create', rateLimit(20, 60000), (req, res) => {
  const roomId = crypto.randomUUID().slice(0, 8);
  const hostKey = newHostKey();
  rooms.set(roomId, newRoom({ hostKey }));
  res.json({ roomId, hostKey });
});

app.get('/api/room/:id', (req, res) => {
  if (!ROOM_ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Room not found' });
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

// ======== Group streaming ========
// The room's owner (the host that created it) can open it to up to 3 more streamers. Anyone in the
// room may then join as a co-host; the owner can remove one or close the group (which removes all).
// Each streamer has a slot (0 = owner) that picks its frog colour on every screen.
const MAX_COHOSTS = 3;
const cleanName = (name, fallback) => {
  const s = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
  return s || fallback;
};
const newRoom = (extra) => ({ host: null, hostKey: null, strict: false, viewers: new Set(), cohosts: new Map(), group: false, createdAt: Date.now(), ...extra });

function hostSockets(room) {
  return [room.host, ...(room.cohosts ? room.cohosts.keys() : [])].filter(Boolean);
}

function hostsList(room) {
  const list = [];
  if (room.host) list.push({ id: room.host, name: room.hostName || 'Host', slot: 0, paused: !!room.hostPaused, owner: true });
  for (const [id, c] of room.cohosts || []) list.push({ id, name: c.name, slot: c.slot, paused: !!c.paused, owner: false });
  return list;
}

function freeSlot(room) {
  const used = new Set([...(room.cohosts || new Map()).values()].map(c => c.slot));
  for (let slot = 1; slot <= MAX_COHOSTS; slot++) if (!used.has(slot)) return slot;
  return null;
}

// Removes a co-host from the room: it stops streaming there and every viewer drops that stream
function removeCohost(roomId, room, id, reason) {
  if (!room.cohosts?.has(id)) return;
  room.cohosts.delete(id);
  io.to(id).emit('group-ended', { reason });
  for (const viewerId of room.viewers) io.to(viewerId).emit('host-left', { hostId: id });
  const s = io.sockets.sockets.get(id);
  if (s) s.leave(roomId);
}

function emitRoomUpdate(roomId, room) {
  io.to(roomId).emit('room-update', {
    hasHost: hostSockets(room).length > 0,
    viewerCount: room.viewers.size,
    hostOutdated: hostOutdated(room),
    group: !!room.group,
    hosts: hostsList(room)
  });
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let role = null; // 'host' (owner), 'cohost' or 'viewer'
  const isStreamer = () => role === 'host' || role === 'cohost';
  const offerRequests = new Map(); // hostId -> last request-offer time
  const myRoom = () => (currentRoom && rooms.get(currentRoom)) || null;

  // Signaling only flows between members of the same room
  const inMyRoom = (id) => {
    const room = myRoom();
    return !!room && (room.host === id || room.viewers.has(id) || !!room.cohosts?.has(id));
  };

  function enterRoom(roomId) {
    if (currentRoom && currentRoom !== roomId) socket.leave(currentRoom);
    currentRoom = roomId;
    socket.join(roomId);
  }

  // A streamer (owner or co-host) going live: tell viewers and get an offer to each of them
  function announceStreamer(room) {
    socket.to(currentRoom).emit('host-joined', { hostId: socket.id });
    for (const viewerId of room.viewers) socket.emit('viewer-joined', { viewerId });
  }

  socket.on('join-room', ({ roomId, asHost, appVersion, hostKey, coHost, name } = {}) => {
    if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) return;
    if (isBlocked(roomId)) {
      // A closed room stays closed: the host gets no viewers and viewers see no host
      if (!asHost) socket.emit('room-update', { hasHost: false, viewerCount: 0, hostOutdated: false, group: false, hosts: [] });
      return;
    }
    let room = rooms.get(roomId);

    // ---- Co-host: joins someone else's room while its group is open ----
    if (asHost && coHost) {
      if (!room || !room.group) {
        socket.emit('host-rejected', { reason: 'O dono da sala não abriu a transmissão em grupo.', group: true });
        return;
      }
      if (room.host === socket.id) return;
      let entry = room.cohosts.get(socket.id);
      if (!entry) {
        const slot = freeSlot(room);
        if (slot == null) {
          socket.emit('host-rejected', { reason: 'O grupo já tem 4 pessoas transmitindo.', group: true });
          return;
        }
        entry = { slot, name: cleanName(name, 'Amigo ' + slot), paused: false, sfu: null };
        room.cohosts.set(socket.id, entry);
      }
      enterRoom(roomId);
      role = 'cohost';
      room.viewers.delete(socket.id);
      socket.emit('cohost-accepted', { slot: entry.slot, ownerName: room.hostName || 'Host' });
      announceStreamer(room);
      emitRoomUpdate(roomId, room);
      return;
    }

    if (asHost) {
      // Who may act as host:
      // - with the room's key: always (also how a host takes its room back after a reconnect)
      // - a room this server doesn't know, or only knows from viewers (it restarted): whoever
      //   brings it back, keeping their key
      // - builds before 1.4.6 send no key: only while nobody is hosting and no key holder has joined
      const key = hostKey ? String(hostKey).slice(0, 64) : null;
      if (!room) {
        room = newRoom({ hostKey: key, strict: !!key });
        rooms.set(roomId, room);
      } else if (sameKey(key, room.hostKey)) {
        room.strict = true;
      } else if (key && !room.hostKey && !room.host && !room.strict) {
        room.hostKey = key;
        room.strict = true;
      } else if (key || room.host || room.strict) {
        socket.emit('host-rejected', { reason: 'Esta sala pertence a outro host.' });
        return;
      }
    } else if (!room) {
      room = newRoom();
      rooms.set(roomId, room);
    }

    enterRoom(roomId);

    if (asHost) {
      room.host = socket.id;
      room.hostName = cleanName(name, 'Host');
      room.hostPaused = false;
      // Builds before 1.3.1 don't send a version at all
      room.hostVersion = typeof appVersion === 'string' ? appVersion.slice(0, 20) : null;
      room.hostLegacy = undefined;
      role = 'host';
      announceStreamer(room);
    } else {
      if (room.viewers.size >= 200) return;
      room.viewers.add(socket.id);
      role = 'viewer';
      for (const hostId of hostSockets(room)) io.to(hostId).emit('viewer-joined', { viewerId: socket.id });
      if (room.sfu) socket.emit('sfu-start', { hostId: room.host, ...room.sfu });
      for (const [id, c] of room.cohosts) if (c.sfu) socket.emit('sfu-start', { hostId: id, ...c.sfu });
    }

    emitRoomUpdate(roomId, room);
  });

  // ---- Owner controls for the group ----
  socket.on('group-mode', ({ enabled } = {}) => {
    const room = myRoom();
    if (!room || role !== 'host' || room.host !== socket.id) return;
    room.group = !!enabled;
    if (!room.group) {
      for (const id of [...room.cohosts.keys()]) removeCohost(currentRoom, room, id, 'O dono da sala encerrou a transmissão em grupo.');
    }
    emitRoomUpdate(currentRoom, room);
  });

  socket.on('kick-host', ({ hostId } = {}) => {
    const room = myRoom();
    if (!room || role !== 'host' || room.host !== socket.id) return;
    removeCohost(currentRoom, room, String(hostId), 'O dono da sala tirou você do grupo.');
    emitRoomUpdate(currentRoom, room);
  });

  socket.on('set-name', ({ name } = {}) => {
    const room = myRoom();
    if (!room) return;
    if (role === 'host' && room.host === socket.id) room.hostName = cleanName(name, 'Host');
    else if (role === 'cohost' && room.cohosts.has(socket.id)) room.cohosts.get(socket.id).name = cleanName(name, 'Amigo');
    else return;
    emitRoomUpdate(currentRoom, room);
  });

  // A viewer watching one stream tells the others it doesn't need their video for now
  socket.on('watch', ({ hostId, video } = {}) => {
    if (role !== 'viewer' || !inMyRoom(hostId)) return;
    io.to(hostId).emit('viewer-watch', { viewerId: socket.id, video: video !== false });
  });

  // A viewer lost one streamer's connection: reconnect just that one (the media server if it
  // publishes there, otherwise a fresh direct offer), leaving the other streams alone.
  socket.on('request-offer', ({ hostId } = {}) => {
    const room = myRoom();
    if (role !== 'viewer' || !room || typeof hostId !== 'string') return;
    // A broken connection retries every few seconds at most; anything faster is not a real viewer
    const now = Date.now();
    if (now - (offerRequests.get(hostId) || 0) < 1500) return;
    offerRequests.set(hostId, now);
    let sfu;
    if (room.host === hostId) sfu = room.sfu;
    else if (room.cohosts.has(hostId)) sfu = room.cohosts.get(hostId).sfu;
    else return;
    if (sfu) socket.emit('sfu-start', { hostId, ...sfu });
    else io.to(hostId).emit('viewer-joined', { viewerId: socket.id });
  });

  socket.on('offer', ({ to, offer, sid } = {}) => {
    if (!isStreamer() || !inMyRoom(to)) return;
    io.to(to).emit('offer', { from: socket.id, offer, sid });
    const room = myRoom();
    if (room && role === 'host' && !room.hostVersion && room.hostLegacy === undefined) {
      room.hostLegacy = offerLooksLegacy(offer?.sdp);
      if (room.hostLegacy) emitRoomUpdate(currentRoom, room);
    }
  });

  socket.on('answer', ({ to, answer, sid } = {}) => {
    if (!inMyRoom(to)) return;
    io.to(to).emit('answer', { from: socket.id, answer, sid });
  });

  socket.on('ice-candidate', ({ to, candidate, sid } = {}) => {
    if (!inMyRoom(to)) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate, sid });
  });

  // A streamer switched to the SFU: viewers pull its published tracks instead of a P2P offer
  socket.on('sfu-start', ({ sessionId, tracks } = {}) => {
    const room = myRoom();
    if (!room || !isStreamer() || !SFU_ID_RE.test(String(sessionId)) || !Array.isArray(tracks)) return;
    const sfu = { sessionId, tracks: tracks.slice(0, 4).map(t => String(t).slice(0, 32)) };
    if (role === 'host') room.sfu = sfu;
    else if (room.cohosts.has(socket.id)) room.cohosts.get(socket.id).sfu = sfu;
    else return;
    socket.to(currentRoom).emit('sfu-start', { hostId: socket.id, ...sfu });
  });

  socket.on('sfu-stop', () => {
    const room = myRoom();
    if (!room || !isStreamer()) return;
    if (role === 'host') { if (!room.sfu) return; room.sfu = null; }
    else { const c = room.cohosts.get(socket.id); if (!c?.sfu) return; c.sfu = null; }
    socket.to(currentRoom).emit('sfu-stop', { hostId: socket.id });
  });

  // A viewer that can't reach the SFU asks that streamer for a direct connection instead
  socket.on('sfu-fallback', ({ hostId } = {}) => {
    const room = myRoom();
    if (!room || role !== 'viewer') return;
    const target = hostId && inMyRoom(hostId) ? hostId : room.host;
    if (target) io.to(target).emit('viewer-needs-p2p', { viewerId: socket.id });
  });

  socket.on('host-pause', () => {
    const room = myRoom();
    if (!room || !isStreamer()) return;
    if (role === 'host') { room.sfu = null; room.hostPaused = true; }
    else if (room.cohosts.has(socket.id)) Object.assign(room.cohosts.get(socket.id), { sfu: null, paused: true });
    socket.to(currentRoom).emit('host-paused', { hostId: socket.id });
    emitRoomUpdate(currentRoom, room);
  });

  socket.on('host-resume', () => {
    const room = myRoom();
    if (!room || !isStreamer()) return;
    if (role === 'host') room.hostPaused = false;
    else if (room.cohosts.has(socket.id)) room.cohosts.get(socket.id).paused = false;
    announceStreamer(room);
    emitRoomUpdate(currentRoom, room);
  });

  // A co-host leaving on purpose (stopped in the app) frees its slot right away
  socket.on('leave-group', () => {
    const room = myRoom();
    if (!room || role !== 'cohost') return;
    room.cohosts.delete(socket.id);
    socket.to(currentRoom).emit('host-left', { hostId: socket.id });
    socket.leave(currentRoom);
    emitRoomUpdate(currentRoom, room);
    currentRoom = null;
    role = null;
  });

  socket.on('disconnect', () => {
    const room = myRoom();
    if (!room) return;

    if (role === 'host') {
      // A reconnected host may already own the room under a new socket id
      if (room.host === socket.id) {
        room.host = null;
        room.sfu = null;
        socket.to(currentRoom).emit('host-left', { hostId: socket.id });
      }
    } else if (role === 'cohost') {
      if (room.cohosts.delete(socket.id)) socket.to(currentRoom).emit('host-left', { hostId: socket.id });
    } else {
      room.viewers.delete(socket.id);
      for (const hostId of hostSockets(room)) io.to(hostId).emit('viewer-left', { viewerId: socket.id });
    }

    emitRoomUpdate(currentRoom, room);

    if (hostSockets(room).length === 0 && room.viewers.size === 0) {
      rooms.delete(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  loadBlockedRooms();
});
