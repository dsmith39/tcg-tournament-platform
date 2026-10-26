// The deck builder as its own page: /decklists/new, /decklists/<id>/edit and
// /decklists/new?tournament=<id> (board D008). Covers deep links and refresh,
// the unsaved changes guard (in app Back, nav, browser back), where saving
// lands, and the join prompt round trip back to the tournament.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

const LEGAL_DECK_ID = '507f1f77bcf86cd799439099';
const TOURNAMENT_ID = '507f1f77bcf86cd799439077';

// 14 distinct fillers, 3 copies each, cut at 40: a legal TCG main deck.
function buildLegalMainDeck() {
  const lines = [];
  for (let i = 1; i <= 14; i += 1) {
    for (let copy = 0; copy < 3 && lines.length < 40; copy += 1) {
      lines.push(`Filler Card ${i}`);
    }
  }
  return lines.join('\n');
}

const LEGAL_MAIN_DECK = buildLegalMainDeck();

// Answers every dialog. confirm() answers come from `confirmAnswers` in order
// (default: accept); prompt() for a deck text import gets LEGAL_MAIN_DECK; the
// join prompt's decklist choice is recorded and dismissed, so nothing joins.
function handleDialogs(page, confirmAnswers = []) {
  const log = { confirms: [], alerts: [], joinPrompts: [] };
  page.on('dialog', async (dialog) => {
    const message = dialog.message();
    if (dialog.type() === 'confirm') {
      log.confirms.push(message);
      const answer = confirmAnswers.length ? confirmAnswers.shift() : true;
      await (answer ? dialog.accept() : dialog.dismiss());
      return;
    }
    if (dialog.type() === 'prompt' && message.startsWith('Paste your deck text')) {
      await dialog.accept(`#main\n${LEGAL_MAIN_DECK}\n#extra\n!side\n`);
      return;
    }
    if (dialog.type() === 'prompt') {
      log.joinPrompts.push(message);
      await dialog.dismiss();
      return;
    }
    if (dialog.type() === 'beforeunload') {
      await dialog.accept();
      return;
    }
    log.alerts.push(message);
    await dialog.accept();
  });
  return log;
}

async function setup(page, options = {}) {
  const state = await installMockApi(page);

  state.decklists.push({
    _id: LEGAL_DECK_ID,
    name: 'Legal Fillers',
    game: 'ygo-tcg',
    mainDeck: LEGAL_MAIN_DECK,
    extraDeck: '',
    sideDeck: '',
    archetype: '',
    notes: '',
    isPublic: true,
    owner: { username: 'playwright-user' }
  });

  state.tournaments.push({
    _id: TOURNAMENT_ID,
    name: 'Friday Locals',
    game: 'ygo-tcg',
    format: 'swiss',
    maxPlayers: 16,
    currentPlayers: 0,
    status: 'registration',
    createdBy: { _id: 'u2', username: 'test-opponent' },
    players: [],
    registrations: [],
    rounds: []
  });

  // Echo whatever card is asked for, so any name resolves and is unlimited.
  await page.route('**/api/v7/cardinfo.php**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.searchParams.get('name') || url.searchParams.get('fname') || 'Blue-Eyes White Dragon';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 1, name, type: 'Normal Monster' }] })
    });
  });

  if (options.loggedOut) {
    await page.route('**/api/auth/me**', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No token provided' })
      });
    });
  } else {
    await page.addInitScript(() => {
      window.localStorage.setItem('token', 'playwright-token');
    });
  }

  return state;
}

const builderHeading = (page) => page.locator('#decklist-builder h1');

test('Deck Builder nav link opens a clean /decklists/new that survives a refresh', async ({ page }) => {
  await setup(page);
  handleDialogs(page);

  await page.goto('/dashboard');
  const navLink = page.locator('#deck-builder-btn');
  await expect(navLink).toBeVisible();
  await navLink.click();

  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(builderHeading(page)).toHaveText('Create Decklist');
  await expect(page.locator('#decklist-name')).toHaveValue('');
  await expect(page.locator('#decklist-builder-context')).toBeHidden();

  await page.reload();
  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(builderHeading(page)).toHaveText('Create Decklist');
  await expect(page.locator('#decklist-form')).toBeVisible();
});

test('logged out: no Deck Builder link, and builder deep links go to login', async ({ page }) => {
  await setup(page, { loggedOut: true });
  handleDialogs(page);

  await page.goto('/');
  await expect(page.locator('#deck-builder-btn')).toBeHidden();

  await page.goto('/decklists/new');
  await expect(page).toHaveURL(/\/auth\/login$/);

  await page.goto(`/decklists/${LEGAL_DECK_ID}/edit`);
  await expect(page).toHaveURL(/\/auth\/login$/);
});

test('logout hides the Deck Builder link without a reload', async ({ page }) => {
  await setup(page);
  handleDialogs(page);

  await page.goto('/dashboard');
  await expect(page.locator('#deck-builder-btn')).toBeVisible();
  await page.locator('#logout-btn').click();
  await expect(page.locator('#deck-builder-btn')).toBeHidden();
});

