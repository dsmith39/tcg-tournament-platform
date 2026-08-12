/*
 * Transport-agnostic broadcast helpers for the two live-update event types
 * (tournaments:updated, decklists:updated). Replaces the old io.emit(...)
 * calls that lived directly in api-server.js.
 *
 * Local dev keeps using Socket.IO: server.js calls attachSocketIo(io) once
 * at boot, and every broadcast becomes a same-process io.emit(...) -- no
 * AWS-native local emulator exists for API Gateway WebSocket APIs, so
 * requiring real deployed infra for every local code change would be a
 * worse trade than keeping Socket.IO around for this one path (see
 * server/ws-handler.js's header comment for the deployed side).
 *
 * Deployed (no Socket.IO instance attached) broadcasts by scanning the
 * Connections table (populated by server/ws-handler.js's $connect/
 * $disconnect routes) and pushing to each connection via API Gateway's
 * PostToConnection. A connection that's gone stale (GoneException/410) is
 * deleted inline; any other per-connection failure is swallowed so one bad
 * connection doesn't break the broadcast for everyone else. This is a
 * simple unauthenticated global broadcast -- matches today's Socket.IO
 * behavior exactly (no rooms, no auth, no per-user targeting).
 */
const { ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { getClient } = require('./dynamo');
const { TABLE_NAMES } = require('./dynamo-schema');

const toIdString = (value) => (value ? value.toString() : null);

let socketIoInstance = null;
let apiGatewayClient = null;

function attachSocketIo(io) {
  socketIoInstance = io;
}

function getApiGatewayClient() {
  if (!apiGatewayClient) {
    // Lazy require: @aws-sdk/client-apigatewaymanagementapi is only needed
    // once WS_API_ENDPOINT is actually set (i.e. deployed), keeping local
    // dev's Socket.IO path free of any AWS Lambda-only wiring.
    const { ApiGatewayManagementApiClient } = require('@aws-sdk/client-apigatewaymanagementapi');
    apiGatewayClient = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_API_ENDPOINT });
  }
  return apiGatewayClient;
}

async function broadcastViaApiGateway(type, payload) {
  if (!process.env.WS_API_ENDPOINT) return;

  const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
  const { Items } = await getClient().send(new ScanCommand({ TableName: TABLE_NAMES.CONNECTIONS_TABLE }));
  const message = Buffer.from(JSON.stringify({ type, ...payload }));

  await Promise.all((Items || []).map(async ({ connectionId }) => {
    try {
      await getApiGatewayClient().send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: message }));
    } catch (error) {
      if (error.name === 'GoneException') {
        await getClient().send(new DeleteCommand({ TableName: TABLE_NAMES.CONNECTIONS_TABLE, Key: { connectionId } }));
      }
    }
  }));
}

async function broadcast(type, payload) {
  if (socketIoInstance) {
    socketIoInstance.emit(type, payload);
    return;
  }
  await broadcastViaApiGateway(type, payload);
}

// Call sites in api-server.js fire these without awaiting (a broadcast
// shouldn't delay the HTTP response to the client who triggered it), so
// failures are caught and logged here rather than becoming an unhandled
// promise rejection.
function broadcastTournamentUpdate(reason, tournament) {
  if (!tournament) return;
  broadcast('tournaments:updated', {
    reason,
    tournamentId: toIdString(tournament._id || tournament.id),
    name: tournament.name || 'Tournament',
    status: tournament.status || 'registration'
  }).catch((error) => console.error('broadcastTournamentUpdate failed:', error.message));
}

function broadcastDecklistUpdate(reason, decklist) {
  if (!decklist) return;
  broadcast('decklists:updated', {
    reason,
    decklistId: toIdString(decklist._id || decklist.id),
    ownerId: toIdString(decklist.owner?._id || decklist.owner),
    isPublic: decklist.isPublic !== false,
    name: decklist.name || 'Decklist'
  }).catch((error) => console.error('broadcastDecklistUpdate failed:', error.message));
}

module.exports = { attachSocketIo, broadcastTournamentUpdate, broadcastDecklistUpdate };
