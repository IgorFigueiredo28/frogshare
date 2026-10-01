const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const PORT = process.env.PORT || 3030;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: '16kb' }));
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
        body: JSON.stringify({ ttl: 86400 })
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

  if (servers.length > 0) turnCache = { servers, expires: Date.now() + 12 * 3600 * 1000 };
  return servers;
}

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
  try {
    turn = await getTurnServers();
    if (turn.length > 0) turnStatus = 'ok';
  } catch (err) {
    console.error('TURN credentials failed:', err.message);
    turnStatus = err.message;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers: [...STUN_SERVERS, ...turn], hasTurn: turn.length > 0, turnStatus });
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

io.on('connection', (socket) => {
  let currentRoom = null;
  let role = null;

  socket.on('join-room', ({ roomId, asHost }) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = { host: null, viewers: new Set(), createdAt: Date.now() };
      rooms.set(roomId, room);
    }

    currentRoom = roomId;
    socket.join(roomId);

    if (asHost) {
      room.host = socket.id;
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
    }

    io.to(roomId).emit('room-update', {
      hasHost: !!room.host,
      viewerCount: room.viewers.size
    });
  });

  socket.on('offer', ({ to, offer, sid }) => {
    io.to(to).emit('offer', { from: socket.id, offer, sid });
  });

  socket.on('answer', ({ to, answer, sid }) => {
    io.to(to).emit('answer', { from: socket.id, answer, sid });
  });

  socket.on('ice-candidate', ({ to, candidate, sid }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate, sid });
  });

  socket.on('host-pause', () => {
    if (!currentRoom || role !== 'host') return;
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
        socket.to(currentRoom).emit('host-left');
      }
    } else {
      room.viewers.delete(socket.id);
      if (room.host) {
        io.to(room.host).emit('viewer-left', { viewerId: socket.id });
      }
    }

    io.to(currentRoom).emit('room-update', {
      hasHost: !!room.host,
      viewerCount: room.viewers.size
    });

    if (!room.host && room.viewers.size === 0) {
      rooms.delete(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
