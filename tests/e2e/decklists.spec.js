// Verifies deep-link load of decklists with authenticated localStorage state.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

test('decklists page loads and shows saved decklists', async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('token', 'playwright-token');
  });

  await page.goto('/decklists');
  await expect(page).toHaveURL(/\/decklists$/);
  await expect(page.getByRole('heading', { name: 'My Decklists' })).toBeVisible();
  await expect(page.getByText('Starter Deck')).toBeVisible();
});
