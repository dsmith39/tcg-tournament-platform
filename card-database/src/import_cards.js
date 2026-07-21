/*
 * Bulk-imports the full Yu-Gi-Oh card catalog from the live YGOPRODeck API
 * into the local SQLite mirror. This is the ONLY code path in the merged
 * app that ever calls db.ygoprodeck.com -- it's meant to be run manually
 * by the operator every so often (npm run cards:import), never per user
 * request, so the running app doesn't hammer the public API.
 */
const cardsRepo = require('./models/cards');

const API_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

async function fetchAllCards() {
  const response = await fetch(API_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch cards: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return payload.data || [];
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullable(value) {
  return value === undefined ? null : value;
}

function mapCard(card) {
  const banlistInfo = card.banlist_info || {};
  const firstPrice = (card.card_prices || [])[0] || {};

  return {
    cardId: card.id,
    name: toNullable(card.name),
    type: toNullable(card.type),
    frameType: toNullable(card.frameType),
    description: toNullable(card.desc),
    atk: toNullable(card.atk),
    def: toNullable(card.def),
    level: toNullable(card.level),
    race: toNullable(card.race),
    attribute: toNullable(card.attribute),
    archetype: toNullable(card.archetype),
    scale: toNullable(card.scale),
    linkval: toNullable(card.linkval),
    linkmarkers: Array.isArray(card.linkmarkers) ? card.linkmarkers : [],
    banlistInfo: {
      tcg: toNullable(banlistInfo.ban_tcg),
      ocg: toNullable(banlistInfo.ban_ocg),
      goat: toNullable(banlistInfo.ban_goat),
      masterDuel: toNullable(banlistInfo.ban_master_duel),
      duelLinks: toNullable(banlistInfo.ban_duel_links)
    },
    images: (card.card_images || []).map((image) => ({
      imageId: image.id,
      imageUrl: toNullable(image.image_url),
      imageUrlSmall: toNullable(image.image_url_small),
      imageUrlCropped: toNullable(image.image_url_cropped)
    })),
    sets: (card.card_sets || []).map((cardSet) => ({
      setName: toNullable(cardSet.set_name),
      setCode: toNullable(cardSet.set_code),
      setRarity: toNullable(cardSet.set_rarity),
      setRarityCode: toNullable(cardSet.set_rarity_code),
      setPrice: toNumber(cardSet.set_price)
    })),
    prices: {
      cardmarketPrice: toNumber(firstPrice.cardmarket_price),
      tcgplayerPrice: toNumber(firstPrice.tcgplayer_price),
      ebayPrice: toNumber(firstPrice.ebay_price),
      amazonPrice: toNumber(firstPrice.amazon_price),
      coolstuffincPrice: toNumber(firstPrice.coolstuffinc_price)
    }
  };
}

async function runImport() {
  console.log('Fetching card catalog from YGOPRODeck...');
  const cards = await fetchAllCards();
  const batchSize = 250;

  for (let start = 0; start < cards.length; start += batchSize) {
    const batch = cards.slice(start, start + batchSize).map(mapCard);
    cardsRepo.upsertMany(batch);

    const imported = Math.min(start + batchSize, cards.length);
    console.log(`Imported ${imported}/${cards.length} cards...`);
  }

  console.log(`Import complete. Loaded ${cards.length} cards into card-database/data/cards.db.`);
}

runImport().catch((error) => {
  console.error(error);
  process.exit(1);
});
