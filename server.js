/*
 * Entrypoint for the unified HTTP server.
 *
 * Responsibilities:
 * - Boot Express (and, for local dev, Socket.IO) on one shared Node HTTP server.
 * - Register API routes from server/api-server.js.
 * - Serve the static single-page frontend shell and its assets.
 *
 * Live tournament/decklist updates use Socket.IO here by default
 * (REALTIME_TRANSPORT=socketio, the local-dev default) since there's no
 * AWS-native local emulator for API Gateway WebSocket APIs. The deployed
 * Lambda sets REALTIME_TRANSPORT=apigw-ws instead, so this file skips
 * Socket.IO entirely and server/realtime.js broadcasts through a separate
 * WebSocket API (server/ws-handler/) instead -- see server/realtime.js.
 */
const http = require('http');
const express = require('express');
require('dotenv').config();

const { registerApi } = require('./server/api-server');
const { attachSocketIo } = require('./server/realtime');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const useSocketIo = (process.env.REALTIME_TRANSPORT || 'socketio') === 'socketio';
const FRONTEND_HTML = 'tcg-frontend-updated.html';
const FRONTEND_CSS = 'tcg-frontend.css';
const FRONTEND_JS = 'tcg-frontend.js';

const expressApp = express();
const server = http.createServer(expressApp);

if (useSocketIo) {
  // Socket.IO shares the same HTTP server so tournament/decklist updates can push live to clients.
  const { Server } = require('socket.io');
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'DELETE']
    }
  });
  io.on('connection', (socket) => {
    socket.emit('socket:ready', { connectedAt: Date.now() });
  });
  attachSocketIo(io);
}

// Mount API endpoints after middleware/server primitives are ready.
registerApi(expressApp);

// Serve the legacy static frontend assets directly. Pass a bare filename with
// a `root` option rather than a precomputed absolute path -- res.sendFile()
// runs the path argument through encodeURI(), which turns Windows backslash
// separators into %5C and breaks the lookup on Windows dev machines. `root`
// itself is never encodeURI'd, so it can safely be an absolute path.
expressApp.get('/tcg-frontend.css', (req, res) => {
  res.sendFile(FRONTEND_CSS, { root: __dirname });
});

expressApp.get('/tcg-frontend.js', (req, res) => {
  res.sendFile(FRONTEND_JS, { root: __dirname });
});

// Every non-API and non-Socket.IO route should render the single-page frontend shell.
expressApp.get(/^(?!\/(api|socket\.io)).*/, (req, res) => {
  res.sendFile(FRONTEND_HTML, { root: __dirname });
});

// Bind host/port from environment for local and CI compatibility.
server.listen(port, host, () => {
  console.log(`Static frontend + API server running on http://${host}:${port}`);
});
