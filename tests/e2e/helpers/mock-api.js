/*
 * Browser-side API mocking harness for Playwright E2E tests.
 *
 * Purpose:
 * - Simulate backend responses deterministically.
 * - Keep tests fast and independent from external services.
 * - Allow scenario mutation through returned state object.
 */
async function readJsonBody(route) {
  let body = null;
  try {
    body = route.request().postDataJSON();
  } catch {
    const raw = route.request().postData();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
  }

  if (body && typeof body === 'object') {
    return body;
  }

  return {};
}

// Unified JSON responder helper so route handlers stay concise.
function json(route, status, payload, headers = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(payload)
  });
}

async function installMockApi(page, options = {}) {
  // Mutable in-memory state that tests can tweak for scenario-specific behavior.
  const state = {
    user: {
      id: 'u1',
      username: 'playwright-user',
      email: 'pw@example.com'
    },
    decklists: [
      {
        _id: '507f1f77bcf86cd799439011',
        name: 'Starter Deck',
        game: 'ygo-tcg',
        mainDeck: 'Blue-Eyes White Dragon',
        extraDeck: '',
        sideDeck: '',
        archetype: 'Blue-Eyes',
        notes: '',
        isPublic: true,
        owner: { username: 'playwright-user' }
      }
    ],
    tournaments: [
      {
        _id: '507f1f77bcf86cd799439021',
        name: 'Weekend Swiss',
        game: 'ygo-tcg',
        format: 'swiss',
        maxPlayers: 8,
        currentPlayers: 1,
        status: 'in-progress',
        createdBy: { _id: 'u1', username: 'playwright-user' },
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
      }
    ]
  };

  // -----------------------
  // Auth endpoint stubs
  // -----------------------
  await page.route('**/api/auth/me**', async (route) => {
    await json(route, 200, state.user);
  });

  await page.route('**/api/auth/refresh**', async (route) => {
    await json(route, 200, { ok: true });
  });

  await page.route('**/api/auth/logout**', async (route) => {
    await json(route, 200, { ok: true });
  });

  await page.route('**/api/auth/logout-all**', async (route) => {
    await json(route, 200, { ok: true });
  });

  await page.route('**/api/auth/login**', async (route) => {
    const body = await readJsonBody(route);
    if (!body.email || !body.password) {
      await json(route, 400, {
        error: 'Validation failed',
        details: [{ path: 'email', message: 'Email is required' }]
      });
      return;
    }

    await json(route, 200, { user: state.user });
  });

  await page.route('**/api/auth/register**', async (route) => {
    const body = await readJsonBody(route);
    if (!body.username || String(body.username).trim().length < 3) {
      await json(route, 400, {
        error: 'Validation failed',
        details: [{ path: 'username', message: 'String must contain at least 3 character(s)' }]
      });
      return;
    }

    if (!body.email || !body.password) {
      await json(route, 400, {
        error: 'Validation failed',
        details: [{ path: 'email', message: 'Email is required' }]
      });
      return;
    }

    await json(route, 201, { user: state.user });
  });

  // -----------------------
  // Decklist endpoint stubs
  // -----------------------
  await page.route('**/api/decklists/recent', async (route) => {
    await json(route, 200, state.decklists);
  });

  await page.route('**/api/decklists', async (route) => {
    const method = route.request().method();

    if (method === 'GET') {
      await json(route, 200, state.decklists);
      return;
    }

    if (method === 'POST') {
      if (options.rateLimitDecklistCreateSeconds) {
        await json(route, 429, {
          error: 'Too many write requests. Please slow down and try again shortly.',
          details: [{ path: 'rateLimit', message: 'Too many write requests. Please slow down and try again shortly.' }]
        }, {
          'retry-after': String(options.rateLimitDecklistCreateSeconds)
        });
        return;
      }

      const body = await readJsonBody(route);
      const created = {
        _id: `deck-${state.decklists.length + 1}`,
        owner: { username: 'playwright-user' },
        ...body
      };
      state.decklists.unshift(created);
      await json(route, 201, created);
      return;
    }

    await route.fallback();
  });

  await page.route('**/api/decklists/*', async (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const deckId = url.pathname.split('/').pop();
    const index = state.decklists.findIndex((deck) => deck._id === deckId || deck.id === deckId);

    if (index < 0) {
      await json(route, 404, { error: 'Decklist not found' });
      return;
    }

    if (method === 'PATCH') {
      const body = await readJsonBody(route);
      state.decklists[index] = {
        ...state.decklists[index],
        ...body
      };
      await json(route, 200, state.decklists[index]);
      return;
    }

    if (method === 'DELETE') {
      state.decklists.splice(index, 1);
      await json(route, 200, { ok: true });
      return;
    }

    await route.fallback();
  });

  // -----------------------
  // Tournament endpoint stubs
  // -----------------------
  await page.route('**/api/tournaments', async (route) => {
    const method = route.request().method();

    if (method === 'GET') {
      await json(route, 200, state.tournaments);
      return;
    }

    if (method === 'POST') {
      const body = await readJsonBody(route);
      const created = {
        _id: `tournament-${state.tournaments.length + 1}`,
        createdBy: { _id: 'u1', username: 'playwright-user' },
        currentPlayers: 0,
        status: 'registration',
        rounds: [],
        ...body
      };
      state.tournaments.unshift(created);
      await json(route, 201, created);
      return;
    }

    await route.fallback();
  });

  await page.route(/\/api\/tournaments\/.+/, async (route) => {
    const method = route.request().method();
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;

    if (method === 'GET') {
      const id = path.split('/').pop();
      const tournament = state.tournaments.find((item) => item._id === id || item.id === id);
      if (!tournament) {
        await json(route, 404, { error: 'Tournament not found' });
        return;
      }
      await json(route, 200, tournament);
      return;
    }

    const joinMatch = path.match(/\/api\/tournaments\/([^/]+)\/join$/);
    if (method === 'PATCH' && joinMatch) {
      const tournamentId = joinMatch[1];
      const body = await readJsonBody(route);
      const tournament = state.tournaments.find((item) => item._id === tournamentId || item.id === tournamentId);

      if (!tournament) {
        await json(route, 404, { error: 'Tournament not found' });
        return;
      }

      if (!body.decklistId) {
        await json(route, 400, {
          error: 'Validation failed',
          details: [{ path: 'decklistId', message: 'Decklist is required' }]
        });
        return;
      }

      tournament.currentPlayers += 1;
      await json(route, 200, tournament);
      return;
    }

    const actionMatch = path.match(/\/api\/tournaments\/([^/]+)\/(leave|checkin|start)$/);
    if ((method === 'PATCH' || method === 'POST') && actionMatch) {
      const tournamentId = actionMatch[1];
      const tournament = state.tournaments.find((item) => item._id === tournamentId || item.id === tournamentId);
      if (!tournament) {
        await json(route, 404, { error: 'Tournament not found' });
        return;
      }

      if (actionMatch[2] === 'leave') {
        tournament.currentPlayers = Math.max(0, tournament.currentPlayers - 1);
      }

      if (actionMatch[2] === 'start') {
        tournament.status = 'in-progress';
      }

      await json(route, 200, tournament);
      return;
    }

    const reportMatch = path.match(/\/api\/tournaments\/([^/]+)\/matches\/([^/]+)\/report$/);
    if (method === 'PATCH' && reportMatch) {
      const tournamentId = reportMatch[1];
      const matchId = reportMatch[2];
      const body = await readJsonBody(route);
      if (!body.result) {
        await json(route, 400, {
          error: 'Validation failed',
          details: [{ path: 'result', message: 'Result is required' }]
        });
        return;
      }

      const tournament = state.tournaments.find((item) => item._id === tournamentId || item.id === tournamentId);
      const targetMatch = tournament?.rounds?.flatMap((round) => round.matches || []).find((match) => match._id === matchId || match.id === matchId);

      if (targetMatch) {
        targetMatch.result = body.result;
        targetMatch.resultStatus = 'reported';
      }

      await json(route, 200, { ok: true });
      return;
    }

    const resolveMatch = path.match(/\/api\/tournaments\/([^/]+)\/matches\/([^/]+)\/resolve$/);
    if (method === 'PATCH' && resolveMatch) {
      const tournamentId = resolveMatch[1];
      const matchId = resolveMatch[2];
      const body = await readJsonBody(route);
      if (typeof body.note === 'string' && body.note.length > 500) {
        await json(route, 400, {
          error: 'Validation failed',
          details: [{ path: 'note', message: 'String must contain at most 500 character(s)' }]
        });
        return;
      }

      const tournament = state.tournaments.find((item) => item._id === tournamentId || item.id === tournamentId);
      const targetMatch = tournament?.rounds?.flatMap((round) => round.matches || []).find((match) => match._id === matchId || match.id === matchId);

      if (targetMatch) {
        targetMatch.result = body.result || targetMatch.result;
        targetMatch.resultStatus = 'confirmed';
      }

      await json(route, 200, { ok: true });
      return;
    }

    await route.fallback();
  });

  // Block websocket transport in tests to avoid noisy retries.
  await page.route('**/api/socket.io/**', async (route) => {
    await route.abort();
  });

  await page.route('**/api/v7/cardinfo.php**', async (route) => {
    await json(route, 200, {
      data: [
        {
          id: 89631139,
          name: 'Blue-Eyes White Dragon',
          type: 'Normal Monster',
          attribute: 'LIGHT',
          atk: 3000,
          def: 2500
        }
      ]
    });
  });

  return state;
}

module.exports = {
  installMockApi
};
