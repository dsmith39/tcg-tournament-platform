/*
 * User repository backed by DynamoDB (theduelclub-Users table).
 *
 * DynamoDB has no native unique-attribute constraint, so username/email
 * uniqueness is enforced with a lock-item pattern: alongside each user's
 * profile item (pk=userId), two extra items reserve pk="USERNAME#<u>" and
 * pk="EMAIL#<e>". Each lock write is an atomic conditional PutItem
 * (ConditionExpression: attribute_not_exists(pk)), written sequentially
 * rather than via TransactWriteItems -- the local dynalite instance the
 * test suite runs against doesn't implement the Transactions API, and
 * per-item conditional writes give the same practical safety at this app's
 * registration volume. If the email lock write loses its race, the
 * username lock just written is rolled back so it isn't left stuck
 * reserved; a crash between the email lock and the profile write is the one
 * unrecovered edge case, acceptable for a solo hobby app. Usernames/emails
 * are immutable after registration (userProfileUpdateBodySchema never
 * allows changing them), so lock items are written once and never touched
 * again.
 *
 * Returned user objects keep the same field names the old SQLite repository
 * used (username, email, password, sessionVersion, refreshTokens,
 * createdAt, _id) so api-server.js's route handlers need no shape changes --
 * only `await` added at call sites, since every lookup here is now a network
 * call instead of a synchronous local read. Each returned object gets a
 * `.save()` bound to itself, same as before.
 */
const { GetCommand, PutCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { getClient } = require('../dynamo');
const { TABLE_NAMES } = require('../dynamo-schema');
const { generateId } = require('./id');

const TABLE = TABLE_NAMES.USERS_TABLE;

const usernameLockKey = (username) => `USERNAME#${username.toLowerCase()}`;
const emailLockKey = (email) => `EMAIL#${email.toLowerCase()}`;

function attachSave(user) {
  Object.defineProperty(user, 'save', {
    value: async function save() {
      await persist(this);
      this._isNew = false;
      return this;
    },
    enumerable: false
  });
  return user;
}

function itemToUser(item) {
  if (!item || item.itemType !== 'PROFILE') return null;
  const refreshTokens = (item.refreshTokens || []).map((entry) => ({
    tokenHash: entry.tokenHash,
    expiresAt: new Date(entry.expiresAt),
    createdAt: new Date(entry.createdAt)
  }));

  const user = attachSave({
    _id: item.id,
    username: item.username,
    email: item.email,
    password: item.password,
    bio: item.bio,
    location: item.location,
    favoriteGame: item.favoriteGame,
    favoriteDeck: item.favoriteDeck,
    website: item.website,
    avatarUrl: item.avatarUrl,
    sessionVersion: item.sessionVersion,
    refreshTokens,
    createdAt: new Date(item.createdAt)
  });
  user._isNew = false;
  return user;
}

function toProfileItem(user) {
  return {
    pk: user._id,
    itemType: 'PROFILE',
    id: user._id,
    username: user.username,
    email: user.email,
    password: user.password,
    bio: user.bio || '',
    location: user.location || '',
    favoriteGame: user.favoriteGame || '',
    favoriteDeck: user.favoriteDeck || '',
    website: user.website || '',
    avatarUrl: user.avatarUrl || '',
    sessionVersion: user.sessionVersion || 0,
    refreshTokens: (user.refreshTokens || []).map((entry) => ({
      tokenHash: entry.tokenHash,
      expiresAt: entry.expiresAt instanceof Date ? entry.expiresAt.toISOString() : entry.expiresAt,
      createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt
    })),
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt
  };
}

async function persist(user) {
  const item = toProfileItem(user);

  if (!user._isNew) {
    await getClient().send(new PutCommand({ TableName: TABLE, Item: item }));
    return;
  }

  try {
    await getClient().send(new PutCommand({
      TableName: TABLE,
      Item: { pk: usernameLockKey(user.username), itemType: 'USERNAME_LOCK', userId: user._id },
      ConditionExpression: 'attribute_not_exists(pk)'
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error('Username is already taken');
    }
    throw error;
  }

  try {
    await getClient().send(new PutCommand({
      TableName: TABLE,
      Item: { pk: emailLockKey(user.email), itemType: 'EMAIL_LOCK', userId: user._id },
      ConditionExpression: 'attribute_not_exists(pk)'
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      await getClient().send(new DeleteCommand({
        TableName: TABLE,
        Key: { pk: usernameLockKey(user.username) }
      }));
      throw new Error('Email is already registered');
    }
    throw error;
  }

  await getClient().send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(pk)'
  }));
}

// Mirrors `new User({...})` -- an in-memory instance the caller must still .save().
function buildUser({ username, email, password }) {
  const user = attachSave({
    _id: generateId(),
    username,
    email,
    password,
    bio: '',
    location: '',
    favoriteGame: '',
    favoriteDeck: '',
    website: '',
    avatarUrl: '',
    sessionVersion: 0,
    refreshTokens: [],
    createdAt: new Date()
  });
  user._isNew = true;
  return user;
}

async function findById(id) {
  if (!id) return null;
  const { Item } = await getClient().send(new GetCommand({ TableName: TABLE, Key: { pk: id } }));
  return itemToUser(Item);
}

async function findByEmail(email) {
  if (!email) return null;
  const { Item: lock } = await getClient().send(
    new GetCommand({ TableName: TABLE, Key: { pk: emailLockKey(email) } })
  );
  if (!lock) return null;
  return findById(lock.userId);
}

// Admin-only: every user profile, for the admin dashboard's counts/signup
// trend. The scan also picks up USERNAME_LOCK/EMAIL_LOCK items sharing this
// table, so itemToUser filters those out (it already returns null for any
// itemType other than 'PROFILE'). Fine at this app's hobby-project volume --
// same tradeoff tournaments.js's listByPlayer Scan already makes.
async function listAll() {
  const { Items } = await getClient().send(new ScanCommand({ TableName: TABLE }));
  return (Items || [])
    .map(itemToUser)
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = {
  buildUser,
  findById,
  findByEmail,
  listAll
};
