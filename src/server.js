const express = require('express');
const http = require('http');
const path = require('path');

// Serves the app's own pages (host UI and the live notice) to its windows, on loopback only.
// Rooms and signaling live on the public server; nothing here talks to the network.
function createServer(port = 3030) {
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);

  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Theme, mascot and icons are shared with the website; one copy lives with the site
  app.use('/brand', express.static(path.join(__dirname, '..', 'server', 'public', 'brand')));
  // Bundled with the app rather than loaded from a CDN: the page can't start until it's there, and a
  // slow or blocked CDN used to hold the whole UI up
  // (the package's exports map hides the minified file, so locate it from its package.json)
  const socketIoClient = path.join(path.dirname(require.resolve('socket.io-client/package.json')), 'dist', 'socket.io.min.js');
  app.get('/vendor/socket.io.min.js', (req, res) => res.sendFile(socketIoClient));

  return new Promise((resolve) => {
    server.once('listening', () => {
      const actualPort = server.address().port;
      console.log(`Server running on http://localhost:${actualPort}`);
      resolve({ server, port: actualPort });
    });
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') server.listen(0, '127.0.0.1');
    });
    server.listen(port, '127.0.0.1');
  });
}

module.exports = { createServer };
