// Logged out deep links to gated pages go to login, and logging in or signing
// up returns to the page that was asked for (board D010). Before the fix,
// login() and signup() called an undefined helper: the player always landed on
// /dashboard and "Network error" text was left behind in the hidden auth form.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

const STARTER_DECK_ID = '507f1f77bcf86cd799439011';
const TOURNAMENT_ID = '507f1f77bcf86cd799439021';

async function setupLoggedOut(page) {
  const state = await installMockApi(page);

  // Echo whatever card is asked for, so saved decks hydrate without the network.
  await page.route('**/api/v7/cardinfo.php**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.searchParams.get('name') || url.searchParams.get('fname') || 'Blue-Eyes White Dragon';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 1, name, type: 'Normal Monster' }] })
    });
  });

  // Registered after installMockApi, so it wins: the session check says
  // "not logged in" and only the login or signup call logs the player in.
  await page.route('**/api/auth/me**', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No token provided' })
    });
  });

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());

  return { state, pageErrors };
}

async function logIn(page) {
  await page.locator('#login-email').fill('pw@example.com');
  await page.locator('#login-password').fill('correct horse battery');
  await page.locator('#login-form button.btn').click();
}

async function signUp(page) {
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.locator('#signup-username').fill('playwright-user');
  await page.locator('#signup-email').fill('pw@example.com');
  await page.locator('#signup-password').fill('correct horse battery');
  await page.locator('#signup-form button.btn').click();
}

async function expectNoAuthErrors(page, pageErrors) {
  await expect(page.locator('#login-error')).toHaveText('');
  await expect(page.locator('#signup-error')).toHaveText('');
  expect(pageErrors).toEqual([]);
}

const builderHeading = (page) => page.locator('#decklist-builder h1');

test('login from a /decklists/new deep link returns to the builder', async ({ page }) => {
  const { pageErrors } = await setupLoggedOut(page);

  await page.goto('/decklists/new');
  await expect(page).toHaveURL(/\/auth\/login$/);

  await logIn(page);

  await expect(page).toHaveURL(/\/decklists\/new$/);
  await expect(builderHeading(page)).toHaveText('Create Decklist');
  await expect(page.locator('#decklist-form')).toBeVisible();
  await expect(page.locator('#deck-builder-btn')).toBeVisible();
  await expectNoAuthErrors(page, pageErrors);
});

test('login from an edit deep link returns to that deck in the builder', async ({ page }) => {
  const { pageErrors } = await setupLoggedOut(page);

  await page.goto(`/decklists/${STARTER_DECK_ID}/edit`);
  await expect(page).toHaveURL(/\/auth\/login$/);

  await logIn(page);

  await expect(page).toHaveURL(new RegExp(`/decklists/${STARTER_DECK_ID}/edit$`));
  await expect(builderHeading(page)).toHaveText('Edit Decklist');
  await expect(page.locator('#decklist-name')).toHaveValue('Starter Deck');
  await expectNoAuthErrors(page, pageErrors);
});

test('signup from a join builder deep link keeps the tournament query', async ({ page }) => {
  const { pageErrors } = await setupLoggedOut(page);

  await page.goto(`/decklists/new?tournament=${TOURNAMENT_ID}`);
  await expect(page).toHaveURL(/\/auth\/login$/);

  await signUp(page);

  await expect(page).toHaveURL(new RegExp(`/decklists/new\\?tournament=${TOURNAMENT_ID}$`));
  await expect(builderHeading(page)).toHaveText('Create Decklist');
  await expect(page.locator('#decklist-builder-context')).toBeVisible();
  await expectNoAuthErrors(page, pageErrors);
});

test('login from /tournaments/create and /decklists returns to each', async ({ page }) => {
  const { pageErrors } = await setupLoggedOut(page);

  await page.goto('/tournaments/create');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await logIn(page);
  await expect(page).toHaveURL(/\/tournaments\/create$/);
  await expect(page.locator('#create')).toHaveClass(/active/);
  await expectNoAuthErrors(page, pageErrors);

  await page.locator('#logout-btn').click();
  await page.goto('/decklists');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await logIn(page);
  await expect(page).toHaveURL(/\/decklists$/);
  await expect(page.locator('#decklists')).toHaveClass(/active/);
  await expectNoAuthErrors(page, pageErrors);
});

test('a plain login still lands on the dashboard', async ({ page }) => {
  const { pageErrors } = await setupLoggedOut(page);

  await page.goto('/auth/login');
  await logIn(page);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('#dashboard')).toHaveClass(/active/);
  await expectNoAuthErrors(page, pageErrors);
});

test('leaving the login page forgets the deep link', async ({ page }) => {
  const { pageErrors } = await setupLoggedOut(page);

  await page.goto('/decklists/new');
  await expect(page).toHaveURL(/\/auth\/login$/);

  // Walk away to the landing page, then come back to log in on purpose.
  await page.getByRole('button', { name: 'Back to Landing' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('#landing').getByRole('button', { name: 'Login' }).first().click();
  await expect(page).toHaveURL(/\/auth\/login$/);

  await logIn(page);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expectNoAuthErrors(page, pageErrors);
});
