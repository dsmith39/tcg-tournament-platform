/*
 * Entrypoint for the unified HTTP server.
 *
 * Responsibilities:
 * - Boot Express + Socket.IO on one shared Node HTTP server.
 * - Register API routes from server/api-server.js.
 * - Serve the static single-page frontend shell and its assets.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
require('dotenv').config();

const { registerApi } = require('./server/api-server');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const frontendHtmlPath = path.resolve(__dirname, 'tcg-frontend-updated.html');
const frontendCssPath = path.resolve(__dirname, 'tcg-frontend.css');
const frontendJsPath = path.resolve(__dirname, 'tcg-frontend.js');

const expressApp = express();
const server = http.createServer(expressApp);

// Socket.IO shares the same HTTP server so tournament/decklist updates can push live to clients.
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

// Mount API endpoints after middleware/server primitives are ready.
registerApi(expressApp, io);

// Serve the legacy static frontend assets directly.
expressApp.get('/tcg-frontend.css', (req, res) => {
  res.sendFile(frontendCssPath);
});

expressApp.get('/tcg-frontend.js', (req, res) => {
  res.sendFile(frontendJsPath);
});

// Every non-API and non-Socket.IO route should render the single-page frontend shell.
expressApp.get(/^(?!\/(api|socket\.io)).*/, (req, res) => {
  res.sendFile(frontendHtmlPath);
});

// Bind host/port from environment for local and CI compatibility.
server.listen(port, host, () => {
  console.log(`Static frontend + API server running on http://${host}:${port}`);
});
