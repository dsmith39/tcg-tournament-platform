// TCG banlist enforcement in the decklist legality check.
//
// The card catalog is imported from YGOPRODeck, whose `banlist_info.ban_tcg`
// uses 'Forbidden', 'Limited' and 'Semi-Limited'. These tests drive the real
// `validateDecklistLegality` in the browser against a mocked card endpoint so
// each card's status is fixed per test.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

// Ban statuses served by the mocked card endpoint. Fiber Jar is Forbidden in
// production's catalog and on Konami's list effective 2026-10-19 (see
// ops/staff/cards/2026-10-21-status.md). The 'Banned' card is a fixture name,
// kept so the legacy spelling stays covered once 'Forbidden' is handled.
const BAN_STATUS = {
  'Fiber Jar': 'Forbidden',
  'Banned Fixture Card': 'Banned',
  'Limited Fixture Card': 'Limited'
};

// 14 distinct unlimited fillers, 3 copies each, top any deck up to exactly 40.
const FILLERS = Array.from({ length: 14 }, (_, i) => `Filler Card ${i + 1}`);

function buildMainDeck(specialCards) {
  const lines = [...specialCards];
  for (const name of FILLERS) {
    for (let copy = 0; copy < 3 && lines.length < 40; copy += 1) {
      lines.push(name);
    }
  }
  return lines.join('\n');
}

async function openDecklists(page) {
  await installMockApi(page);
  // Registered after installMockApi, so it takes precedence over the
  // helper's single card fixture.
  await page.route('**/api/v7/cardinfo.php**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.searchParams.get('name') || url.searchParams.get('fname') || '';
    const status = BAN_STATUS[name];
    const card = { id: 1, name, type: 'Normal Monster' };
    if (status) card.banlist_info = { ban_tcg: status };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [card] })
    });
  });
  await page.addInitScript(() => {
    window.localStorage.setItem('token', 'playwright-token');
  });
  await page.goto('/decklists');
  await expect(page.getByRole('heading', { name: 'My Decklists' })).toBeVisible();
}

function checkTcgDeck(page, specialCards) {
  const mainDeck = buildMainDeck(specialCards);
  return page.evaluate(
    (deck) => window.validateDecklistLegality({
      game: 'ygo-tcg',
      mainDeck: deck,
      extraDeck: '',
      sideDeck: ''
    }),
    mainDeck
  );
}

test('a 40 card TCG deck with no restricted cards is legal', async ({ page }) => {
  await openDecklists(page);
  const result = await checkTcgDeck(page, []);
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
});

test('three copies of a Forbidden card fail the TCG check', async ({ page }) => {
  await openDecklists(page);
  const result = await checkTcgDeck(page, ['Fiber Jar', 'Fiber Jar', 'Fiber Jar']);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('Fiber Jar') && e.includes('Allowed copies: 0'))).toBe(true);
});

test('a single copy of a Forbidden card fails the TCG check', async ({ page }) => {
  await openDecklists(page);
  const result = await checkTcgDeck(page, ['Fiber Jar']);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('Fiber Jar') && e.includes('Allowed copies: 0'))).toBe(true);
});

test('a card with the legacy Banned status still fails the TCG check', async ({ page }) => {
  await openDecklists(page);
  const result = await checkTcgDeck(page, ['Banned Fixture Card']);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('Banned Fixture Card') && e.includes('Allowed copies: 0'))).toBe(true);
});

test('two copies of a Limited card fail the TCG check', async ({ page }) => {
  await openDecklists(page);
  const result = await checkTcgDeck(page, ['Limited Fixture Card', 'Limited Fixture Card']);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('Limited Fixture Card') && e.includes('Allowed copies: 1'))).toBe(true);
});
