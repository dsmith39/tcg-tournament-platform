/*
 * Decklist repository backed by SQLite (replaces the Mongoose Decklist model).
 */
const { getDb } = require('../db');
const { generateId } = require('./id');

function attachSave(decklist) {
  Object.defineProperty(decklist, 'save', {
    value: async function save() {
      this.updatedAt = new Date();
      persist(this);
      return this;
    },
    enumerable: false
  });
  return decklist;
}

function rowToDecklist(row) {
  if (!row) return null;
  return attachSave({
    _id: row.id,
    owner: row.owner_id,
    name: row.name,
    game: row.game,
    mainDeck: row.main_deck,
    extraDeck: row.extra_deck,
    sideDeck: row.side_deck,
    isPublic: !!row.is_public,
    archetype: row.archetype,
    notes: row.notes,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  });
}

function persist(decklist) {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO decklists (
      id, owner_id, name, game, main_deck, extra_deck, side_deck,
      is_public, archetype, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    decklist._id,
    decklist.owner,
    decklist.name,
    decklist.game,
    decklist.mainDeck,
    decklist.extraDeck || '',
    decklist.sideDeck || '',
    decklist.isPublic ? 1 : 0,
    decklist.archetype || '',
    decklist.notes || '',
    decklist.createdAt instanceof Date ? decklist.createdAt.toISOString() : decklist.createdAt,
    decklist.updatedAt instanceof Date ? decklist.updatedAt.toISOString() : decklist.updatedAt
  );
}

function create({ owner, name, game, mainDeck, extraDeck, sideDeck, isPublic, archetype, notes }) {
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
  persist(decklist);
  return decklist;
}

function findById(id) {
  const row = getDb().prepare('SELECT * FROM decklists WHERE id = ?').get(id);
  return rowToDecklist(row);
}

// Mirrors Decklist.findOne({ _id: id, owner: ownerId }) -- used to enforce ownership on writes.
function findByIdForOwner(id, ownerId) {
  const row = getDb().prepare('SELECT * FROM decklists WHERE id = ? AND owner_id = ?').get(id, ownerId);
  return rowToDecklist(row);
}

function findByOwner(ownerId) {
  const rows = getDb()
    .prepare('SELECT * FROM decklists WHERE owner_id = ? ORDER BY updated_at DESC, created_at DESC')
    .all(ownerId);
  return rows.map(rowToDecklist);
}

function findRecentPublic(limit = 10) {
  const rows = getDb()
    .prepare('SELECT * FROM decklists WHERE is_public = 1 ORDER BY created_at DESC LIMIT ?')
    .all(limit);
  return rows.map(rowToDecklist);
}

function deleteByIdForOwner(id, ownerId) {
  const decklist = findByIdForOwner(id, ownerId);
  if (!decklist) return null;
  getDb().prepare('DELETE FROM decklists WHERE id = ? AND owner_id = ?').run(id, ownerId);
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
