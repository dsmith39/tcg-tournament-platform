/*
 * Builds the list of Duel Links exclusive cards: cards released in Duel Links
 * (Speed Duel) that the YGOPRODeck catalog doesn't have, mostly Tag Force and
 * ZEXAL Duel Carnival cards. Writes server/reference-data/duel-links-exclusive-cards.json.
 *
 * Like `npm run skills:import`, this is run by hand, on purpose, by the operator.
 * Never scheduled and never called from the app: the running app only reads the
 * checked in JSON.
 *
 *   npm run dl-cards:import
 *   npm run dl-cards:import -- --save-raw <dir>   # also keep the raw responses
 *   npm run dl-cards:import -- --from-raw <dir>   # rebuild from saved responses, no network
 *
 * Spec: board D011, ops/staff/cards/2026-10-27-duel-links-exclusive-cards-spec.md, section 6.
 *
 * Matching uses names only. DuelLinksMeta's konamiID and gameId are never used to
 * match, because they're wrong on at least one card ("For Our Dreams" carries
 * Fusion Deployment's ids).
 */
const fs = require('fs');
const path = require('path');

const DLM_URL = 'https://www.duellinksmeta.com/api/v1/cards';
const DLM_FIELDS = '_id,name,type,monsterType,level,attribute,race,atk,def,description,banStatus,release,rush';
const DLM_PAGE_SIZE = 3000;
const DLM_MAX_PAGES = 20;
const PAUSE_MS = 2000;
const YGOPRODECK_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'server', 'reference-data', 'duel-links-exclusive-cards.json');
const CARDS_DB_PATH = path.join(ROOT, 'card-database', 'data', 'cards.db');

// Guards: refuse to write, leave the old file in place, exit 1.
const MIN_RELEASED_SPEED = 10000;
const MIN_CATALOG_CARDS = 13000;
const MIN_EXCLUSIVES = 90;
const MAX_EXCLUSIVES = 200;

// Reviewed renames: a Duel Links name for a card the catalog has under another
// name. Each entry here was checked by the card steward on Yugipedia.
const KNOWN_RENAMES = {
  'Synch Realm': 'Synchronized Realm'
};

const DL_LIMITS = new Set(['Forbidden', 'Limited 1', 'Limited 2', 'Limited 3']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--save-raw') args.saveRaw = argv[++i];
    else if (argv[i] === '--from-raw') args.fromRaw = argv[++i];
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchDuelLinksCards(args) {
  if (args.fromRaw) {
    return JSON.parse(fs.readFileSync(path.join(args.fromRaw, 'duellinksmeta-cards.json'), 'utf8'));
  }

  const all = [];
  for (let page = 1; page <= DLM_MAX_PAGES; page += 1) {
    if (page > 1) await sleep(PAUSE_MS);
    const url = `${DLM_URL}?limit=${DLM_PAGE_SIZE}&page=${page}&fields=${DLM_FIELDS}`;
    console.log(`DuelLinksMeta page ${page}...`);
    const batch = await getJson(url);
    if (!Array.isArray(batch)) {
      throw new Error(`Unexpected DuelLinksMeta response on page ${page}: expected an array`);
    }
    all.push(...batch);
    if (batch.length < DLM_PAGE_SIZE) break;
    if (page === DLM_MAX_PAGES) {
      throw new Error(`DuelLinksMeta still returned full pages after ${DLM_MAX_PAGES}; refusing to keep paging.`);
    }
  }

  if (args.saveRaw) {
    fs.mkdirSync(args.saveRaw, { recursive: true });
    fs.writeFileSync(path.join(args.saveRaw, 'duellinksmeta-cards.json'), JSON.stringify(all));
  }
  return all;
}

// The catalog to compare against: the local cards.db when it's a full one,
// otherwise one YGOPRODeck call. Names and type only.
async function loadCatalog(args) {
  if (args.fromRaw) {
    const saved = JSON.parse(fs.readFileSync(path.join(args.fromRaw, 'catalog.json'), 'utf8'));
    return { cards: saved.cards, source: saved.source };
  }

  if (fs.existsSync(CARDS_DB_PATH)) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(CARDS_DB_PATH, { readOnly: true });
    try {
      const rows = db.prepare('SELECT name, type FROM cards').all();
      if (rows.length >= MIN_CATALOG_CARDS) {
        return { cards: rows.map((r) => ({ name: r.name, type: r.type })), source: 'card-database/data/cards.db' };
      }
      console.log(`cards.db holds only ${rows.length} cards; using YGOPRODeck instead.`);
    } finally {
      db.close();
    }
  }

  await sleep(PAUSE_MS);
  console.log('YGOPRODeck catalog (one call)...');
  const payload = await getJson(YGOPRODECK_URL);
  const cards = (Array.isArray(payload?.data) ? payload.data : []).map((c) => ({ name: c.name, type: c.type }));
  const result = { cards, source: 'db.ygoprodeck.com/api/v7/cardinfo.php' };

  if (args.saveRaw) {
    fs.mkdirSync(args.saveRaw, { recursive: true });
    fs.writeFileSync(path.join(args.saveRaw, 'catalog.json'), JSON.stringify(result));
  }
  return result;
}

