// Cards landing in "Unresolved" on a saved deck's text view (board D012).
//
// Memo: ops/ceo-memos/2026-11-07-unresolved-cards.md (gitignored). Spec in
// ops/staff/board.md under D012, items 3 to 6 (the frontend half). Items 1
// and 2 (server) are in tests/api.integration.test.js as "unresolved cards:".
//
// The card mock (helpers/catalog-cards.js) answers like the fixed server:
// alternate art ids resolve on id=, and name= retries on a normalized name.
// So every failure here is about what the frontend does with those answers.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');
const { installCatalogCardMock } = require('./helpers/catalog-cards');

const NOT_FOUND_HEADING = 'Not in our card database';
const RETRY_NOTE = /Couldn.t load card info, refresh to retry/;

let nextDeckId = 0xd012000;
function deckId() {
  nextDeckId += 1;
  return `507f1f77bcf86cd7${nextDeckId.toString(16).padStart(8, '0')}`;
}

function fillers(count) {
  return Array.from({ length: count }, (_, i) => `Filler Card ${i + 1}`);
}

async function setup(page, { faults } = {}) {
  const state = await installMockApi(page);
  const cards = await installCatalogCardMock(page, { faults });
  await page.addInitScript(() => {
    window.localStorage.setItem('token', 'playwright-token');
  });
  return { state, cards };
}

// Saves a deck straight into the mock API's state and returns its id.
function savedDeck(state, { game = 'ygo-tcg', mainDeck, extraDeck = '', sideDeck = '' }) {
  const id = deckId();
  state.decklists.push({
    _id: id,
    name: `D012 deck ${id.slice(-4)}`,
    game,
    mainDeck: mainDeck.join('\n'),
    extraDeck,
    sideDeck,
    skills: '',
    archetype: '',
    notes: '',
    isPublic: true,
    owner: { username: 'playwright-user' }
  });
  return id;
}

async function openDeckText(page, id) {
  await page.goto(`/decklists/${id}`);
  await expect(page.locator('#decklist-detail-content h3', { hasText: 'Main Deck' })).toBeVisible();
}

const mainDeckView = (page) => page.locator('#decklist-detail-content');
const subgroup = (page, heading) => page.locator('.decklist-text-subgroup', {
  has: page.locator('h4', { hasText: heading })
});

// No card in any "Unresolved" or "Not in our card database" group.
async function expectNoNotFoundGroup(page) {
  await expect(subgroup(page, 'Unresolved')).toHaveCount(0);
  await expect(subgroup(page, NOT_FOUND_HEADING)).toHaveCount(0);
}

function requestsFor(cards, key, value) {
  return cards.requests.filter((params) => params[key] === value);
}

// ---------------------------------------------------------------------------
// Item 3: saved names that are all digits resolve through the passcode lookup.
// ---------------------------------------------------------------------------
test('a saved deck holding raw alternate art passcodes shows the real names and types', async ({ page }) => {
  const { state, cards } = await setup(page);
  const id = savedDeck(state, {
    mainDeck: ['36996508', '36996508', '36996508', '14558128', '18144506', ...fillers(35)]
  });

  await openDeckText(page, id);

  const monsters = subgroup(page, 'Monsters');
  await expect(monsters.locator('.decklist-text-row', { hasText: 'Dark Magician' })).toContainText('3x');
  await expect(monsters).toContainText('Ash Blossom & Joyous Spring');
  await expect(subgroup(page, 'Spells')).toContainText("Harpie's Feather Duster");
  await expectNoNotFoundGroup(page);

  // The raw numbers don't show anywhere in the view.
  for (const passcode of ['36996508', '14558128', '18144506']) {
    await expect(mainDeckView(page)).not.toContainText(passcode);
  }

  // Resolved through id=, the passcode lookup.
  expect(requestsFor(cards, 'id', '36996508').length).toBeGreaterThan(0);
  expect(requestsFor(cards, 'id', '18144506').length).toBeGreaterThan(0);
});

