/*
 * Mountable Express router serving Yu-Gi-Oh card data from the local SQLite
 * mirror (card-database/data/cards.db). Replaces ygo-database's old
 * api_server.js, which was a standalone self-listening app -- this exports
 * a router instead so server/api-server.js can mount it directly at
 * /api/v7, in-process, with no second server/port involved.
 *
 * No live YGOPRODeck fallback on a cache miss: a card missing locally just
 * isn't found. Refresh the mirror with `npm run cards:import` instead of
 * silently falling back to the live API on every miss.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cardsRepo = require('./models/cards');

const IMAGE_DIR = process.env.CARD_IMAGE_DIR
  ? path.resolve(process.cwd(), process.env.CARD_IMAGE_DIR)
  : path.resolve(__dirname, '..', 'card-images');

function toSafeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

// Card image URLs never point at the raw ygoprodeck.com URLs stored at
// import time, so the frontend never talks to the live API for images
// either. When CARD_IMAGE_BASE_URL is set (deployed -- points at the
// CloudFront distribution in front of the card images S3 bucket), URLs go
// straight there using the same flat {cardId}[.jpg|_small.jpg|_cropped.jpg]
// layout download_card_images.js already writes locally. Local dev (no
// CARD_IMAGE_BASE_URL) keeps using this router's own /card-image/:id route.
function buildLocalImageUrl(req, cardId, size = 'full') {
  if (!cardId) return '';
  const suffix = size === 'small' ? '_small' : size === 'cropped' ? '_cropped' : '';

  if (process.env.CARD_IMAGE_BASE_URL) {
    return `${process.env.CARD_IMAGE_BASE_URL.replace(/\/$/, '')}/${encodeURIComponent(String(cardId))}${suffix}.jpg`;
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const url = new URL(`/api/v7/card-image/${encodeURIComponent(String(cardId))}`, baseUrl);
  if (size !== 'full') {
    url.searchParams.set('size', size);
  }
  return url.toString();
}

function toApiCard(card, req) {
  return {
    id: card.cardId,
    name: card.name,
    type: card.type,
    frameType: card.frameType,
    desc: card.description,
    atk: card.atk,
    def: card.def,
    level: card.level,
    race: card.race,
    attribute: card.attribute,
    archetype: card.archetype,
    scale: card.scale,
    linkval: card.linkval,
    linkmarkers: card.linkmarkers,
    card_images: (card.images || []).map((image) => ({
      id: image.imageId,
      image_url: buildLocalImageUrl(req, image.imageId, 'full'),
      image_url_small: buildLocalImageUrl(req, image.imageId, 'small'),
      image_url_cropped: buildLocalImageUrl(req, image.imageId, 'cropped')
    })),
    card_sets: (card.sets || []).map((set) => ({
      set_name: set.setName,
      set_code: set.setCode,
      set_rarity: set.setRarity,
      set_rarity_code: set.setRarityCode,
      set_price: set.setPrice
    })),
    card_prices: card.prices
      ? [{
        cardmarket_price: card.prices.cardmarketPrice,
        tcgplayer_price: card.prices.tcgplayerPrice,
        ebay_price: card.prices.ebayPrice,
        amazon_price: card.prices.amazonPrice,
        coolstuffinc_price: card.prices.coolstuffincPrice
      }]
      : [],
    banlist_info: card.banlistInfo
      ? {
        ban_tcg: card.banlistInfo.tcg,
        ban_ocg: card.banlistInfo.ocg,
        ban_goat: card.banlistInfo.goat,
        ban_master_duel: card.banlistInfo.masterDuel,
        ban_duel_links: card.banlistInfo.duelLinks
      }
      : undefined
  };
}

function findLocalImageFile(baseName) {
  const extensions = ['.jpg', '.jpeg', '.png', '.webp'];
  for (const extension of extensions) {
    const candidate = path.join(IMAGE_DIR, `${baseName}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const CONTENT_TYPE_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

const router = express.Router();

router.get('/cardinfo.php', (req, res) => {
  try {
    const query = {
      fname: req.query.fname ? String(req.query.fname) : undefined,
      name: req.query.name ? String(req.query.name) : undefined,
      archetype: req.query.archetype ? String(req.query.archetype) : undefined,
      type: req.query.type ? String(req.query.type) : undefined,
      attribute: req.query.attribute ? String(req.query.attribute) : undefined,
      race: req.query.race ? String(req.query.race) : undefined,
      num: Math.min(toSafeInt(req.query.num, 20) || 20, 200),
      offset: toSafeInt(req.query.offset, 0)
    };

    if (req.query.id !== undefined) {
      const id = toSafeInt(req.query.id, NaN);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'id must be a positive integer' });
        return;
      }
      query.id = id;
    }

    if (req.query.level !== undefined) {
      const level = toSafeInt(req.query.level, NaN);
      if (!Number.isFinite(level)) {
        res.status(400).json({ error: 'level must be a number' });
        return;
      }
      query.level = level;
    }

    const cards = cardsRepo.findByQuery(query);

    if (cards.length === 0) {
      res.status(404).json({ error: 'No card matching your query was found in the local database.' });
      return;
    }

    res.json({ data: cards.map((card) => toApiCard(card, req)) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Invalid query' });
  }
});

router.get('/card-image/:id', (req, res) => {
  const cardId = String(req.params.id || '').trim();
  const size = String(req.query.size || 'full').trim().toLowerCase();

  if (!/^\d+$/.test(cardId)) {
    res.status(400).json({ message: 'Invalid card image id' });
    return;
  }

  const suffix = size === 'small' ? '_small' : size === 'cropped' ? '_cropped' : '';
  const filePath = findLocalImageFile(`${cardId}${suffix}`);

  if (!filePath) {
    res.status(404).json({ message: 'Card image not found locally. Run npm run cards:download-images.' });
    return;
  }

  const contentType = CONTENT_TYPE_BY_EXT[path.extname(filePath).toLowerCase()] || 'image/jpeg';
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  // Pass a bare filename with `root: IMAGE_DIR` rather than the absolute filePath --
  // res.sendFile() runs its path argument through encodeURI(), which turns Windows
  // backslash separators into %5C and breaks the lookup on Windows dev machines.
  // `root` itself is never encodeURI'd, so it can safely be an absolute path.
  res.type(contentType).sendFile(path.basename(filePath), { root: IMAGE_DIR });
});

router.get('/health', (req, res) => {
  res.json({ ok: true, cards: cardsRepo.count(), imagesDirectory: IMAGE_DIR });
});

module.exports = router;