// Lower case, NFKD, curly quotes and dashes folded, then letters and digits only.
function normalizeName(name) {
  return String(name || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Monster, Spell or Trap. Normalizing alone makes "Rai-Mei" (monster) equal
// "Raimei" (spell), so a normalized match also has to be the same kind.
function catalogKind(type) {
  const t = String(type || '');
  if (t.includes('Spell')) return 'Spell';
  if (t.includes('Trap')) return 'Trap';
  return 'Monster';
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// YGOPRODeck vocabulary for type and frameType, so existing frontend code
// (isExtraDeckMonsterType, renderDeckStats) works unchanged.
function mapMonsterType(monsterTypes) {
  const has = (t) => monsterTypes.includes(t);
  let frameType;
  let type;

  if (has('Fusion')) {
    frameType = 'fusion';
    type = 'Fusion Monster';
  } else if (has('Synchro')) {
    frameType = 'synchro';
    type = has('Tuner') ? 'Synchro Tuner Monster' : 'Synchro Monster';
  } else if (has('Xyz')) {
    frameType = 'xyz';
    type = 'XYZ Monster';
  } else if (has('Link')) {
    frameType = 'link';
    type = 'Link Monster';
  } else if (has('Ritual')) {
    frameType = 'ritual';
    type = has('Effect') ? 'Ritual Effect Monster' : 'Ritual Monster';
  } else if (has('Effect')) {
    frameType = 'effect';
    type = has('Tuner') ? 'Tuner Monster' : 'Effect Monster';
  } else {
    frameType = 'normal';
    type = 'Normal Monster';
  }

  if (has('Pendulum')) frameType = `${frameType}_pendulum`;
  return { frameType, type };
}

const EXTRA_DECK_FRAMES = ['fusion', 'synchro', 'xyz', 'link'];

function mapCard(record) {
  const cardType = record.type;
  const isMonster = cardType === 'Monster';
  let frameType;
  let type;

  if (isMonster) {
    ({ frameType, type } = mapMonsterType(Array.isArray(record.monsterType) ? record.monsterType : []));
  } else if (cardType === 'Spell') {
    frameType = 'spell';
    type = 'Spell Card';
  } else {
    frameType = 'trap';
    type = 'Trap Card';
  }

  const release = record.release ? String(record.release).slice(0, 10) : null;

  return {
    id: `dlx-${record._id}`,
    name: String(record.name).trim(),
    cardType,
    type,
    frameType,
    extraDeck: EXTRA_DECK_FRAMES.some((frame) => frameType.startsWith(frame)),
    attribute: isMonster ? (record.attribute ? String(record.attribute).toUpperCase() : null) : null,
    level: isMonster ? toNumberOrNull(record.level) : null,
    race: record.race || null,
    atk: isMonster ? toNumberOrNull(record.atk) : null,
    def: isMonster ? toNumberOrNull(record.def) : null,
    // \r line breaks become \n; stray spaces at the edges of each line go. The words are untouched.
    desc: String(record.description || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim(),
    dlLimit: DL_LIMITS.has(record.banStatus) ? record.banStatus : null,
    source: { site: 'duellinksmeta.com', dlmId: record._id, dlRelease: release }
  };
}

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch (error) {
    return null;
  }
}

function printDiff(previous, cards) {
  if (!previous || !Array.isArray(previous.cards)) {
    console.log(`No previous file; all ${cards.length} names are new.`);
    return;
  }
  const before = new Map(previous.cards.map((c) => [c.name, c]));
  const after = new Map(cards.map((c) => [c.name, c]));
  const added = cards.filter((c) => !before.has(c.name)).map((c) => c.name);
  const removed = previous.cards.filter((c) => !after.has(c.name)).map((c) => c.name);
  const limitChanges = cards
    .filter((c) => before.has(c.name) && before.get(c.name).dlLimit !== c.dlLimit)
    .map((c) => `${c.name}: ${before.get(c.name).dlLimit || 'Unlimited'} -> ${c.dlLimit || 'Unlimited'}`);

  console.log(`Added (${added.length}):${added.length ? `\n  ${added.join('\n  ')}` : ' none'}`);
  console.log(`Removed (${removed.length}):${removed.length ? `\n  ${removed.join('\n  ')}` : ' none'}`);
  console.log(`dlLimit changes (${limitChanges.length}):${limitChanges.length ? `\n  ${limitChanges.join('\n  ')}` : ' none'}`);
  if (added.length || removed.length) {
    console.log('Every added or removed name needs a Yugipedia check by /duelclub cards before commit.');
  }
}

function fail(message) {
  console.error(`Refusing to write: ${message} Left the existing file in place.`);
  process.exit(1);
}

async function runImport() {
  const args = parseArgs(process.argv.slice(2));

  const dlRecords = await fetchDuelLinksCards(args);
  const catalog = await loadCatalog(args);

  if (catalog.cards.length < MIN_CATALOG_CARDS) {
    fail(`the catalog has only ${catalog.cards.length} cards (expected at least ${MIN_CATALOG_CARDS}).`);
  }

  const candidates = dlRecords.filter((r) => r && r.name && r.release && r.rush !== true);
  if (candidates.length < MIN_RELEASED_SPEED) {
    fail(`only ${candidates.length} released Speed Duel cards (expected at least ${MIN_RELEASED_SPEED}); the DuelLinksMeta response looks truncated.`);
  }

  const exactNames = new Set(catalog.cards.map((c) => c.name));
  const normalizedKinds = new Map();
  for (const card of catalog.cards) {
    const key = normalizeName(card.name);
    if (!normalizedKinds.has(key)) normalizedKinds.set(key, new Set());
    normalizedKinds.get(key).add(catalogKind(card.type));
  }

  const counts = { dlReleasedSpeed: candidates.length, matchedExact: 0, matchedNormalized: 0, matchedRename: 0, exclusives: 0 };
  const normalizedMatches = [];
  const renamed = [];
  const exclusives = [];
  const seen = new Set();

  for (const record of candidates) {
    const name = String(record.name).trim();

    if (exactNames.has(name)) {
      counts.matchedExact += 1;
      continue;
    }

    const kinds = normalizedKinds.get(normalizeName(name));
    if (kinds && kinds.has(record.type)) {
      counts.matchedNormalized += 1;
      normalizedMatches.push(name);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(KNOWN_RENAMES, name)) {
      counts.matchedRename += 1;
      renamed.push(`${name} -> ${KNOWN_RENAMES[name]}`);
      continue;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) {
      console.log(`Skipping a second DuelLinksMeta record named "${name}".`);
      continue;
    }
    seen.add(key);
    exclusives.push(mapCard(record));
  }

  exclusives.sort((a, b) => a.name.localeCompare(b.name));
  counts.exclusives = exclusives.length;

  console.log(`Released Speed Duel cards: ${counts.dlReleasedSpeed}`);
  console.log(`Matched exactly: ${counts.matchedExact}`);
  console.log(`Matched after normalizing (${counts.matchedNormalized}): ${normalizedMatches.join(', ') || 'none'}`);
  console.log(`Known renames (${counts.matchedRename}): ${renamed.join(', ') || 'none'}`);
  console.log(`Exclusives: ${counts.exclusives}`);

  if (exclusives.length < MIN_EXCLUSIVES || exclusives.length > MAX_EXCLUSIVES) {
    fail(`${exclusives.length} exclusives is outside ${MIN_EXCLUSIVES} to ${MAX_EXCLUSIVES}; the compare probably broke.`);
  }

  const previous = readPrevious();
  const today = new Date().toISOString();
  const output = {
    meta: {
      generatedAt: today,
      sources: {
        duelLinks: DLM_URL,
        catalog: `${catalog.source} (${catalog.cards.length} cards)`
      },
      counts,
      dlLimitAsOf: today.slice(0, 10)
    },
    cards: exclusives
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${exclusives.length} cards to ${OUTPUT_PATH}.`);
  printDiff(previous, exclusives);
}

runImport().catch((error) => {
  console.error(error);
  process.exit(1);
});
