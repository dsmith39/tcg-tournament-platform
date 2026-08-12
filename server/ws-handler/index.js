/*
 * API Gateway WebSocket API Lambda handler ($connect/$disconnect/$default).
 *
 * A separate, minimal Lambda from the main Express app -- this one speaks
 * API Gateway's native WebSocket Lambda-proxy event shape
 * ({requestContext:{connectionId, routeKey}}), not HTTP, so it isn't run
 * through the Lambda Web Adapter the main app uses. It only tracks which
 * connections exist (server/realtime.js does the actual broadcasting by
 * scanning this table from the main app's Lambda). The frontend never sends
 * inbound messages, so $default is a no-op.
 *
 * Relies on the AWS SDK v3 bundled with the Node.js Lambda runtime rather
 * than a bundled node_modules, keeping this deployment zip tiny.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;

exports.handler = async (event) => {
  const { connectionId, routeKey } = event.requestContext;

  if (routeKey === '$connect') {
    await client.send(new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        connectedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 86400
      }
    }));
  } else if (routeKey === '$disconnect') {
    await client.send(new DeleteCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId }
    }));
  }

  // $default (and anything else): no-op, the frontend never sends inbound messages.
  return { statusCode: 200, body: '' };
};
