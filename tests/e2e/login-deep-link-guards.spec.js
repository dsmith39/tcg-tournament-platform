// QA guards for the login deep link return (board D010, PR #27). The saved
// return path must never leave the site, must not outlive the login page or a
// logout, must survive a failed attempt, and must not open admin to a player.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

const ORIGIN = 'http://127.0.0.1:3200';

async function setupLoggedOut(page) {
  const state = await installMockApi(page);

  // Registered after installMockApi, so it wins: nobody is logged in on load.
  await page.route('**/api/auth/me**', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No token provided' })
    });
  });

  page.on('dialog', (dialog) => dialog.accept());
  return state;
}

async function logIn(page) {
  await page.locator('#login-email').fill('pw@example.com');
  await page.locator('#login-password').fill('correct horse battery');
  await page.locator('#login-form button.btn').click();
}

function expectSameOrigin(page) {
  expect(new URL(page.url()).origin).toBe(ORIGIN);
}

test('a protocol relative path never becomes a return target', async ({ page }) => {
  await setupLoggedOut(page);

  await page.goto(`${ORIGIN}//evil.example/decklists/new`);
  expectSameOrigin(page);

  // No reload from here on: the return path lives in memory, so a page.goto
  // would wipe it and hide the bug this guards against.
  if (await page.locator('#landing').evaluate((el) => el.classList.contains('active'))) {
    await page.locator('#landing').getByRole('button', { name: 'Login' }).first().click();
  }
  await logIn(page);

  await expect(page).toHaveURL(`${ORIGIN}/dashboard`);
  expectSameOrigin(page);
});

test('an off site value in the query stays a query on this site', async ({ page }) => {
  await setupLoggedOut(page);

  await page.goto('/decklists/new?next=//evil.example&redirect=https://evil.example/');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await logIn(page);

  await expect(page).toHaveURL(/\/decklists\/new\?next=/);
  expectSameOrigin(page);
  await expect(page.locator('#decklist-builder')).toHaveClass(/active/);
});

test('encoded slashes in an edit link stay on this site', async ({ page }) => {
  await setupLoggedOut(page);

  await page.goto('/decklists/%2F%2Fevil.example/edit');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await logIn(page);

  // Not the player's deck, so it lands on My Decklists, on this site.
  await expect(page).toHaveURL(`${ORIGIN}/decklists`);
  await expect(page.locator('#decklists')).toHaveClass(/active/);
});

test('logout and a later login do not revive a used return path', async ({ page }) => {
  await setupLoggedOut(page);

  await page.goto('/decklists/new');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await logIn(page);
  await expect(page).toHaveURL(/\/decklists\/new$/);

  await page.locator('#logout-btn').click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  // Through the UI, not page.goto: a reload would clear the in memory path.
  await page.locator('#landing').getByRole('button', { name: 'Login' }).first().click();
  await logIn(page);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('#dashboard')).toHaveClass(/active/);
});

test('a wrong password keeps the return path for the next try', async ({ page }) => {
  await setupLoggedOut(page);

  let attempts = 0;
  await page.route('**/api/auth/login**', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid credentials' })
      });
      return;
    }
    await route.fallback();
  });

  await page.goto('/tournaments/create');
  await expect(page).toHaveURL(/\/auth\/login$/);

  await logIn(page);
  await expect(page.locator('#login-error')).toHaveText('Invalid credentials');
  await expect(page).toHaveURL(/\/auth\/login$/);

  await logIn(page);
  await expect(page).toHaveURL(/\/tournaments\/create$/);
  await expect(page.locator('#create')).toHaveClass(/active/);
});

test('a player sent back to /admin lands on the dashboard, not admin', async ({ page }) => {
  await setupLoggedOut(page);

  await page.goto('/admin');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await logIn(page);

  await expect(page.locator('#dashboard')).toHaveClass(/active/);
  await expect(page.locator('#admin')).not.toHaveClass(/active/);
  await expect(page.locator('#admin-btn')).toBeHidden();
  await expect(page).toHaveURL(/\/dashboard$/);
});
