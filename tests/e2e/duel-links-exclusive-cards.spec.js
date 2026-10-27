// Duel Links exclusive cards in the deck builder (board D011).
//
// Spec: ops/staff/cards/2026-10-27-duel-links-exclusive-cards-spec.md
// (gitignored), "Tests QA should write", items 7 to 14.
//
// The card mock (helpers/dl-exclusive-cards.js) answers Kiteroid, Playmaker
// and the other fixture exclusives ONLY when the request carries
// game=duel-links, so every positive result here proves the frontend sent the
// game. Tests that check a refusal also prove the same card works in Duel
// Links, so they can't pass just because nothing knows the card.
const fs = require('node:fs');
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');
const { installDuelLinksCardMock } = require('./helpers/dl-exclusive-cards');

const SAVED_DL_DECK_ID = '507f1f77bcf86cd7994390d1';

function fillers(count) {
  // Up to 30 distinct names, 1 copy each, so the 3 copy cap never interferes.
  return Array.from({ length: count }, (_, i) => `Filler Card ${i + 1}`);
}

// Accepts every dialog and records alerts. A deck text import prompt gets
// `importText` (19 fillers by default).
function handleDialogs(page, importText = fillers(19).join('\n')) {
  const log = { alerts: [] };
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt' && dialog.message().startsWith('Paste your deck text')) {
      await dialog.accept(`#main\n${importText}\n#extra\n!side\n`);
      return;
    }
    if (dialog.type() === 'alert') log.alerts.push(dialog.message());
    await dialog.accept();
  });
  return log;
}

async function setup(page) {
  const state = await installMockApi(page);
  const cards = await installDuelLinksCardMock(page);
  state.decklists.push({
    _id: SAVED_DL_DECK_ID,
    name: 'Kite Links',
    game: 'duel-links',
    mainDeck: ['Kiteroid', ...fillers(19)].join('\n'),
    extraDeck: '',
    sideDeck: '',
    skills: 'Balance',
    archetype: '',
    notes: '',
    isPublic: true,
    owner: { username: 'playwright-user' }
  });
  await page.addInitScript(() => {
    window.localStorage.setItem('token', 'playwright-token');
  });
  const dialogs = handleDialogs(page);
  return { state, cards, dialogs };
}

async function openNewDeck(page, game) {
  await page.goto('/decklists/new');
  await expect(page.locator('#decklist-builder h1')).toBeVisible();
  await page.fill('#decklist-name', 'Exclusive Test');
  await page.selectOption('#decklist-game', game);
}

// Types a name and presses + Add Card, then waits for the lookup to settle.
async function addCard(page, name) {
  await page.fill('#deck-card-name', name);
  await page.locator('#deck-add-card-btn').click();
  await expect(page.locator('#deck-card-feedback')).not.toHaveText('Searching card...');
  await expect(page.locator('#deck-add-card-btn')).toBeEnabled();
}

const feedback = (page) => page.locator('#deck-card-feedback');
const mainMonsters = (page) => page.locator('#deck-builder-main-monster');
const extraDeck = (page) => page.locator('#deck-builder-extra');

function requestedWithGame(cards, name, game) {
  return cards.cardRequests.some((search) => {
    const params = new URLSearchParams(search);
    return params.get('name') === name && params.get('game') === game;
  });
}

// 7
test('Duel Links deck: autocomplete offers Kiteroid and adding it shows a placeholder, no image request', async ({ page }) => {
  const { cards } = await setup(page);
  await openNewDeck(page, 'duel-links');

  await page.locator('#deck-card-name').pressSequentially('Kite');
  const suggestion = page.locator('#deck-card-suggestions .card-suggestion-btn', { hasText: 'Kiteroid' });
  await expect(suggestion).toBeVisible();
  await suggestion.click();

  await expect(feedback(page)).toHaveText('Added Kiteroid to main deck.');
  await expect(page.locator('#deck-count-main')).toHaveText('1');
  const item = mainMonsters(page).locator('.deck-card-item', { hasText: 'Kiteroid' });
  await expect(item).toHaveCount(1);
  await expect(item.locator('.deck-card-thumb')).toHaveCount(1);
  await expect(item.locator('img')).toHaveCount(0);

  expect(cards.dlxRequests).toEqual([]);
});

