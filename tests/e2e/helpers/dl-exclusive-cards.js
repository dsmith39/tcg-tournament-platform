/*
 * Card endpoint mock for the Duel Links exclusive cards specs (board D011).
 *
 * It answers like the real /api/v7/cardinfo.php will once the feature ships:
 * - Catalog cards (Blue-Eyes White Dragon and "Filler Card N") resolve for
 *   every game, with or without a `game` parameter.
 * - Exclusives from tests/fixtures/duel-links-exclusive-cards.fixture.json
 *   resolve ONLY when the request carries game=duel-links. So a test that
 *   finds Kiteroid proves the frontend sent the game.
 * - `id=` lookups never return an exclusive.
 *
 * Every card request URL is recorded on the returned log, and so is every
 * request whose URL contains "dlx-" (there should never be one).
 */
const fixture = require('../../fixtures/duel-links-exclusive-cards.fixture.json');

const EXCLUSIVES = fixture.cards;
const CATALOG_NAMES = [
  'Blue-Eyes White Dragon',
  ...Array.from({ length: 30 }, (_, i) => `Filler Card ${i + 1}`)
];

function toCatalogCard(name, index) {
  return {
    id: 1000 + index,
    name,
    type: 'Normal Monster',
    frameType: 'normal',
    card_images: [],
    card_sets: [],
    card_prices: []
  };
}

// The API shape the spec gives for an exclusive (section 3, "API shape").
function toExclusiveApiCard(card) {
  const apiCard = {
    id: card.id,
    name: card.name,
    type: card.type,
    frameType: card.frameType,
    desc: card.desc,
    atk: card.atk,
    def: card.def,
    level: card.level,
    race: card.race,
    attribute: card.attribute,
    archetype: null,
    scale: null,
    linkval: null,
    linkmarkers: [],
    card_images: [],
    card_sets: [],
    card_prices: [],
    dl_exclusive: true
  };
  if (card.dlLimit) apiCard.banlist_info = { ban_duel_links: card.dlLimit };
  return apiCard;
}

function findCards({ name, fname, id, game }) {
  const isDuelLinks = game === 'duel-links';

  if (id !== null) {
    if (!/^\d+$/.test(id)) return { status: 400, body: { error: 'id must be a positive integer' } };
    const index = Number(id) - 1000;
    const catalogName = CATALOG_NAMES[index];
    return catalogName
      ? { status: 200, body: { data: [toCatalogCard(catalogName, index)] } }
      : { status: 404, body: { error: 'No card matching your query was found in the local database.' } };
  }

  const results = [];
  if (name !== null) {
    const lower = name.toLowerCase();
    const index = CATALOG_NAMES.findIndex((n) => n.toLowerCase() === lower);
    if (index >= 0) {
      results.push(toCatalogCard(CATALOG_NAMES[index], index));
    } else if (isDuelLinks) {
      const exclusive = EXCLUSIVES.find((c) => c.name.toLowerCase() === lower);
      if (exclusive) results.push(toExclusiveApiCard(exclusive));
    }
  } else if (fname !== null) {
    const lower = fname.toLowerCase();
    CATALOG_NAMES.forEach((n, index) => {
      if (n.toLowerCase().includes(lower)) results.push(toCatalogCard(n, index));
    });
    if (isDuelLinks) {
      EXCLUSIVES.forEach((c) => {
        if (c.name.toLowerCase().includes(lower)) results.push(toExclusiveApiCard(c));
      });
    }
  }

  return results.length
    ? { status: 200, body: { data: results } }
    : { status: 404, body: { error: 'No card matching your query was found in the local database.' } };
}

async function installDuelLinksCardMock(page) {
  const log = { cardRequests: [], dlxRequests: [] };

  page.on('request', (request) => {
    if (request.url().includes('dlx-')) log.dlxRequests.push(request.url());
  });

  // Registered after installMockApi, so it takes precedence over the
  // helper's single card fixture.
  await page.route('**/api/v7/cardinfo.php**', async (route) => {
    const url = new URL(route.request().url());
    log.cardRequests.push(url.search);
    const { status, body } = findCards({
      name: url.searchParams.get('name'),
      fname: url.searchParams.get('fname'),
      id: url.searchParams.get('id'),
      game: url.searchParams.get('game')
    });
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });

  return log;
}

module.exports = {
  installDuelLinksCardMock,
  EXCLUSIVES
};
