/*
 * User repository backed by SQLite (replaces the Mongoose User model).
 *
 * Returned user objects keep the exact field names the route handlers in
 * api-server.js already use (username, email, password, sessionVersion,
 * refreshTokens, createdAt, _id) so handler bodies barely change. Each
 * returned object also gets a `.save()` method bound to itself, so
 * `await user.save()` call sites keep working unchanged after mutating
 * fields directly on the object.
 */
const { getDb } = require('../db');
const { generateId } = require('./id');

function attachSave(user) {
  Object.defineProperty(user, 'save', {
    value: async function save() {
      persist(this);
      return this;
    },
    enumerable: false
  });
  return user;
}

function rowToUser(row) {
  if (!row) return null;
  const refreshTokens = JSON.parse(row.refresh_tokens_json || '[]').map((entry) => ({
    tokenHash: entry.tokenHash,
    expiresAt: new Date(entry.expiresAt),
    createdAt: new Date(entry.createdAt)
  }));

  return attachSave({
    _id: row.id,
    username: row.username,
    email: row.email,
    password: row.password,
    bio: row.bio,
    location: row.location,
    favoriteGame: row.favorite_game,
    favoriteDeck: row.favorite_deck,
    website: row.website,
    avatarUrl: row.avatar_url,
    sessionVersion: row.session_version,
    refreshTokens,
    createdAt: new Date(row.created_at)
  });
}

function persist(user) {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO users (
      id, username, email, password, bio, location, favorite_game, favorite_deck,
      website, avatar_url, session_version, refresh_tokens_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    user._id,
    user.username,
    user.email,
    user.password,
    user.bio || '',
    user.location || '',
    user.favoriteGame || '',
    user.favoriteDeck || '',
    user.website || '',
    user.avatarUrl || '',
    user.sessionVersion || 0,
    JSON.stringify(user.refreshTokens || []),
    user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt
  );
}

// Mirrors `new User({...})` -- an in-memory instance the caller must still .save().
function buildUser({ username, email, password }) {
  return attachSave({
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
}

function findById(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return rowToUser(row);
}

function findByEmail(email) {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  return rowToUser(row);
}

module.exports = {
  buildUser,
  findById,
  findByEmail
};