// 8
test('TCG and Master Duel decks refuse Kiteroid; the same card adds once the deck is Duel Links', async ({ page }) => {
  await setup(page);

  for (const game of ['ygo-tcg', 'master-duel']) {
    await openNewDeck(page, game);
    await addCard(page, 'Kiteroid');
    await expect(feedback(page)).not.toContainText('Added');
    await expect(page.locator('#deck-count-main')).toHaveText('0');
    await expect(page.locator('#deck-count-extra')).toHaveText('0');
  }

  // Control: the refusal above is about the game, not an unknown card.
  await page.selectOption('#decklist-game', 'duel-links');
  await addCard(page, 'Kiteroid');
  await expect(feedback(page)).toHaveText('Added Kiteroid to main deck.');
  await expect(page.locator('#deck-count-main')).toHaveText('1');
});

// 9
test('Duel Links deck: Playmaker (Xyz) and Satellite Laser Balsam (Fusion) go to Extra with the dropdown on Main', async ({ page }) => {
  await setup(page);
  await openNewDeck(page, 'duel-links');
  await expect(page.locator('#deck-card-section')).toHaveValue('main');

  await addCard(page, 'Playmaker');
  await expect(feedback(page)).toHaveText('Added Playmaker to extra deck.');
  await addCard(page, 'Satellite Laser Balsam');
  await expect(feedback(page)).toHaveText('Added Satellite Laser Balsam to extra deck.');

  await expect(page.locator('#deck-count-extra')).toHaveText('2');
  await expect(page.locator('#deck-count-main')).toHaveText('0');
  await expect(extraDeck(page)).toContainText('Playmaker');
  await expect(extraDeck(page)).toContainText('Satellite Laser Balsam');
});

// 10
test('Duel Links deck: Archfiend Matador (Ritual) and Mach Synchron (Tuner) stay in Main', async ({ page }) => {
  await setup(page);
  await openNewDeck(page, 'duel-links');

  await addCard(page, 'Archfiend Matador');
  await expect(feedback(page)).toHaveText('Added Archfiend Matador to main deck.');
  await addCard(page, 'Mach Synchron');
  await expect(feedback(page)).toHaveText('Added Mach Synchron to main deck.');

  await expect(page.locator('#deck-count-main')).toHaveText('2');
  await expect(page.locator('#deck-count-extra')).toHaveText('0');
  await expect(mainMonsters(page)).toContainText('Archfiend Matador');
  await expect(mainMonsters(page)).toContainText('Mach Synchron');
});

// 11
test('cache: Kiteroid added in a Duel Links deck is still refused after switching the deck to TCG', async ({ page }) => {
  await setup(page);
  await openNewDeck(page, 'duel-links');

  await addCard(page, 'Kiteroid');
  await expect(feedback(page)).toHaveText('Added Kiteroid to main deck.');
  await expect(page.locator('#deck-count-main')).toHaveText('1');

  await page.selectOption('#decklist-game', 'ygo-tcg');
  await addCard(page, 'Kiteroid');
  await expect(feedback(page)).not.toContainText('Added');
  await expect(page.locator('#deck-count-main')).toHaveText('1');
});

