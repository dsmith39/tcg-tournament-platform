/*
 * Card repository backed by SQLite (replaces ygo-database's Mongoose Card model).
 *
 * Field names on the returned JS objects match the old Mongoose schema
 * (cardId, frameType, banlistInfo, imageId, ...) so the maintenance scripts
 * and API router that consume these objects stay close to their original
 * shape. images/sets/prices/banlistInfo/linkmarkers are stored as JSON text
 * columns -- they're always read/written as whole blobs per card, never
 * queried by sub-field, so normalizing them into extra tables would add
 * complexity with no query benefit.
 */
const { getDb } = require('../db');

function rowToCard(row) {
  if (!row) return null;
  return {
    cardId: row.card_id,
    name: row.name,
    type: row.type,
    frameType: row.frame_type,
    description: row.description,
    atk: row.atk,
    def: row.def,
    level: row.level,
    race: row.race,
    attribute: row.attribute,
    archetype: row.archetype,
    scale: row.scale,
    linkval: row.linkval,
    linkmarkers: JSON.parse(row.linkmarkers || '[]'),
    banlistInfo: row.banlist_info ? JSON.parse(row.banlist_info) : null,
    images: JSON.parse(row.images || '[]'),
    sets: JSON.parse(row.sets || '[]'),
    prices: row.prices ? JSON.parse(row.prices) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const upsertSql = `
  INSERT INTO cards (
    card_id, name, type, frame_type, description, atk, def, level, race,
    attribute, archetype, scale, linkval, linkmarkers, banlist_info,
    images, sets, prices, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(card_id) DO UPDATE SET
    name = excluded.name,
    type = excluded.type,
    frame_type = excluded.frame_type,
    description = excluded.description,
    atk = excluded.atk,
    def = excluded.def,
    level = excluded.level,
    race = excluded.race,
    attribute = excluded.attribute,
    archetype = excluded.archetype,
    scale = excluded.scale,
    linkval = excluded.linkval,
    linkmarkers = excluded.linkmarkers,
    banlist_info = excluded.banlist_info,
    images = excluded.images,
    sets = excluded.sets,
    prices = excluded.prices,
    updated_at = excluded.updated_at
`;

// Bulk upsert used by the import script. Wrapped in one transaction per batch
// for speed -- without it, ~13k individual auto-commits takes minutes instead of seconds.
function upsertMany(cards) {
  const db = getDb();
  const stmt = db.prepare(upsertSql);
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const card of cards) {
      stmt.run(
        card.cardId,
        card.name,
        card.type,
        card.frameType,
        card.description,
        card.atk,
        card.def,
        card.level,
        card.race,
        card.attribute,
        card.archetype,
        card.scale,
        card.linkval,
        JSON.stringify(card.linkmarkers || []),
        card.banlistInfo ? JSON.stringify(card.banlistInfo) : null,
        JSON.stringify(card.images || []),
        JSON.stringify(card.sets || []),
        card.prices ? JSON.stringify(card.prices) : null,
        now,
        now
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function findByCardId(cardId) {
  const row = getDb().prepare('SELECT * FROM cards WHERE card_id = ?').get(cardId);
  return rowToCard(row);
}

function count() {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM cards').get();
  return row.count;
}

// Used by the CLI search script and the API router's `fname` partial-name search.
function searchByName(namePattern, limit = 20) {
  const rows = getDb()
    .prepare('SELECT * FROM cards WHERE name LIKE ? ORDER BY name ASC LIMIT ?')
    .all(`%${namePattern}%`, limit);
  return rows.map(rowToCard);
}

// Builds a dynamic AND-ed WHERE clause, mirroring the old buildCardQuery()'s
// Mongo $and filter list, and runs it. Used by the API router.
function findByQuery({ id, name, fname, archetype, type, attribute, race, level, num = 20, offset = 0 }) {
  const clauses = [];
  const params = [];

  if (id !== undefined) {
    clauses.push('card_id = ?');
    params.push(id);
  }
  if (name) {
    clauses.push('name = ?');
    params.push(name);
  }
  if (fname) {
    clauses.push('name LIKE ?');
    params.push(`%${fname}%`);
  }
  if (archetype) {
    clauses.push('archetype = ?');
    params.push(archetype);
  }
  if (type) {
    clauses.push('type = ?');
    params.push(type);
  }
  if (attribute) {
    clauses.push('attribute = ?');
    params.push(attribute);
  }
  if (race) {
    clauses.push('race = ?');
    params.push(race);
  }
  if (level !== undefined) {
    clauses.push('level = ?');
    params.push(level);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM cards ${where} ORDER BY card_id ASC LIMIT ? OFFSET ?`;
  const rows = getDb().prepare(sql).all(...params, num, offset);
  return rows.map(rowToCard);
}

// Used by the image downloader -- every card's images array, all in memory
// (~13k cards fits comfortably; no need for a streaming cursor).
function allImages() {
  const rows = getDb().prepare('SELECT card_id, images FROM cards').all();
  return rows.map((row) => ({ cardId: row.card_id, images: JSON.parse(row.images || '[]') }));
}

module.exports = {
  upsertMany,
  findByCardId,
  count,
  searchByName,
  findByQuery,
  allImages
};
