// QA follow ups to deck-builder-page.spec.js (board D008 review, 2026-10-26).
// Unsaved change guards on the paths that spec doesn't walk: browser back from a
// builder opened by a join prompt and from an edit, a nav link to another
// section, closing the tab, and edits typed while saved cards are still loading.
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


test('browser back from a dirty builder opened by a join prompt: Cancel keeps it, OK returns to the tournament', async ({ page }) => {
  const state = await setup(page);
  state.decklists = [];
  const dialogs = handleDialogs(page, [false, true]);
  await page.goto(`/tournaments/${TOURNAMENT_ID}`);
  await page.getByRole('button', { name: 'Join Tournament' }).click();
  await expect(page.locator('#decklist-builder-context')).toContainText('Friday Locals');
  await page.fill('#decklist-name', 'Keep Me');
  await page.goBack();
  await expect.poll(() => dialogs.confirms.length).toBe(1);
  expect(page.url()).toContain(`/decklists/new?tournament=${TOURNAMENT_ID}`);
  await expect(page.locator('#decklist-name')).toHaveValue('Keep Me');
  await expect(page.locator('#decklist-form-close-btn')).toHaveText('← Back to Tournament');
  await page.goBack();
  await expect.poll(() => dialogs.confirms.length).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/tournaments/${TOURNAMENT_ID}$`));
  await expect(page.locator('#tournament-detail')).toBeVisible();
});

test('browser back from a dirty edit: Cancel keeps the edit URL and the loaded cards', async ({ page }) => {
  await setup(page);
  const dialogs = handleDialogs(page, [false, false, true]);
  await page.goto('/decklists');
  await page.locator('.decklist-card, .decklist-grid > *').filter({ hasText: 'Legal Fillers' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#deck-count-main')).toHaveText('40');
  await page.fill('#decklist-notes', 'changed');
  await page.goBack();
  await expect.poll(() => dialogs.confirms.length).toBe(1);
  await page.goBack();
  await expect.poll(() => dialogs.confirms.length).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/decklists/${LEGAL_DECK_ID}/edit$`));
  await expect(page.locator('#deck-count-main')).toHaveText('40');
  await expect(page.locator('#decklist-notes')).toHaveValue('changed');
  await page.goBack();
  await expect.poll(() => dialogs.confirms.length).toBe(3);
  await expect(page).toHaveURL(/\/decklists$/);
});

test('a nav link to another section with unsaved work asks, and Cancel stays', async ({ page }) => {
  await setup(page);
  const dialogs = handleDialogs(page, [false]);
  await page.goto('/decklists/new');
  await page.fill('#decklist-name', 'Stay');
  await page.locator('#card-lookup-btn').click();
  expect(dialogs.confirms).toHaveLength(1);
  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(page.locator('#decklist-builder')).toBeVisible();
  await expect(page.locator('#decklist-name')).toHaveValue('Stay');
});

test('closing the tab with unsaved work asks the browser to warn', async ({ page }) => {
  await setup(page);
  let sawBeforeUnload = false;
  page.on('dialog', async (d) => { if (d.type() === 'beforeunload') sawBeforeUnload = true; await d.dismiss(); });
  await page.goto('/decklists/new');
  await page.fill('#decklist-name', 'Unsaved');
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => sawBeforeUnload).toBe(true);
});

test('a change typed while saved cards are still loading still counts as unsaved', async ({ page }) => {
  await setup(page);
  // Slow card lookups so hydration takes a while.
  await page.route('**/api/v7/cardinfo.php**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.searchParams.get('name') || url.searchParams.get('fname') || 'X';
    await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 1, name, type: 'Normal Monster' }] }) });
  });
  const dialogs = handleDialogs(page, [false]);
  await page.goto('/decklists');
  await page.goto(`/decklists/${LEGAL_DECK_ID}/edit`);
  await expect(page.locator('#decklist-name')).toHaveValue('Legal Fillers');
  await page.fill('#decklist-name', 'Renamed While Loading');
  await expect(page.locator('#deck-count-main')).toHaveText('40', { timeout: 15000 });
  await page.locator('#decklist-form-close-btn').click();
  expect(dialogs.confirms).toHaveLength(1);
  await expect(page.locator('#decklist-name')).toHaveValue('Renamed While Loading');
});
