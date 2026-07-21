/*
 * SQLite connection + schema bootstrap for the app database.
 *
 * Replaces the old MongoDB/Mongoose connection. One file-backed database
 * (server/data/app.db) holds users, decklists, and tournaments. Tournaments
 * store their nested rounds/matches/registrations as a JSON column because
 * every route handler already loads a tournament whole, mutates it in
 * memory, and saves it back whole -- there is no per-row concurrent update
 * pattern that would benefit from fully normalizing rounds/matches into
 * separate tables.
 *
 * Uses Node's built-in node:sqlite (DatabaseSync) rather than the
 * better-sqlite3 package: better-sqlite3 needs a native build step
 * (node-gyp + a C++ toolchain), which isn't available in every environment
 * this app is developed in, while node:sqlite ships with Node itself.
 * Node 22.5+ is required. It's still flagged experimental upstream but the
 * synchronous prepare/run/get/all API used here is stable in practice.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  favorite_game TEXT NOT NULL DEFAULT '',
  favorite_deck TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  session_version INTEGER NOT NULL DEFAULT 0,
  refresh_tokens_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decklists (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  game TEXT NOT NULL,
  main_deck TEXT NOT NULL,
  extra_deck TEXT NOT NULL DEFAULT '',
  side_deck TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 1,
  archetype TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decklists_owner ON decklists(owner_id);
CREATE INDEX IF NOT EXISTS idx_decklists_public ON decklists(is_public);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  game TEXT NOT NULL,
  format TEXT NOT NULL,
  max_players INTEGER NOT NULL,
  current_players INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registration',
  champion TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  round_timer_minutes INTEGER NOT NULL DEFAULT 0,
  top_cut_size INTEGER NOT NULL DEFAULT 0,
  is_top_cut_phase INTEGER NOT NULL DEFAULT 0,
  top_cut_start_round INTEGER,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tournaments_created_by ON tournaments(created_by);
`;

let dbInstance = null;

function resolveDbPath() {
  if (process.env.NODE_ENV === 'test') return ':memory:';
  const dataDir = path.resolve(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'app.db');
}

function openDatabase() {
  const dbPath = resolveDbPath();
  const instance = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    instance.exec('PRAGMA journal_mode = WAL;');
  }
  instance.exec('PRAGMA foreign_keys = ON;');
  instance.exec(SCHEMA_SQL);
  return instance;
}

function getDb() {
  if (!dbInstance) {
    dbInstance = openDatabase();
  }
  return dbInstance;
}

// Used by tests to start each run from a clean in-memory database.
function resetDb() {
  if (dbInstance) {
    dbInstance.close();
  }
  dbInstance = openDatabase();
  return dbInstance;
}

module.exports = { getDb, resetDb };
