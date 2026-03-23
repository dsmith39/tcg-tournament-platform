// Ensures browser URL + in-app back navigation stay consistent for deep links.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

test('unauthenticated UI back keeps tournament detail URL', async ({ page }) => {
  const state = await installMockApi(page);

  await page.addInitScript(() => {
    window.localStorage.removeItem('token');
  });

  const tournamentId = '507f1f77bcf86cd799439021';
  const creatorId = 'u1';
  const playerId = 'u2';

  const tournament = {
    _id: tournamentId,
    name: 'Weekend Swiss',
    game: 'ygo-tcg',
    format: 'swiss',
    maxPlayers: 8,
    currentPlayers: 2,
    status: 'registration',
    createdBy: { _id: creatorId, username: 'playwright-user', email: 'pw@example.com' },
    players: [
      { _id: creatorId, username: 'playwright-user', email: 'pw@example.com' },
      { _id: playerId, username: 'test-opponent', email: 'opponent@example.com' }
    ],
    registrations: []
  };

  state.tournaments = [tournament];

  // Simulate logged-out session to verify public-view navigation behavior.
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

  await page.route(`**/api/users/${playerId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        _id: playerId,
        username: 'test-opponent',
        email: 'opponent@example.com',
        bio: 'Test profile',
        createdAt: new Date().toISOString(),
        stats: {
          createdCount: 0,
          joinedCount: 1,
          wins: 0,
          losses: 0,
          draws: 0,
          winRate: 0,
          championships: 0
        },
        recentCreatedTournaments: [],
        recentJoinedTournaments: [
          {
            _id: tournamentId,
            name: 'Weekend Swiss',
            format: 'swiss',
            status: 'registration',
            createdAt: new Date().toISOString()
          }
        ],
        recentMatches: []
      })
    });
  });

  await page.goto('/');

  const landingCard = page.locator('.tournament-item').filter({ hasText: 'Weekend Swiss' }).first();
  await expect(landingCard).toBeVisible();
  await landingCard.getByRole('button', { name: 'View Details' }).click();
  await expect(page).toHaveURL(new RegExp(`/tournaments/${tournamentId}$`));

  await page.locator('button.user-link', { hasText: 'test-opponent' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/users/${playerId}$`));

  await page.locator('section.active').getByRole('button', { name: '← Back' }).click();
  await expect(page).toHaveURL(new RegExp(`/tournaments/${tournamentId}$`));
});
