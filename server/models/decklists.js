/*
 * Decklist repository backed by DynamoDB (theduelclub-Decklists table).
 *
 * `owner-index` GSI (owner, updatedAt) backs findByOwner. `public-feed-index`
 * is a sparse GSI: the `publicFeedKey` attribute (a constant literal) is only
 * written on items where isPublic is true, and simply omitted otherwise (a
 * DynamoDB PutItem replaces the whole item, so leaving an attribute out is
 * enough to "unset" it) -- that keeps the index scoped to just public
 * decklists so findRecentPublic stays a cheap Query instead of a Scan.
 */
const { GetCommand, PutCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { getClient } = require('../dynamo');
const { TABLE_NAMES } = require('../dynamo-schema');
const { generateId } = require('./id');

const TABLE = TABLE_NAMES.DECKLISTS_TABLE;
const PUBLIC_FEED_KEY = 'PUBLIC';

function attachSave(decklist) {
  Object.defineProperty(decklist, 'save', {
    value: async function save() {
      this.updatedAt = new Date();
      await persist(this);
      return this;
    },
    enumerable: false
  });
  return decklist;
}

function itemToDecklist(item) {
  if (!item) return null;
  return attachSave({
    _id: item.id,
    owner: item.owner,
    name: item.name,
    game: item.game,
    mainDeck: item.mainDeck,
    extraDeck: item.extraDeck,
    sideDeck: item.sideDeck,
    isPublic: !!item.isPublic,
    archetype: item.archetype,
    notes: item.notes,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt)
  });
}

function toItem(decklist) {
  const item = {
    id: decklist._id,
    owner: decklist.owner,
    name: decklist.name,
    game: decklist.game,
    mainDeck: decklist.mainDeck,
    extraDeck: decklist.extraDeck || '',
    sideDeck: decklist.sideDeck || '',
    isPublic: !!decklist.isPublic,
    archetype: decklist.archetype || '',
    notes: decklist.notes || '',
    createdAt: decklist.createdAt instanceof Date ? decklist.createdAt.toISOString() : decklist.createdAt,
    updatedAt: decklist.updatedAt instanceof Date ? decklist.updatedAt.toISOString() : decklist.updatedAt
  };
  if (item.isPublic) {
    item.publicFeedKey = PUBLIC_FEED_KEY;
  }
  return item;
}

async function persist(decklist) {
  await getClient().send(new PutCommand({ TableName: TABLE, Item: toItem(decklist) }));
}

async function create({ owner, name, game, mainDeck, extraDeck, sideDeck, isPublic, archetype, notes }) {
  const now = new Date();
  const decklist = attachSave({
    _id: generateId(),
    owner,
    name,
    game,
    mainDeck,
    extraDeck: extraDeck || '',
    sideDeck: sideDeck || '',
    isPublic: isPublic !== false,
    archetype: archetype || '',
    notes: notes || '',
    createdAt: now,
    updatedAt: now
  });
  await persist(decklist);
  return decklist;
}

async function findById(id) {
  if (!id) return null;
  const { Item } = await getClient().send(new GetCommand({ TableName: TABLE, Key: { id } }));
  return itemToDecklist(Item);
}

// Mirrors Decklist.findOne({ _id: id, owner: ownerId }) -- used to enforce ownership on writes.
async function findByIdForOwner(id, ownerId) {
  const decklist = await findById(id);
  return decklist && decklist.owner === ownerId ? decklist : null;
}

async function findByOwner(ownerId) {
  const { Items } = await getClient().send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'owner-index',
    // "owner" is a DynamoDB reserved keyword, so it must be aliased rather
    // than used directly in the KeyConditionExpression.
    KeyConditionExpression: '#owner = :owner',
    ExpressionAttributeNames: { '#owner': 'owner' },
    ExpressionAttributeValues: { ':owner': ownerId },
    ScanIndexForward: false
  }));
  return (Items || []).map(itemToDecklist);
}

async function findRecentPublic(limit = 10) {
  const { Items } = await getClient().send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'public-feed-index',
    KeyConditionExpression: 'publicFeedKey = :key',
    ExpressionAttributeValues: { ':key': PUBLIC_FEED_KEY },
    ScanIndexForward: false,
    Limit: limit
  }));
  return (Items || []).map(itemToDecklist);
}

async function deleteByIdForOwner(id, ownerId) {
  const decklist = await findByIdForOwner(id, ownerId);
  if (!decklist) return null;
  await getClient().send(new DeleteCommand({ TableName: TABLE, Key: { id } }));
  return decklist;
}

module.exports = {
  create,
  findById,
  findByIdForOwner,
  findByOwner,
  findRecentPublic,
  deleteByIdForOwner
};
