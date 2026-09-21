const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

function createServer(port = 3030) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const rooms = new Map();

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

    socket.on('offer', ({ to, offer }) => {
      io.to(to).emit('offer', { from: socket.id, offer });
    });

    socket.on('answer', ({ to, answer }) => {
      io.to(to).emit('answer', { from: socket.id, answer });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
      io.to(to).emit('ice-candidate', { from: socket.id, candidate });
    });

    socket.on('disconnect', () => {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (!room) return;

      if (role === 'host') {
        room.host = null;
        socket.to(currentRoom).emit('host-left');
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

  return new Promise((resolve) => {
    server.once('listening', () => {
      const actualPort = server.address().port;
      console.log(`Server running on http://localhost:${actualPort}`);
      resolve({ server, io, port: actualPort });
    });
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') server.listen(0, '127.0.0.1');
    });
    server.listen(port, '127.0.0.1');
  });
}

module.exports = { createServer };
