/*
 * Duel Links exclusive cards -- read only, backed by a checked in JSON file
 * (server/reference-data/duel-links-exclusive-cards.json, refreshed by
 * `npm run dl-cards:import`). Board D011.
 *
 * These are cards Duel Links released that YGOPRODeck doesn't carry (Tag Force,
 * ZEXAL Duel Carnival and a few anime cards), so the SQLite catalog can't
 * resolve them. About 100 records, held in memory and scanned, same as the
 * skill catalog.
 *
 * Ids are the string "dlx-" plus DuelLinksMeta's _id. They never collide with a
 * passcode (an integer), and decklists never store them: the name is the join
 * key, as it is for every other card. Only the card router reads this, and only
 * for game=duel-links.
 */
const path = require('path');

const CATALOG_PATH = path.resolve(__dirname, '..', 'reference-data', 'duel-links-exclusive-cards.json');
const DEFAULT_SEARCH_LIMIT = 20;

let cards = null;
let byLowerName = null;

function load() {
  if (cards) return cards;

  // require() caches, so the file is read once per process (once per Lambda cold start).
  const raw = require(CATALOG_PATH);
  cards = Array.isArray(raw?.cards) ? raw.cards : [];
  byLowerName = new Map(cards.map((card) => [card.name.toLowerCase(), card]));
  return cards;
}

function all() {
  return load();
}

function count() {
  return load().length;
}

// Exact name lookup, case insensitive.
function findByName(name) {
  load();
  const key = String(name || '').trim().toLowerCase();
  return key ? byLowerName.get(key) || null : null;
}

/*
 * Name search, ranked like the skill catalog:
 *   0. exact name
 *   1. name starts with the query
 *   2. query matches the start of any word in the name
 *   3. name contains the query anywhere
 */
function search(query, limit = DEFAULT_SEARCH_LIMIT) {
  const list = load();
  const normalized = String(query || '').trim().toLowerCase();
  const cappedLimit = Math.max(Number(limit) || DEFAULT_SEARCH_LIMIT, 0);
  if (!normalized || cappedLimit === 0) return [];

  const wordStart = new RegExp(`\\b${escapeRegExp(normalized)}`);
  const ranked = [];

  list.forEach((card) => {
    const lower = card.name.toLowerCase();
    let rank = -1;

    if (lower === normalized) rank = 0;
    else if (lower.startsWith(normalized)) rank = 1;
    else if (wordStart.test(lower)) rank = 2;
    else if (lower.includes(normalized)) rank = 3;

    if (rank >= 0) ranked.push({ card, rank });
  });

  // The file is name sorted, so a stable sort on rank keeps ties alphabetical.
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, cappedLimit).map((entry) => entry.card);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  all,
  count,
  findByName,
  search
};
