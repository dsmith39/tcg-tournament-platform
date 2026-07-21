/*
 * SQLite connection + schema bootstrap for the local Yu-Gi-Oh card catalog.
 *
 * Replaces ygo-database's MongoDB/Mongoose connection. This is a separate
 * database file (card-database/data/cards.db) from the main app database
 * (server/data/app.db) because it has a completely different write pattern:
 * bulk-overwritten by the maintenance scripts (import/download), never
 * written to by live user request traffic.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cards (
  card_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  frame_type TEXT,
  description TEXT,
  atk INTEGER,
  def INTEGER,
  level INTEGER,
  race TEXT,
  attribute TEXT,
  archetype TEXT,
  scale INTEGER,
  linkval INTEGER,
  linkmarkers TEXT NOT NULL DEFAULT '[]',
  banlist_info TEXT,
  images TEXT NOT NULL DEFAULT '[]',
  sets TEXT NOT NULL DEFAULT '[]',
  prices TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_archetype ON cards(archetype);
CREATE INDEX IF NOT EXISTS idx_cards_attribute ON cards(attribute);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
`;

let dbInstance = null;

function resolveDbPath() {
  if (process.env.NODE_ENV === 'test') return ':memory:';
  const dataDir = path.resolve(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'cards.db');
}

function openDatabase() {
  const dbPath = resolveDbPath();
  const instance = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    instance.exec('PRAGMA journal_mode = WAL;');
  }
  instance.exec(SCHEMA_SQL);
  return instance;
}

function getDb() {
  if (!dbInstance) {
    dbInstance = openDatabase();
  }
  return dbInstance;
}

function resetDb() {
  if (dbInstance) {
    dbInstance.close();
  }
  dbInstance = openDatabase();
  return dbInstance;
}

module.exports = { getDb, resetDb };
