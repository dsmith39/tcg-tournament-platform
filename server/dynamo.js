/*
 * DynamoDB connection shared by server/models/*.js.
 *
 * Points at real AWS DynamoDB by default -- the operator's own credentials
 * via the AWS SDK's normal credential chain locally, or the Lambda execution
 * role once deployed. Tests set DYNAMODB_ENDPOINT to a local dynalite
 * instance instead, mirroring server/db.js's old :memory: contract with
 * resetTables() standing in for resetDb().
 */
const { DynamoDBClient, CreateTableCommand, DeleteTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { TABLE_DEFINITIONS } = require('./dynamo-schema');

let rawClient = null;
let docClient = null;

function getClient() {
  if (!docClient) {
    const config = {};
    if (process.env.DYNAMODB_ENDPOINT) {
      config.endpoint = process.env.DYNAMODB_ENDPOINT;
      config.region = 'local';
      config.credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
    }
    rawClient = new DynamoDBClient(config);
    docClient = DynamoDBDocumentClient.from(rawClient, {
      marshallOptions: { removeUndefinedValues: true }
    });
  }
  return docClient;
}

// Test-only: drop and recreate every table against the dynalite endpoint set
// via DYNAMODB_ENDPOINT, giving each test run a clean slate the way the old
// in-memory SQLite resetDb() did.
async function resetTables() {
  getClient();
  for (const def of TABLE_DEFINITIONS) {
    try {
      await rawClient.send(new DeleteTableCommand({ TableName: def.TableName }));
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }
    await rawClient.send(new CreateTableCommand(def));
  }
}

module.exports = { getClient, resetTables };
