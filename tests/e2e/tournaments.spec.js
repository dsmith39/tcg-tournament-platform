// Validates anonymous landing navigation into tournament detail pages.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

test('public landing can navigate to tournament details', async ({ page }) => {
  const state = await installMockApi(page);

  await page.addInitScript(() => {
    window.localStorage.removeItem('token');
  });

  const tournamentId = '507f1f77bcf86cd799439021';
  const tournament = {
    _id: tournamentId,
    name: 'Weekend Swiss',
    game: 'ygo-tcg',
    format: 'swiss',
    maxPlayers: 8,
    currentPlayers: 2,
    status: 'registration',
    createdBy: { _id: 'u1', username: 'playwright-user', email: 'pw@example.com' },
    players: [
      { _id: 'u1', username: 'playwright-user', email: 'pw@example.com' },
      { _id: 'u2', username: 'test-opponent', email: 'opponent@example.com' }
    ],
    registrations: []
  };

  state.tournaments = [tournament];

  await page.route('**/api/auth/me**', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No token provided' })
    });
  });

  await page.route(`**/api/tournaments/${tournamentId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tournament)
    });
  });

  await page.goto('/');
  const landingCard = page.locator('.tournament-item').filter({ hasText: 'Weekend Swiss' }).first();
  await landingCard.getByRole('button', { name: 'View Details' }).click();

  await expect(page).toHaveURL(new RegExp(`/tournaments/${tournamentId}$`));
  await expect(page.locator('.tournament-title', { hasText: 'Weekend Swiss' })).toBeVisible();
});