test('edit deep link loads the saved deck on a cold load', async ({ page }) => {
  await setup(page);
  handleDialogs(page);

  await page.goto('/decklists/507f1f77bcf86cd799439011/edit');
  await expect(builderHeading(page)).toHaveText('Edit Decklist');
  await expect(page.locator('#decklist-name')).toHaveValue('Starter Deck');
  await expect(page.locator('#decklist-game')).toHaveValue('ygo-tcg');
  await expect(page.locator('#decklist-archetype')).toHaveValue('Blue-Eyes');
  await expect(page.locator('#deck-count-main')).toHaveText('1');
  await expect(page.locator('#decklist-submit-btn')).toHaveText('Update Decklist');
});

test('edit deep link for a deck that is not yours goes to My Decklists with a notice', async ({ page }) => {
  await setup(page);
  handleDialogs(page);

  await page.goto('/decklists/507f1f77bcf86cd7994390ff/edit');
  await expect(page).toHaveURL(/\/decklists$/);
  await expect(page.getByRole('heading', { name: 'My Decklists' })).toBeVisible();
  await expect(page.locator('#notification-toast-stack')).toContainText('could not be opened for editing');
  await expect(page.locator('#decklist-builder')).toBeHidden();
});

test('Escape does nothing to the builder form', async ({ page }) => {
  await setup(page);
  handleDialogs(page);

  await page.goto('/decklists/new');
  await page.fill('#decklist-name', 'Escape Proof');
  await page.keyboard.press('Escape');
  await page.locator('body').press('Escape');

  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(page.locator('#decklist-name')).toHaveValue('Escape Proof');
});

test('in app Back asks once with unsaved changes, and Cancel keeps the deck', async ({ page }) => {
  await setup(page);
  const dialogs = handleDialogs(page, [false, true]);

  await page.goto('/decklists');
  await page.getByRole('button', { name: '+ New Decklist' }).click();
  await expect(page).toHaveURL(/\/decklists\/new$/);
  await page.fill('#decklist-name', 'Half Built');

  await page.locator('#decklist-form-close-btn').click();
  expect(dialogs.confirms).toHaveLength(1);
  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(page.locator('#decklist-name')).toHaveValue('Half Built');

  await page.locator('#decklist-form-close-btn').click();
  expect(dialogs.confirms).toHaveLength(2);
  await expect(page).toHaveURL(/\/decklists$/);
  await expect(page.getByRole('heading', { name: 'My Decklists' })).toBeVisible();
});

test('in app Back with no changes leaves without asking', async ({ page }) => {
  await setup(page);
  const dialogs = handleDialogs(page);

  await page.goto('/decklists');
  await page.getByRole('button', { name: '+ New Decklist' }).click();
  await page.locator('#decklist-form-close-btn').click();

  await expect(page).toHaveURL(/\/decklists$/);
  expect(dialogs.confirms).toHaveLength(0);
});

test('browser back from a dirty builder asks; Cancel stays, OK lands on My Decklists', async ({ page }) => {
  await setup(page);
  const dialogs = handleDialogs(page, [false, true]);

  await page.goto('/decklists');
  await page.getByRole('button', { name: '+ New Decklist' }).click();
  await expect(page).toHaveURL(/\/decklists\/new$/);
  await page.fill('#decklist-name', 'Do Not Lose Me');

  await page.goBack();
  await expect.poll(() => dialogs.confirms.length).toBe(1);
  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(builderHeading(page)).toBeVisible();
  await expect(page.locator('#decklist-name')).toHaveValue('Do Not Lose Me');

  await page.goBack();
  await expect.poll(() => dialogs.confirms.length).toBe(2);
  await expect(page).toHaveURL(/\/decklists$/);
  await expect(page.getByRole('heading', { name: 'My Decklists' })).toBeVisible();
});

test('browser back from a clean builder lands on My Decklists', async ({ page }) => {
  await setup(page);
  const dialogs = handleDialogs(page);

  await page.goto('/decklists');
  await page.getByRole('button', { name: '+ New Decklist' }).click();
  await expect(page).toHaveURL(/\/decklists\/new$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/decklists$/);
  await expect(page.getByRole('heading', { name: 'My Decklists' })).toBeVisible();
  expect(dialogs.confirms).toHaveLength(0);
});

test('Deck Builder nav click with unsaved work asks before resetting', async ({ page }) => {
  await setup(page);
  const dialogs = handleDialogs(page, [false, true]);

  await page.goto('/decklists/new');
  await page.fill('#decklist-name', 'Work In Progress');

  await page.locator('#deck-builder-btn').click();
  expect(dialogs.confirms).toHaveLength(1);
  await expect(page.locator('#decklist-name')).toHaveValue('Work In Progress');

  await page.locator('#deck-builder-btn').click();
  expect(dialogs.confirms).toHaveLength(2);
  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(page.locator('#decklist-name')).toHaveValue('');
});