// 12
test('a saved Duel Links deck with Kiteroid is blocked from saving as TCG, and saves again as Duel Links', async ({ page }) => {
  const { cards, dialogs } = await setup(page);

  await page.goto(`/decklists/${SAVED_DL_DECK_ID}/edit`);
  await expect(page.locator('#decklist-game')).toHaveValue('duel-links');
  await expect(page.locator('#deck-count-main')).toHaveText('20');

  await page.selectOption('#decklist-game', 'ygo-tcg');
  await page.locator('#decklist-submit-btn').click();
  await expect.poll(() => dialogs.alerts.length).toBe(1);
  const lines = dialogs.alerts[0].split('\n');
  expect(
    lines.some((line) => line.includes('Kiteroid') && line.includes('Duel Links')),
    `expected an error naming Kiteroid as a Duel Links card, got:\n${dialogs.alerts[0]}`
  ).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/decklists/${SAVED_DL_DECK_ID}/edit$`));

  // The check for a Master Duel deck runs the same lookup.
  const masterDuel = await page.evaluate((mainDeck) => window.validateDecklistLegality({
    game: 'master-duel', mainDeck, extraDeck: '', sideDeck: ''
  }), ['Kiteroid', ...fillers(30), ...fillers(9)].join('\n'));
  expect(masterDuel.valid).toBe(false);
  expect(masterDuel.errors.some((e) => e.includes('Kiteroid') && e.includes('Duel Links'))).toBe(true);
  expect(requestedWithGame(cards, 'Kiteroid', 'duel-links')).toBe(true);

  // Back to Duel Links: the same deck is valid and saves.
  await page.selectOption('#decklist-game', 'duel-links');
  await page.locator('#decklist-submit-btn').click();
  await expect(page).toHaveURL(new RegExp(`/decklists/${SAVED_DL_DECK_ID}$`));
  expect(dialogs.alerts).toHaveLength(1);
});

// 13
test('.ydk export writes Kiteroid under #main and Playmaker under #extra by name, and re-import restores them', async ({ page }) => {
  const { cards } = await setup(page);
  await openNewDeck(page, 'duel-links');

  await addCard(page, 'Kiteroid');
  await expect(feedback(page)).toHaveText('Added Kiteroid to main deck.');
  await addCard(page, 'Playmaker');
  await expect(feedback(page)).toHaveText('Added Playmaker to extra deck.');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .ydk' }).click();
  const download = await downloadPromise;
  const content = fs.readFileSync(await download.path(), 'utf8');

  expect(content).not.toContain('dlx-');
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const mainAt = lines.indexOf('#main');
  const extraAt = lines.indexOf('#extra');
  const sideAt = lines.indexOf('!side');
  expect(lines.slice(mainAt + 1, extraAt)).toContain('Kiteroid');
  expect(lines.slice(extraAt + 1, sideAt)).toContain('Playmaker');
  expect(lines.slice(mainAt + 1, extraAt)).not.toContain('Playmaker');

  // Re-import into a fresh Duel Links deck.
  await openNewDeck(page, 'duel-links');
  await expect(page.locator('#deck-count-main')).toHaveText('0');
  cards.cardRequests.length = 0;
  await page.locator('#decklist-ydk-file').setInputFiles({
    name: 'exclusive.ydk',
    mimeType: 'text/plain',
    buffer: Buffer.from(content, 'utf8')
  });
  await expect(feedback(page)).toHaveText('Imported exclusive.ydk');
  await expect(page.locator('#deck-count-main')).toHaveText('1');
  await expect(page.locator('#deck-count-extra')).toHaveText('1');
  await expect(mainMonsters(page)).toContainText('Kiteroid');
  await expect(extraDeck(page)).toContainText('Playmaker');
  // The import resolved both through the Duel Links lookup, not just kept the names.
  expect(requestedWithGame(cards, 'Kiteroid', 'duel-links')).toBe(true);
  expect(requestedWithGame(cards, 'Playmaker', 'duel-links')).toBe(true);
});

// 14. Flip this test when D003 (Duel Links limits) is decided: Kiteroid is
// Limited 2 in Duel Links, so once limits are enforced this save must fail.
test('D003 pending: a Duel Links deck with 3 Kiteroid (Limited 2) still saves until Duel Links limits are enforced', async ({ page }) => {
  const { state } = await setup(page);
  await openNewDeck(page, 'duel-links');

  await page.getByRole('button', { name: 'Import Text List' }).click();
  await expect(page.locator('#deck-count-main')).toHaveText('19');

  for (let copy = 1; copy <= 3; copy += 1) {
    await addCard(page, 'Kiteroid');
    await expect(feedback(page)).toHaveText('Added Kiteroid to main deck.');
  }
  await expect(page.locator('#deck-count-main')).toHaveText('22');

  await page.locator('#decklist-submit-btn').click();
  await expect(page).toHaveURL(/\/decklists\/deck-\d+$/);
  const saved = state.decklists.find((deck) => deck.name === 'Exclusive Test');
  expect(saved).toBeTruthy();
  expect(saved.mainDeck.split('\n').filter((line) => line === 'Kiteroid')).toHaveLength(3);
});
