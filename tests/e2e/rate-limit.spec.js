// Confirms unauthenticated decklist route enforcement by redirecting to login.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

test('unauthenticated decklists route redirects to login', async ({ page }) => {
  await installMockApi(page);

  await page.route('**/api/auth/me**', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No token provided' })
    });
  });

  await page.goto('/decklists');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
});
