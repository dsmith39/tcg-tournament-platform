/*
 * Duel Links skill catalog -- read-only, backed by a checked-in JSON file
 * (server/reference-data/duel-links-skills.json, refreshed by
 * `npm run skills:import`).
 *
 * Skills are not cards: they have no YGOPRODeck entry, so they can't be resolved
 * through card-database/ like every other name in the deck builder. The list is
 * ~1,100 short records, so it's held in memory and filtered directly rather than
 * given a SQLite table -- there's nothing to index that a linear scan over a few
 * thousand strings doesn't already answer instantly.
 *
 * The catalog is a convenience for the picker, NOT an allowlist: a skill that
 * shipped after the last import still has to be typeable, so callers treat an
 * unknown name as a warning, never a rejection.
 */
const path = require('path');

const CATALOG_PATH = path.resolve(__dirname, '..', 'reference-data', 'duel-links-skills.json');
const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 50;

let catalog = null;
let byLowerName = null;

function load() {
  if (catalog) return catalog;

  // require() caches, so the file is read once per process (once per Lambda
  // cold start) rather than on every search.
  const raw = require(CATALOG_PATH);
  catalog = Array.isArray(raw) ? raw : [];
  byLowerName = new Map(catalog.map((skill) => [skill.name.toLowerCase(), skill]));
  return catalog;
}

function all() {
  return load();
}

function count() {
  return load().length;
}

// Exact (case-insensitive) name lookup -- used to tell a real skill from a typo.
function findByName(name) {
  load();
  const key = String(name || '').trim().toLowerCase();
  return key ? byLowerName.get(key) || null : null;
}

/*
 * Name search, ranked so the most likely pick lands first:
 *   0. exact name
 *   1. name starts with the query
 *   2. query matches the start of any word in the name ("draw sense: dark" <- "dark")
 *   3. name contains the query anywhere
 * Description text is deliberately not searched: matching effect prose would bury
 * the name matches a player is actually reaching for.
 */
function search(query, limit = DEFAULT_SEARCH_LIMIT) {
  const skills = load();
  const normalized = String(query || '').trim().toLowerCase();
  const cappedLimit = Math.min(Math.max(Number(limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

  if (!normalized) {
    return skills.slice(0, cappedLimit);
  }

  const ranked = [];

  skills.forEach((skill) => {
    const lower = skill.name.toLowerCase();
    let rank = -1;

    if (lower === normalized) {
      rank = 0;
    } else if (lower.startsWith(normalized)) {
      rank = 1;
    } else if (new RegExp(`\\b${escapeRegExp(normalized)}`).test(lower)) {
      rank = 2;
    } else if (lower.includes(normalized)) {
      rank = 3;
    }

    if (rank >= 0) {
      ranked.push({ skill, rank });
    }
  });

  // The catalog is already name-sorted, so a stable sort on rank alone keeps
  // ties in alphabetical order.
  ranked.sort((a, b) => a.rank - b.rank);

  return ranked.slice(0, cappedLimit).map((entry) => entry.skill);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  all,
  count,
  findByName,
  search
};
