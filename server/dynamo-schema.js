/*
 * DynamoDB table definitions -- single source of truth for the test suite's
 * resetTables() (backed by a local dynalite instance). The equivalent
 * AWS::DynamoDB::Table resources in template.yaml are kept in sync with this
 * file by hand; four tables is a low enough count that drift risk is small.
 *
 * Table names default to the same names template.yaml gives the real AWS
 * tables, so `npm run dev` needs no extra .env setup once the stack is
 * deployed -- it just talks to the real tables under the operator's own
 * AWS credentials.
 */
const USERS_TABLE = process.env.USERS_TABLE || 'theduelclub-Users';
const DECKLISTS_TABLE = process.env.DECKLISTS_TABLE || 'theduelclub-Decklists';
const TOURNAMENTS_TABLE = process.env.TOURNAMENTS_TABLE || 'theduelclub-Tournaments';
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'theduelclub-Connections';

const TABLE_NAMES = { USERS_TABLE, DECKLISTS_TABLE, TOURNAMENTS_TABLE, CONNECTIONS_TABLE };

// CreateTable request shapes. TTL (the Connections table's `ttl` attribute) is
// enabled separately via UpdateTimeToLive in real AWS (see template.yaml) --
// dynalite doesn't need it since tests don't rely on items actually expiring.
const TABLE_DEFINITIONS = [
  {
    TableName: USERS_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }]
  },
  {
    TableName: DECKLISTS_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'owner', AttributeType: 'S' },
      { AttributeName: 'updatedAt', AttributeType: 'S' },
      { AttributeName: 'publicFeedKey', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' }
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'owner-index',
        KeySchema: [
          { AttributeName: 'owner', KeyType: 'HASH' },
          { AttributeName: 'updatedAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        // Sparse index: publicFeedKey is only written on items where isPublic
        // is true, so this GSI only ever contains the public feed.
        IndexName: 'public-feed-index',
        KeySchema: [
          { AttributeName: 'publicFeedKey', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      }
    ]
  },
  {
    TableName: TOURNAMENTS_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'createdBy', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' }
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'creator-index',
        KeySchema: [
          { AttributeName: 'createdBy', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      }
    ]
  },
  {
    TableName: CONNECTIONS_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'connectionId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'connectionId', KeyType: 'HASH' }]
  }
];

module.exports = { TABLE_NAMES, TABLE_DEFINITIONS, ...TABLE_NAMES };
