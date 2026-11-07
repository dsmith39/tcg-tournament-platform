/*
 * Card endpoint mock for the unresolved decklist card specs (board D012).
 *
 * It answers like /api/v7/cardinfo.php will once the server half of D012
 * ships, so these specs test the frontend half on its own:
 * - id= matches a main passcode or an alternate art id and returns the main
 *   card (spec item 1).
 * - name= matches exactly, then retries on a normalized name and answers
 *   only when exactly one card matches (spec item 2).
 * - fname= is a case insensitive substring search capped at num (default 20,
 *   max 200), ordered by passcode, like the real router.
 * - Duel Links exclusives from the D011 fixture answer only with
 *   game=duel-links, as they do today.
 * The server half is proven separately in tests/api.integration.test.js
 * ("unresolved cards:").
 *
 * Card facts (names, passcodes, alternate art ids, types) are YGOPRODeck's,
 * checked against the Yu-Gi-Oh team's cached YGOPRODeck responses on
 * 2026-11-07. "Filler Card N" rows are made up and only pad decks.
 *
 * `faults` lets a test break one card's lookups: { [value]: 'status500' }
 * answers every request for that name or id with a 500; { [value]: 'abortOnce' }
 * drops the first request at the network level and answers the rest.
 * Every request is logged on the returned object.
 */
const { EXCLUSIVES } = require('./dl-exclusive-cards');

const CATALOG = [
  { id: 89631139, name: 'Blue-Eyes White Dragon', type: 'Normal Monster', frameType: 'normal', images: [89631139] },
  {
    id: 46986414,
    name: 'Dark Magician',
    type: 'Normal Monster',
    frameType: 'normal',
    images: [46986414, 46986415, 46986416, 46986417, 46986418, 46986419, 36996508, 46986420, 46986421]
  },
  { id: 14558127, name: 'Ash Blossom & Joyous Spring', type: 'Tuner Monster', frameType: 'effect', images: [14558127, 14558128] },
  { id: 23434538, name: 'Maxx "C"', type: 'Effect Monster', frameType: 'effect', images: [23434538] },
  { id: 55144522, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', images: [55144522] },
  { id: 18144507, name: "Harpie's Feather Duster", type: 'Spell Card', frameType: 'spell', images: [18144507, 18144506] },
  { id: 87639778, name: "Harpie's Feather Storm", type: 'Trap Card', frameType: 'trap', images: [87639778] },
  ...Array.from({ length: 40 }, (_, i) => ({
    id: 1000 + i,
    name: `Filler Card ${i + 1}`,
    type: 'Normal Monster',
    frameType: 'normal',
    images: [1000 + i]
  }))
];

const NOT_FOUND = { status: 404, body: { error: 'No card matching your query was found in the local database.' } };

function toApiCard(card) {
  return {
    id: card.id,
    name: card.name,
    type: card.type,
    frameType: card.frameType,
    card_images: card.images.map((imageId) => ({ id: imageId, image_url: '', image_url_small: '', image_url_cropped: '' })),
    card_sets: [],
    card_prices: []
  };
}

function toExclusiveApiCard(card) {
  return {
    id: card.id,
    name: card.name,
    type: card.type,
    frameType: card.frameType,
    card_images: [],
    card_sets: [],
    card_prices: [],
    dl_exclusive: true
  };
}

// The normalization spec item 2 describes.
function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"/g, '');
}

function andKey(name) {
  return normalizeName(name).replace(/ & /g, ' and ');
}

function findByName(name) {
  const exact = CATALOG.find((card) => card.name === name);
  if (exact) return exact;
  for (const keyOf of [normalizeName, andKey]) {
    const matches = CATALOG.filter((card) => keyOf(card.name) === keyOf(name));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

function findCards({ name, fname, id, game, num }) {
  if (id !== null) {
    if (!/^\d+$/.test(id)) return { status: 400, body: { error: 'id must be a positive integer' } };
    const passcode = Number(id);
    const card = CATALOG.find((c) => c.id === passcode) || CATALOG.find((c) => c.images.includes(passcode));
    return card ? { status: 200, body: { data: [toApiCard(card)] } } : NOT_FOUND;
  }

  if (name !== null) {
    const card = findByName(name);
    if (card) return { status: 200, body: { data: [toApiCard(card)] } };
    if (game === 'duel-links') {
      const exclusive = EXCLUSIVES.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (exclusive) return { status: 200, body: { data: [toExclusiveApiCard(exclusive)] } };
    }
    return NOT_FOUND;
  }

  if (fname !== null) {
    const limit = Math.min(Number(num) || 20, 200);
    const lower = fname.toLowerCase();
    const results = CATALOG
      .filter((card) => card.name.toLowerCase().includes(lower))
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map(toApiCard);
    if (game === 'duel-links') {
      EXCLUSIVES
        .filter((c) => c.name.toLowerCase().includes(lower))
        .forEach((c) => results.push(toExclusiveApiCard(c)));
    }
    return results.length ? { status: 200, body: { data: results } } : NOT_FOUND;
  }

  return NOT_FOUND;
}

async function installCatalogCardMock(page, { faults = {} } = {}) {
  const log = { requests: [] };
  const seen = new Map();

  // Registered after installMockApi, so it takes precedence over the
  // helper's single card fixture.
  await page.route('**/api/v7/cardinfo.php**', async (route) => {
    const url = new URL(route.request().url());
    const params = {
      name: url.searchParams.get('name'),
      fname: url.searchParams.get('fname'),
      id: url.searchParams.get('id'),
      game: url.searchParams.get('game'),
      num: url.searchParams.get('num')
    };
    log.requests.push(params);

    const value = params.name ?? params.fname ?? params.id;
    const fault = faults[value];
    const count = (seen.get(value) || 0) + 1;
    seen.set(value, count);

    if (fault === 'status500') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal Server Error' }) });
      return;
    }
    if (fault === 'abortOnce' && count === 1) {
      await route.abort('failed');
      return;
    }

    const { status, body } = findCards(params);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });

  return log;
}

module.exports = {
  installCatalogCardMock
};
