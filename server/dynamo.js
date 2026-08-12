/*
 * DynamoDB connection shared by server/models/*.js.
 *
 * Points at real AWS DynamoDB by default -- the operator's own credentials
 * via the AWS SDK's normal credential chain locally, or the Lambda execution
 * role once deployed. Tests set DYNAMODB_ENDPOINT to a local dynalite
 * instance instead, mirroring server/db.js's old :memory: contract with
 * resetTables() standing in for resetDb().
 */
const { DynamoDBClient, CreateTableCommand, DeleteTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
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

// dynalite's DeleteTableCommand resolves before the table is actually removed
// from its store (the real deletion is scheduled via setTimeout, even with
// deleteTableMs: 0 -- see dynalite/actions/deleteTable.js), so issuing
// CreateTableCommand right after a delete can race dynalite's own cleanup and
// throw ResourceInUseException. Poll DescribeTableCommand until it reports
// ResourceNotFoundException so the create below only ever runs once the
// table is actually gone.
async function waitUntilTableGone(tableName) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rawClient.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for table ${tableName} to be deleted`);
}

// Test-only: drop and recreate every table against the dynalite endpoint set
// via DYNAMODB_ENDPOINT, giving each test run a clean slate the way the old
// in-memory SQLite resetDb() did.
async function resetTables() {
  getClient();
  for (const def of TABLE_DEFINITIONS) {
    try {
      await rawClient.send(new DeleteTableCommand({ TableName: def.TableName }));
      await waitUntilTableGone(def.TableName);
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }
    await rawClient.send(new CreateTableCommand(def));
  }
}

module.exports = { getClient, resetTables };