test('saving an edit lands on the deck page with the new data, and back skips the builder', async ({ page }) => {
  await setup(page);
  handleDialogs(page);

  await page.goto('/decklists');
  await page.goto(`/decklists/${LEGAL_DECK_ID}/edit`);
  await expect(page.locator('#deck-count-main')).toHaveText('40');
  await page.fill('#decklist-name', 'Legal Fillers v2');
  await page.locator('#decklist-submit-btn').click();

  await expect(page).toHaveURL(new RegExp(`/decklists/${LEGAL_DECK_ID}$`));
  await expect(page.getByRole('heading', { name: 'Legal Fillers v2' })).toBeVisible();
  await expect(page.locator('#notification-toast-stack')).toContainText('Decklist saved successfully.');

  await page.goBack();
  await expect(page).toHaveURL(/\/decklists$/);
  await expect(page.locator('#decklist-builder')).toBeHidden();
});

test('saving a new deck lands on its own page', async ({ page }) => {
  const state = await setup(page);
  handleDialogs(page);

  await page.goto('/decklists/new');
  await page.fill('#decklist-name', 'Fresh Build');
  await page.selectOption('#decklist-game', 'ygo-tcg');
  await page.getByRole('button', { name: 'Import Text List' }).click();
  await expect(page.locator('#deck-count-main')).toHaveText('40');
  await page.locator('#decklist-submit-btn').click();

  await expect(page).toHaveURL(/\/decklists\/deck-\d+$/);
  await expect(page.getByRole('heading', { name: 'Fresh Build' })).toBeVisible();
  expect(state.decklists.some((deck) => deck.name === 'Fresh Build')).toBe(true);
});

test('join prompt with no decks builds one and returns to the tournament without joining', async ({ page }) => {
  const state = await setup(page);
  const dialogs = handleDialogs(page);
  state.decklists = [];

  let joinCalls = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/tournaments/${TOURNAMENT_ID}/join`)) {
      joinCalls += 1;
    }
  });

  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Join', exact: true }).first().click();

  await expect(page).toHaveURL(new RegExp(`/decklists/new\\?tournament=${TOURNAMENT_ID}$`));
  expect(dialogs.alerts.some((message) => message.includes('create at least one decklist'))).toBe(true);
  await expect(page.locator('#decklist-game')).toHaveValue('ygo-tcg');
  await expect(page.locator('#decklist-builder-context')).toContainText('Friday Locals');
  await expect(page.locator('#decklist-form-close-btn')).toHaveText('← Back to Tournament');

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/decklists/new\\?tournament=${TOURNAMENT_ID}$`));
  await expect(page.locator('#decklist-game')).toHaveValue('ygo-tcg');
  await expect(page.locator('#decklist-builder-context')).toContainText('Friday Locals');

  await page.fill('#decklist-name', 'Locals Deck');
  await page.getByRole('button', { name: 'Import Text List' }).click();
  await expect(page.locator('#deck-count-main')).toHaveText('40');
  await page.locator('#decklist-submit-btn').click();

  await expect(page).toHaveURL(new RegExp(`/tournaments/${TOURNAMENT_ID}$`));
  await expect(page.locator('#notification-toast-stack')).toContainText('Deck saved. You can join now.');
  expect(joinCalls).toBe(0);

  // The next join offers the new deck.
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Join', exact: true }).first().click();
  await expect.poll(() => dialogs.joinPrompts.length).toBe(1);
  expect(dialogs.joinPrompts[0]).toContain('Locals Deck');
  expect(joinCalls).toBe(0);
});

test('Back from a builder opened for a tournament returns to that tournament', async ({ page }) => {
  await setup(page);
  handleDialogs(page);

  await page.goto(`/decklists/new?tournament=${TOURNAMENT_ID}`);
  await expect(page.locator('#decklist-builder-context')).toContainText('Friday Locals');
  await page.locator('#decklist-form-close-btn').click();

  await expect(page).toHaveURL(new RegExp(`/tournaments/${TOURNAMENT_ID}$`));
  await expect(page.locator('#tournament-detail')).toBeVisible();
});

test('a bad tournament id falls back to a plain new deck', async ({ page }) => {
  await setup(page);
  handleDialogs(page);

  await page.goto('/decklists/new?tournament=507f1f77bcf86cd7994390aa');
  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(page.locator('#decklist-builder-context')).toBeHidden();
  await expect(page.locator('#decklist-form-close-btn')).toHaveText('← Back to My Decklists');
  await expect(page.locator('#decklist-game')).toHaveValue('');
});

test('builder fits a phone width with no horizontal scroll', async ({ page }) => {
  await setup(page);
  handleDialogs(page);
  await page.setViewportSize({ width: 375, height: 800 });

  await page.goto('/decklists/new');
  await expect(builderHeading(page)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
