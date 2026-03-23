const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

test('auth page switches between login and register modes', async ({ page }) => {
  await installMockApi(page);

  await page.goto('/auth/login');
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Sign Up' })).toBeVisible();
  await expect(page.getByPlaceholder('Your username')).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/signup$/);

  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/login$/);
});