test('a saved passcode that is no card at all is listed as not in our card database', async ({ page }) => {
  const { state } = await setup(page);
  const id = savedDeck(state, { mainDeck: ['99999999', '46986415', ...fillers(38)] });

  await openDeckText(page, id);

  await expect(subgroup(page, 'Monsters')).toContainText('Dark Magician');
  await expect(subgroup(page, NOT_FOUND_HEADING)).toContainText('99999999');
  await expect(subgroup(page, 'Unresolved')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Item 2 seen from the view. Passes on main with this mock (the fix is on the
// server); it guards against the view mangling a name before it asks.
// ---------------------------------------------------------------------------
test('guard: pasted spellings Maxx C and "and" for "&" sort into Monsters', async ({ page }) => {
  const { state } = await setup(page);
  const id = savedDeck(state, { mainDeck: ['Maxx C', 'Maxx C', 'Ash Blossom and Joyous Spring', ...fillers(37)] });

  await openDeckText(page, id);

  await expect(subgroup(page, 'Monsters')).toContainText('Maxx C');
  await expect(subgroup(page, 'Monsters')).toContainText('Ash Blossom and Joyous Spring');
  await expectNoNotFoundGroup(page);
});

// ---------------------------------------------------------------------------
// Item 4: only a 404 means not found. 5xx and network errors retry once.
// ---------------------------------------------------------------------------
test('a card whose lookup keeps returning 500 shows the retry note, not the not found group', async ({ page }) => {
  const { state, cards } = await setup(page, { faults: { 'Pot of Greed': 'status500' } });
  const id = savedDeck(state, { mainDeck: ['Pot of Greed', 'Dark Magician', ...fillers(38)] });

  await openDeckText(page, id);

  await expect(mainDeckView(page).getByText(RETRY_NOTE)).toBeVisible();
  await expect(mainDeckView(page)).toContainText('Pot of Greed');
  await expectNoNotFoundGroup(page);
  // The rest of the deck still sorts.
  await expect(subgroup(page, 'Monsters')).toContainText('Dark Magician');

  // One try plus exactly one retry.
  expect(requestsFor(cards, 'name', 'Pot of Greed')).toHaveLength(2);
});

test('a dropped request is retried once and the card sorts normally', async ({ page }) => {
  const { state, cards } = await setup(page, { faults: { 'Pot of Greed': 'abortOnce' } });
  const id = savedDeck(state, { mainDeck: ['Pot of Greed', 'Dark Magician', ...fillers(38)] });

  await openDeckText(page, id);

  await expect(subgroup(page, 'Spells')).toContainText('Pot of Greed');
  await expect(subgroup(page, 'Monsters')).toContainText('Dark Magician');
  await expectNoNotFoundGroup(page);
  await expect(mainDeckView(page).getByText(RETRY_NOTE)).toHaveCount(0);
  expect(requestsFor(cards, 'name', 'Pot of Greed')).toHaveLength(2);
});

test('a name the catalog does not have lands under "Not in our card database" and is not retried', async ({ page }) => {
  const { state, cards } = await setup(page);
  const id = savedDeck(state, { mainDeck: ['Definitely Not A Real Card', 'Dark Magician', ...fillers(38)] });

  await openDeckText(page, id);

  await expect(subgroup(page, NOT_FOUND_HEADING)).toContainText('Definitely Not A Real Card');
  await expect(subgroup(page, 'Unresolved')).toHaveCount(0);
  await expect(subgroup(page, 'Monsters')).toContainText('Dark Magician');
  await expect(mainDeckView(page).getByText(RETRY_NOTE)).toHaveCount(0);
  // A 404 is an answer, not a blip.
  expect(requestsFor(cards, 'name', 'Definitely Not A Real Card')).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Item 6: the fuzzy fallback asks for num=200, or isn't used at all.
// ---------------------------------------------------------------------------
test('the fuzzy name fallback asks for 200 results, or is gone', async ({ page }) => {
  const { state, cards } = await setup(page);
  const id = savedDeck(state, { mainDeck: ['Definitely Not A Real Card', 'Dark Magician', ...fillers(38)] });

  await openDeckText(page, id);
  await expect(subgroup(page, 'Monsters')).toContainText('Dark Magician');

  const fuzzy = cards.requests.filter((params) => params.fname !== null);
  for (const params of fuzzy) {
    expect(params.num, `fname=${params.fname} should send num=200`).toBe('200');
  }
});

// ---------------------------------------------------------------------------
// Item 5: imports say which tokens didn't resolve, and still keep them.
// ---------------------------------------------------------------------------
async function openNewDeck(page, game = 'ygo-tcg') {
  await page.goto('/decklists/new');
  await expect(page.locator('#decklist-builder h1')).toBeVisible();
  await page.fill('#decklist-name', 'D012 import');
  await page.selectOption('#decklist-game', game);
}

const feedback = (page) => page.locator('#deck-card-feedback');
const warningToast = (page) => page.locator('#notification-toast-stack .notification-toast.warning');

test('text import names the tokens it could not resolve and keeps them', async ({ page }) => {
  await setup(page);
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') {
      await dialog.accept('#main\nDark Magician\nNot A Real Card\nMaxx C\n46986415\n99999999\n#extra\n!side\n');
      return;
    }
    await dialog.accept();
  });
  await openNewDeck(page);

  await page.getByRole('button', { name: 'Import Text List' }).click();
  await expect(page.locator('#deck-count-main')).toHaveText('5');

  await expect(feedback(page)).toContainText('Not A Real Card');
  await expect(feedback(page)).toContainText('99999999');
  await expect(feedback(page)).not.toContainText('Dark Magician');
  await expect(feedback(page)).not.toContainText('Maxx');
  await expect(warningToast(page).first()).toContainText('Not A Real Card');

  // The alternate art passcode resolved to its card.
  await expect(page.locator('#deck-builder-main-monster')).toContainText('Dark Magician');
});

test('.ydk import names the passcodes it could not resolve, and saves resolved alternate arts by name', async ({ page }) => {
  const { state } = await setup(page);
  page.on('dialog', (dialog) => dialog.accept());
  await openNewDeck(page);

  const ydk = ['#main', '36996508', '36996508', '99999999', ...Array.from({ length: 37 }, (_, i) => String(1000 + i)), '#extra', '!side', ''].join('\n');
  await page.locator('#decklist-ydk-file').setInputFiles({
    name: 'alt-art.ydk',
    mimeType: 'text/plain',
    buffer: Buffer.from(ydk, 'utf8')
  });
  await expect(page.locator('#deck-count-main')).toHaveText('40');

  await expect(feedback(page)).toContainText('99999999');
  await expect(feedback(page)).not.toContainText('36996508');
  await expect(warningToast(page).first()).toContainText('99999999');
  await expect(page.locator('#deck-builder-main-monster')).toContainText('Dark Magician');

  // Saved by name: the alternate art never reaches the stored deck as a number.
  await page.locator('#decklist-submit-btn').click();
  await expect(page).toHaveURL(/\/decklists\/deck-\d+$/);
  const saved = state.decklists.find((deck) => deck.name === 'D012 import');
  expect(saved).toBeTruthy();
  const lines = saved.mainDeck.split('\n');
  expect(lines.filter((line) => line === 'Dark Magician')).toHaveLength(2);
  expect(lines).not.toContain('36996508');
});

// ---------------------------------------------------------------------------
// Duel Links exclusives keep resolving only with game=duel-links.
// ---------------------------------------------------------------------------
test('Kiteroid sorts into Monsters in a saved Duel Links deck and is not found in a TCG deck', async ({ page }) => {
  const { state, cards } = await setup(page);
  const dlId = savedDeck(state, { game: 'duel-links', mainDeck: ['Kiteroid', ...fillers(19)] });
  const tcgId = savedDeck(state, { game: 'ygo-tcg', mainDeck: ['Kiteroid', ...fillers(39)] });

  await openDeckText(page, dlId);
  await expect(subgroup(page, 'Monsters')).toContainText('Kiteroid');
  await expectNoNotFoundGroup(page);
  expect(cards.requests.some((p) => p.name === 'Kiteroid' && p.game === 'duel-links')).toBe(true);

  await openDeckText(page, tcgId);
  await expect(subgroup(page, NOT_FOUND_HEADING)).toContainText('Kiteroid');
  await expect(subgroup(page, 'Monsters')).not.toContainText('Kiteroid');
});
