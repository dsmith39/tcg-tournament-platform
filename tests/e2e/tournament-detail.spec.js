const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

test('tournament detail renders standings/round content for deep link', async ({ page }) => {
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
    currentPlayers: 1,
    status: 'active',
    createdBy: { _id: 'u1', username: 'playwright-user' },
    players: [
      { _id: 'u1', username: 'playwright-user', email: 'pw@example.com' },
      { _id: 'u2', username: 'test-opponent', email: 'opponent@example.com' }
    ],
    registrations: [],
    rounds: [
      {
        _id: '507f1f77bcf86cd799439031',
        number: 1,
        status: 'active',
        matches: [
          {
            _id: '507f1f77bcf86cd799439041',
            tableNumber: 1,
            result: null,
            resultStatus: 'pending',
            player1: { _id: 'u1', username: 'playwright-user' },
            player2: { _id: 'u2', username: 'test-opponent' }
          }
        ]
      }
    ]
  };
  state.tournaments = [tournament, ...state.tournaments.filter((item) => item._id !== tournamentId)];

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

  await page.goto(`/tournaments/${tournamentId}`);

  await expect(page).toHaveURL(new RegExp(`/tournaments/${tournamentId}$`));
  await expect(page.locator('.tournament-title', { hasText: 'Weekend Swiss' })).toBeVisible();
  await expect(page.getByText('Round 1').first()).toBeVisible();
  await expect(page.getByText('playwright-user').first()).toBeVisible();
  await expect(page.getByText('test-opponent').first()).toBeVisible();
});
