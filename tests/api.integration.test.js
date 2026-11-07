/*
 * End-to-end API integration tests (Node test runner + Supertest + a local
 * dynalite instance standing in for DynamoDB).
 *
 * Coverage goals:
 * - Auth/session behavior
 * - Decklist CRUD
 * - Tournament creation/join flow
 * - Validation failures and rate-limit behavior
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dynalite = require('dynalite');

const { registerApi } = require('../server/api-server');
const { resetRateLimiters } = require('../server/security');

let app;
let dynaliteServer;

// Catalog rows for the D012 tests. Names, passcodes, types and image ids are
// YGOPRODeck's (checked against the Yu-Gi-Oh team's cached YGOPRODeck responses,
// 2026-11-07). Alternate art ids live only in `images`, exactly as the import
// stores them. The two "QA Twin" rows are made up on purpose: their names
// normalize to the same key, so a normalized lookup has to refuse them.
function seedCard(fields) {
  return {
    description: '',
    atk: null,
    def: null,
    level: null,
    race: null,
    attribute: null,
    archetype: null,
    scale: null,
    linkval: null,
    linkmarkers: [],
    banlistInfo: null,
    sets: [],
    prices: null,
    ...fields,
    images: fields.images.map((imageId) => ({ imageId }))
  };
}

const UNRESOLVED_CARDS_SEED = [
  seedCard({
    cardId: 46986414, name: 'Dark Magician', type: 'Normal Monster', frameType: 'normal',
    race: 'Spellcaster', attribute: 'DARK', level: 7, atk: 2500, def: 2100,
    images: [46986414, 46986415, 46986416, 46986417, 46986418, 46986419, 36996508, 46986420, 46986421]
  }),
  seedCard({
    cardId: 14558127, name: 'Ash Blossom & Joyous Spring', type: 'Tuner Monster', frameType: 'effect',
    race: 'Zombie', attribute: 'FIRE', level: 3, atk: 0, def: 1800,
    images: [14558127, 14558128]
  }),
  seedCard({
    cardId: 23434538, name: 'Maxx "C"', type: 'Effect Monster', frameType: 'effect',
    race: 'Insect', attribute: 'EARTH', level: 2, atk: 500, def: 200,
    images: [23434538]
  }),
  seedCard({
    cardId: 18144507, name: "Harpie's Feather Duster", type: 'Spell Card', frameType: 'spell',
    race: 'Normal', images: [18144507, 18144506]
  }),
  seedCard({
    cardId: 900000001, name: 'QA Twin "Echo"', type: 'Effect Monster', frameType: 'effect',
    images: [900000001]
  }),
  seedCard({
    cardId: 900000002, name: 'QA Twin Echo', type: 'Effect Monster', frameType: 'effect',
    images: [900000002]
  })
];

async function registerUser(client, { username, email, password }) {
  // Shared helper keeps auth setup compact across test cases.
  const response = await client
    .post('/api/auth/register')
    .send({ username, email, password });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.username, username);

  return response.body;
}

test.before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.ADMIN_EMAILS = 'admin@example.com';

  // A local dynalite instance stands in for DynamoDB; server/dynamo.js
  // points at it whenever DYNAMODB_ENDPOINT is set, mirroring the old
  // NODE_ENV=test -> :memory: SQLite behavior.
  dynaliteServer = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise((resolve, reject) => {
    dynaliteServer.listen(0, (err) => (err ? reject(err) : resolve()));
  });
  process.env.DYNAMODB_ENDPOINT = `http://localhost:${dynaliteServer.address().port}`;

  const { resetTables } = require('../server/dynamo');
  await resetTables();

  app = express();
  // No trust proxy override here: registerApi sets the same one hop policy the
  // deployed Lambda runs with, so the X-Forwarded-For tests below exercise it.
  registerApi(app);

  // Seed the in-memory card catalog (NODE_ENV=test -> :memory: SQLite, see
  // card-database/src/db.js) with one fixture card for the /api/v7 tests below.
  const cardsRepo = require('../card-database/src/models/cards');
  cardsRepo.upsertMany([{
    cardId: 89631139,
    name: 'Blue-Eyes White Dragon',
    type: 'Normal Monster',
    frameType: 'normal',
    description: 'This legendary dragon is a powerful engine of destruction.',
    atk: 3000,
    def: 2500,
    level: 8,
    race: 'Dragon',
    attribute: 'LIGHT',
    archetype: 'Blue-Eyes',
    scale: null,
    linkval: null,
    linkmarkers: [],
    banlistInfo: null,
    images: [{ imageId: 89631139 }],
    sets: [],
    prices: null
  }]);

  // Cards for the "unresolved cards" tests (board D012). Seeded here, before any
  // request, because the fix builds its alternate art and normalized name maps
  // once per process; seeding later could land after the maps are built.
  cardsRepo.upsertMany(UNRESOLVED_CARDS_SEED);
});

test.after(async () => {
  if (dynaliteServer) {
    await new Promise((resolve) => dynaliteServer.close(resolve));
  }
});

test.beforeEach(async () => {
  // Fresh tables per test so each test starts with a clean data slate.
  const { resetTables } = require('../server/dynamo');
  await resetTables();

  // Reset in-memory rate limit counters so IP-keyed auth buckets from earlier tests
  // don't carry over and cause unexpected 429 responses in unrelated tests.
  resetRateLimiters();
});

test('auth flow: register and fetch current user', async () => {
  const client = request.agent(app);

  const { user } = await registerUser(client, {
    username: 'alpha',
    email: 'alpha@example.com',
    password: 'secret123'
  });

  assert.ok(user.id);

  const meResponse = await client.get('/api/auth/me');

  assert.equal(meResponse.status, 200);
  assert.equal(meResponse.body.username, 'alpha');
  assert.equal(meResponse.body.email, 'alpha@example.com');
});

test('auth flow: logout-all invalidates the current session', async () => {
  const client = request.agent(app);

  await registerUser(client, {
    username: 'sessionowner',
    email: 'sessionowner@example.com',
    password: 'secret123'
  });

  const logoutAllResponse = await client.post('/api/auth/logout-all');
  assert.equal(logoutAllResponse.status, 200);

  const meResponse = await client.get('/api/auth/me');
  assert.equal(meResponse.status, 401);
});

test('decklist flow: create, update, and delete', async () => {
  const client = request.agent(app);

  await registerUser(client, {
    username: 'deckpilot',
    email: 'deckpilot@example.com',
    password: 'secret123'
  });

  const createResponse = await client
    .post('/api/decklists')
    .send({
      name: 'Sky Striker Core',
      game: 'ygo-tcg',
      mainDeck: '3x Raye',
      extraDeck: '1x Kagari',
      sideDeck: '',
      archetype: 'Sky Striker',
      notes: 'Testing list',
      isPublic: true
    });

  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.body.name, 'Sky Striker Core');

  const deckId = createResponse.body._id;

  const patchResponse = await client
    .patch(`/api/decklists/${deckId}`)
    .send({ name: 'Sky Striker Core v2', notes: 'Updated note' });

  assert.equal(patchResponse.status, 200);
  assert.equal(patchResponse.body.name, 'Sky Striker Core v2');

  const deleteResponse = await client.delete(`/api/decklists/${deckId}`);

  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteResponse.body.message, 'Decklist deleted');
});

test('decklist flow: duel links decks keep skills, other games drop them', async () => {
  const client = request.agent(app);

  await registerUser(client, {
    username: 'skillpilot',
    email: 'skillpilot@example.com',
    password: 'secret123'
  });

  // Blank lines, duplicates (case-insensitively), and anything past the 3-skill
  // cap are dropped rather than rejected, so a sloppy paste still saves.
  const duelLinksResponse = await client
    .post('/api/decklists')
    .send({
      name: 'Duel Links Control',
      game: 'duel-links',
      mainDeck: '3x Sphere Kuriboh',
      skills: '  Balance  \n\nbalance\nDestiny Draw\nSealed Tombs\nRestart\n'
    });

  assert.equal(duelLinksResponse.status, 201);
  assert.equal(duelLinksResponse.body.skills, 'Balance\nDestiny Draw\nSealed Tombs');

  // Skills are a Duel Links concept, so they never persist on another game.
  const tcgResponse = await client
    .post('/api/decklists')
    .send({
      name: 'TCG List',
      game: 'ygo-tcg',
      mainDeck: '3x Raye',
      skills: 'Balance'
    });

  assert.equal(tcgResponse.status, 201);
  assert.equal(tcgResponse.body.skills, '');

  // Editing just the skills leaves them in place...
  const patchSkillsResponse = await client
    .patch(`/api/decklists/${duelLinksResponse.body._id}`)
    .send({ skills: 'Peak Performance' });

  assert.equal(patchSkillsResponse.status, 200);
  assert.equal(patchSkillsResponse.body.skills, 'Peak Performance');

  // ...but switching the deck off Duel Links clears them, even when the same
  // request does not mention skills at all.
  const patchGameResponse = await client
    .patch(`/api/decklists/${duelLinksResponse.body._id}`)
    .send({ game: 'master-duel' });

  assert.equal(patchGameResponse.status, 200);
  assert.equal(patchGameResponse.body.game, 'master-duel');
  assert.equal(patchGameResponse.body.skills, '');
});

test('duel links skills: catalog search is public and ranks exact names first', async () => {
  const publicClient = request(app);

  // Reference data, not user data -- no auth, same as the card lookup.
  const searchResponse = await publicClient.get('/api/duel-links-skills?q=balance');

  assert.equal(searchResponse.status, 200);
  assert.ok(Array.isArray(searchResponse.body.skills));
  assert.equal(searchResponse.body.skills[0].name, 'Balance');
  assert.ok(searchResponse.body.skills[0].description.length > 0);

  // The whole point of the import: the full catalog, not a hand-written subset.
  assert.ok(
    searchResponse.body.total > 900,
    `expected a full skill catalog, got ${searchResponse.body.total}`
  );

  // Mid-name matches still surface, so "sense" finds the Draw Sense family.
  const partialResponse = await publicClient.get('/api/duel-links-skills?q=draw%20sense');
  assert.equal(partialResponse.status, 200);
  assert.ok(partialResponse.body.skills.length > 1);
  assert.ok(partialResponse.body.skills.every((skill) => /draw sense/i.test(skill.name)));

  // Rush Duel skills are carried too, flagged so the picker can label them.
  const rushResponse = await publicClient.get('/api/duel-links-skills?q=&limit=50');
  assert.equal(rushResponse.status, 200);
  assert.ok(rushResponse.body.skills.every((skill) => typeof skill.rush === 'boolean'));

  // An empty query lists the head of the catalog rather than erroring.
  assert.ok(rushResponse.body.skills.length > 0);

  // A nonsense query is an empty list, not a 404.
  const missResponse = await publicClient.get('/api/duel-links-skills?q=zzzzznotaskill');
  assert.equal(missResponse.status, 200);
  assert.deepEqual(missResponse.body.skills, []);
});

test('decklist flow: rejects unauthenticated and invalid decklist writes', async () => {
  const publicClient = request(app);

  const unauthenticatedResponse = await publicClient
    .post('/api/decklists')
    .send({
      name: 'Should Fail',
      game: 'ygo-tcg',
      mainDeck: '3x Test Card'
    });

  assert.equal(unauthenticatedResponse.status, 401);

  const client = request.agent(app);
  await registerUser(client, {
    username: 'validator',
    email: 'validator@example.com',
    password: 'secret123'
  });

  const invalidResponse = await client
    .post('/api/decklists')
    .send({
      name: '',
      game: 'bad-format',
      mainDeck: ''
    });

  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidResponse.body.error, 'Validation failed');
  assert.ok(Array.isArray(invalidResponse.body.details));
});

test('tournament flow: create and join with a decklist', async () => {
  const organizerClient = request.agent(app);
  const playerClient = request.agent(app);

  const organizer = await registerUser(organizerClient, {
    username: 'organizer',
    email: 'organizer@example.com',
    password: 'secret123'
  });

  await registerUser(playerClient, {
    username: 'entrant',
    email: 'entrant@example.com',
    password: 'secret123'
  });

  const playerDeck = await playerClient
    .post('/api/decklists')
    .send({
      name: 'Branded Midrange',
      game: 'ygo-tcg',
      mainDeck: '3x Aluber',
      extraDeck: '1x Mirrorjade',
      sideDeck: '',
      archetype: 'Branded',
      notes: 'Round one prep',
      isPublic: true
    });

  assert.equal(playerDeck.status, 201);

  const tournamentResponse = await organizerClient
    .post('/api/tournaments')
    .send({
      name: 'Locals Weekly',
      game: 'ygo-tcg',
      format: 'swiss',
      maxPlayers: 16,
      description: 'Community event'
    });

  assert.equal(tournamentResponse.status, 201);
  const tournamentId = tournamentResponse.body._id;

  const joinResponse = await playerClient
    .patch(`/api/tournaments/${tournamentId}/join`)
    .send({ decklistId: playerDeck.body._id });

  assert.equal(joinResponse.status, 200);
  assert.equal(joinResponse.body.currentPlayers, 1);

  const tournamentDetails = await request(app)
    .get(`/api/tournaments/${tournamentId}`);

  assert.equal(tournamentDetails.status, 200);
  assert.equal(tournamentDetails.body.currentPlayers, 1);
});

test('tournament flow: rejects invalid creation and join payloads', async () => {
  const organizerClient = request.agent(app);
  await registerUser(organizerClient, {
    username: 'badorganizer',
    email: 'badorganizer@example.com',
    password: 'secret123'
  });

  const invalidTournamentResponse = await organizerClient
    .post('/api/tournaments')
    .send({
      name: '',
      game: 'unknown-game',
      format: 'swiss',
      maxPlayers: 2
    });

  assert.equal(invalidTournamentResponse.status, 400);
  assert.equal(invalidTournamentResponse.body.error, 'Validation failed');

  const validTournamentResponse = await organizerClient
    .post('/api/tournaments')
    .send({
      name: 'Validation Weekly',
      game: 'ygo-tcg',
      format: 'swiss',
      maxPlayers: 16,
      description: 'Validation event'
    });

  assert.equal(validTournamentResponse.status, 201);

  const badJoinResponse = await organizerClient
    .patch(`/api/tournaments/${validTournamentResponse.body._id}/join`)
    .send({ decklistId: 'not-an-object-id' });

  assert.equal(badJoinResponse.status, 400);
  assert.equal(badJoinResponse.body.error, 'Validation failed');
});

test('rate limit flow: write limiter returns 429 with structured payload and headers', async () => {
  const client = request.agent(app);

  await registerUser(client, {
    username: 'ratelimit-user',
    email: 'ratelimit@example.com',
    password: 'secret123'
  });

  let throttledResponse = null;

  for (let attempt = 1; attempt <= 70; attempt += 1) {
    const response = await client
      .patch('/api/users/me')
      .send({ bio: `rate-limit-attempt-${attempt}` });

    if (response.status === 429) {
      throttledResponse = response;
      break;
    }
  }

  assert.ok(throttledResponse, 'Expected a 429 response from write rate limiter');
  assert.equal(throttledResponse.status, 429);
  assert.equal(throttledResponse.body.error, 'Too many write requests. Please slow down and try again shortly.');
  assert.ok(Array.isArray(throttledResponse.body.details));
  assert.equal(throttledResponse.body.details[0]?.path, 'rateLimit');

  // express-rate-limit with standardHeaders emits RateLimit-* headers; one must be present on throttled responses.
  const resetHeader = throttledResponse.headers['ratelimit-reset'];
  const retryAfterHeader = throttledResponse.headers['retry-after'];
  assert.ok(resetHeader || retryAfterHeader, 'Expected rate-limit reset or retry-after header');
});

test('rate limit flow: auth limiter throttles repeated login attempts with structured payload', async () => {
  const setupClient = request.agent(app);

  await registerUser(setupClient, {
    username: 'authlimit-user',
    email: 'authlimit@example.com',
    password: 'secret123'
  });

  let throttledResponse = null;

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'authlimit@example.com',
        password: 'wrong-password'
      });

    if (response.status === 429) {
      throttledResponse = response;
      break;
    }
  }

  assert.ok(throttledResponse, 'Expected a 429 response from auth rate limiter');
  assert.equal(throttledResponse.status, 429);
  assert.equal(throttledResponse.body.error, 'Too many authentication attempts. Please try again later.');
  assert.ok(Array.isArray(throttledResponse.body.details));
  assert.equal(throttledResponse.body.details[0]?.path, 'rateLimit');

  const resetHeader = throttledResponse.headers['ratelimit-reset'];
  const retryAfterHeader = throttledResponse.headers['retry-after'];
  assert.ok(resetHeader || retryAfterHeader, 'Expected auth limiter reset or retry-after header');
});

async function joinWithDecklist(client, { username, email }, tournamentId) {
  await registerUser(client, { username, email, password: 'secret123' });

  const decklistResponse = await client
    .post('/api/decklists')
    .send({
      name: `${username} deck`,
      game: 'ygo-tcg',
      mainDeck: '3x Pot of Greed',
      extraDeck: '',
      sideDeck: '',
      archetype: '',
      notes: '',
      isPublic: true
    });
  assert.equal(decklistResponse.status, 201);

  const joinResponse = await client
    .patch(`/api/tournaments/${tournamentId}/join`)
    .send({ decklistId: decklistResponse.body._id });
  assert.equal(joinResponse.status, 200);
}

// Registers an organizer plus `count` players, creates+starts a Swiss tournament,
// and returns everything needed to drive match/round endpoints in tests below.
async function setUpActiveSwissTournament(playerCount = 4) {
  const organizerClient = request.agent(app);
  await registerUser(organizerClient, {
    username: 'organizer',
    email: 'organizer@example.com',
    password: 'secret123'
  });

  const tournamentResponse = await organizerClient
    .post('/api/tournaments')
    .send({
      name: 'Lifecycle Weekly',
      game: 'ygo-tcg',
      format: 'swiss',
      maxPlayers: 16,
      description: 'Match lifecycle coverage'
    });
  assert.equal(tournamentResponse.status, 201);
  const tournamentId = tournamentResponse.body._id;

  const playerClients = [];
  for (let i = 1; i <= playerCount; i += 1) {
    const client = request.agent(app);
    await joinWithDecklist(client, { username: `player${i}`, email: `player${i}@example.com` }, tournamentId);
    playerClients.push(client);
  }

  const startResponse = await organizerClient.patch(`/api/tournaments/${tournamentId}/start`);
  assert.equal(startResponse.status, 200);
  assert.equal(startResponse.body.status, 'active');
  assert.equal(startResponse.body.rounds.length, 1);

  return { organizerClient, playerClients, tournamentId, tournament: startResponse.body };
}

function findMatchForPlayer(tournament, playerUsername) {
  const round = tournament.rounds[tournament.rounds.length - 1];
  const match = round.matches.find(
    (m) => m.player1?.username === playerUsername || m.player2?.username === playerUsername
  );
  return { round, match };
}

// Round-1 Swiss pairing is randomly shuffled (no records to seed off yet), so
// which two of the four registered players end up paired together varies
// between runs -- always resolve a client from the match's actual usernames
// rather than assuming a fixed playerClients index lines up with an opponent.
function clientForUsername(playerClients, username) {
  const index = Number(username.replace('player', '')) - 1;
  return playerClients[index];
}

test('match flow: report -> dispute -> organizer resolve -> reopen -> re-confirm', async () => {
  const { organizerClient, playerClients, tournamentId, tournament } = await setUpActiveSwissTournament(4);
  const { round, match } = findMatchForPlayer(tournament, 'player1');
  assert.ok(match, 'expected player1 to be in a match');
  assert.equal(match.player2 !== null, true, 'expected a non-bye match for a 4-player Swiss round 1');

  const reporterClient = clientForUsername(playerClients, match.player1.username);
  const opponentClient = clientForUsername(playerClients, match.player2.username);
  const outsiderUsername = ['player1', 'player2', 'player3', 'player4']
    .find((u) => u !== match.player1.username && u !== match.player2.username);
  const outsiderClient = clientForUsername(playerClients, outsiderUsername);

  const reportResponse = await reporterClient
    .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/report`)
    .send({ result: 'player1' });
  assert.equal(reportResponse.status, 200);
  const reportedMatch = findMatchForPlayer(reportResponse.body, 'player1').match;
  assert.equal(reportedMatch.resultStatus, 'awaiting-confirmation');
  assert.equal(reportedMatch.result, 'player1');

  const disputeResponse = await opponentClient
    .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/dispute`)
    .send({ reason: 'Wrong result reported' });
  assert.equal(disputeResponse.status, 200);
  const disputedMatch = findMatchForPlayer(disputeResponse.body, 'player1').match;
  assert.equal(disputedMatch.resultStatus, 'disputed');
  assert.equal(disputedMatch.disputeReason, 'Wrong result reported');

  // Reporting again while disputed is rejected -- only the organizer can resolve it.
  const blockedReportResponse = await reporterClient
    .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/report`)
    .send({ result: 'player1' });
  assert.equal(blockedReportResponse.status, 400);

  // A non-participant, non-organizer can't resolve the dispute.
  const outsiderResolveResponse = await outsiderClient
    .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/resolve`)
    .send({ result: 'player1', note: 'not the organizer' });
  assert.equal(outsiderResolveResponse.status, 403);

  const resolveResponse = await organizerClient
    .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/resolve`)
    .send({ result: 'player2', note: 'Reviewed replay, player2 actually won' });
  assert.equal(resolveResponse.status, 200);
  const resolvedMatch = findMatchForPlayer(resolveResponse.body, 'player1').match;
  assert.equal(resolvedMatch.resultStatus, 'confirmed');
  assert.equal(resolvedMatch.result, 'player2');
  assert.equal(resolvedMatch.resolutionNote, 'Reviewed replay, player2 actually won');

  const reopenResponse = await organizerClient
    .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/reopen`)
    .send({ note: 'Need to re-review' });
  assert.equal(reopenResponse.status, 200);
  const reopenedMatch = findMatchForPlayer(reopenResponse.body, 'player1').match;
  assert.equal(reopenedMatch.resultStatus, 'pending');
  assert.equal(reopenedMatch.result, 'pending');

  // Re-report and have the opponent confirm this time instead of disputing.
  const secondReportResponse = await reporterClient
    .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/report`)
    .send({ result: 'player1' });
  assert.equal(secondReportResponse.status, 200);

  const confirmResponse = await opponentClient
    .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/confirm`);
  assert.equal(confirmResponse.status, 200);
  const confirmedMatch = findMatchForPlayer(confirmResponse.body, 'player1').match;
  assert.equal(confirmedMatch.resultStatus, 'confirmed');
  assert.equal(confirmedMatch.result, 'player1');
});

test('round flow: lock active round, generate next round, and start it', async () => {
  const { organizerClient, playerClients, tournamentId, tournament } = await setUpActiveSwissTournament(4);
  const round1Id = tournament.rounds[0]._id;

  // Confirm every match in round 1 so the round becomes lockable.
  let latestTournament = tournament;
  for (const match of tournament.rounds[0].matches) {
    const reporterUsername = match.player1.username;
    const reporterClient = playerClients.find((_, idx) => `player${idx + 1}` === reporterUsername);
    const opponentUsername = match.player2.username;
    const opponentClient = playerClients.find((_, idx) => `player${idx + 1}` === opponentUsername);

    const reportResponse = await reporterClient
      .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/report`)
      .send({ result: 'player1' });
    assert.equal(reportResponse.status, 200);

    const confirmResponse = await opponentClient
      .patch(`/api/tournaments/${tournamentId}/matches/${match._id}/confirm`);
    assert.equal(confirmResponse.status, 200);
    latestTournament = confirmResponse.body;
  }

  assert.equal(latestTournament.roundMeta.canLockActiveRound, true);

  // A non-organizer can't lock the round.
  const outsiderLockResponse = await playerClients[0]
    .patch(`/api/tournaments/${tournamentId}/rounds/${round1Id}/lock`);
  assert.equal(outsiderLockResponse.status, 403);

  const lockResponse = await organizerClient
    .patch(`/api/tournaments/${tournamentId}/rounds/${round1Id}/lock`);
  assert.equal(lockResponse.status, 200);
  assert.equal(lockResponse.body.rounds[0].status, 'locked');

  const nextRoundResponse = await organizerClient
    .post(`/api/tournaments/${tournamentId}/rounds/next`);
  assert.equal(nextRoundResponse.status, 200);
  assert.equal(nextRoundResponse.body.status, 'active', 'tournament should still be active (min 3 Swiss rounds for 4 players)');
  assert.equal(nextRoundResponse.body.rounds.length, 2);
  assert.equal(nextRoundResponse.body.rounds[1].status, 'not_started');

  const round2Id = nextRoundResponse.body.rounds[1]._id;

  const startRoundResponse = await organizerClient
    .patch(`/api/tournaments/${tournamentId}/rounds/${round2Id}/start`);
  assert.equal(startRoundResponse.status, 200);
  assert.equal(startRoundResponse.body.rounds[1].status, 'active');
  assert.equal(startRoundResponse.body.roundMeta.activeRoundId, round2Id);
});

test('rate limit flow: auth limiter key is isolated by client ip', async () => {
  const registerResponse = await request(app)
    .post('/api/auth/register')
    .set('X-Forwarded-For', '198.51.100.9')
    .send({
      username: 'authlimit-ip-user',
      email: 'authlimit-ip@example.com',
      password: 'secret123'
    });

  assert.equal(registerResponse.status, 200);

  let throttledResponse = null;

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.10')
      .send({
        email: 'authlimit-ip@example.com',
        password: 'wrong-password'
      });

    if (response.status === 429) {
      throttledResponse = response;
      break;
    }
  }

  assert.ok(throttledResponse, 'Expected first IP to be throttled by auth limiter');

  const secondIpResponse = await request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', '198.51.100.11')
    .send({
      email: 'authlimit-ip@example.com',
      password: 'wrong-password'
    });

  // A fresh IP should not inherit throttle state and should receive normal auth failure (not 429).
  assert.notEqual(secondIpResponse.status, 429);
  assert.equal(secondIpResponse.status, 400);
  assert.equal(secondIpResponse.body.error, 'Invalid credentials');
});

test('rate limit flow: spoofed X-Forwarded-For entries cannot escape the auth bucket', async () => {
  // registerApi trusts exactly one proxy hop, so only the rightmost entry (the
  // one API Gateway appends) picks the bucket. A client rotating a fake
  // leftmost entry on every attempt must still be throttled.
  assert.equal(app.get('trust proxy'), 1);

  let throttledResponse = null;

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', `203.0.113.${attempt}, 198.51.100.20`)
      .send({
        email: 'nobody@example.com',
        password: 'wrong-password'
      });

    if (response.status === 429) {
      throttledResponse = response;
      break;
    }
  }

  assert.ok(throttledResponse, 'Expected rotating spoofed entries to share one auth bucket');
  assert.equal(throttledResponse.body.error, 'Too many authentication attempts. Please try again later.');
});

test('admin: non-admin users are blocked from admin routes', async () => {
  const client = request.agent(app);
  await registerUser(client, {
    username: 'regularuser',
    email: 'regularuser@example.com',
    password: 'secret123'
  });

  const meResponse = await client.get('/api/auth/me');
  assert.equal(meResponse.body.isAdmin, false);

  const statsResponse = await client.get('/api/admin/stats');
  assert.equal(statsResponse.status, 403);
});

test('admin: allowlisted email gets cross-tournament visibility and organizer bypass', async () => {
  const adminClient = request.agent(app);
  const organizerClient = request.agent(app);

  const { user: adminUser } = await registerUser(adminClient, {
    username: 'siteadmin',
    email: 'admin@example.com',
    password: 'secret123'
  });

  await registerUser(organizerClient, {
    username: 'someorganizer',
    email: 'someorganizer@example.com',
    password: 'secret123'
  });

  const meResponse = await adminClient.get('/api/auth/me');
  assert.equal(meResponse.body.isAdmin, true);

  const tournamentResponse = await organizerClient
    .post('/api/tournaments')
    .send({
      name: 'Admin Visibility Cup',
      game: 'ygo-tcg',
      format: 'swiss',
      maxPlayers: 16
    });
  assert.equal(tournamentResponse.status, 201);
  const tournamentId = tournamentResponse.body._id;

  // Admin isn't the organizer but should still see it in the cross-tournament list.
  const listResponse = await adminClient.get('/api/admin/tournaments');
  assert.equal(listResponse.status, 200);
  assert.ok(listResponse.body.some((t) => t._id === tournamentId));

  const statsResponse = await adminClient.get('/api/admin/stats');
  assert.equal(statsResponse.status, 200);
  assert.ok(statsResponse.body.totalTournaments >= 1);
  assert.ok(statsResponse.body.totalUsers >= 2);

  const disputesResponse = await adminClient.get('/api/admin/disputes');
  assert.equal(disputesResponse.status, 200);
  assert.deepEqual(disputesResponse.body, []);

  // Emergency status override bypasses the normal start/complete business rules.
  const statusOverride = await adminClient
    .patch(`/api/admin/tournaments/${tournamentId}/status`)
    .send({ status: 'active' });
  assert.equal(statusOverride.status, 200);
  assert.equal(statusOverride.body.status, 'active');

  // A second tournament to test organizer reassignment in isolation.
  const secondTournament = await organizerClient
    .post('/api/tournaments')
    .send({
      name: 'Reassignment Cup',
      game: 'ygo-tcg',
      format: 'swiss',
      maxPlayers: 16
    });
  assert.equal(secondTournament.status, 201);

  const reassignResponse = await adminClient
    .patch(`/api/admin/tournaments/${secondTournament.body._id}/organizer`)
    .send({ organizerId: adminUser.id });
  assert.equal(reassignResponse.status, 200);
  assert.equal(reassignResponse.body.createdBy._id, adminUser.id);

  // A non-admin, non-organizer can't delete someone else's tournament...
  const outsiderClient = request.agent(app);
  await registerUser(outsiderClient, {
    username: 'outsider',
    email: 'outsider@example.com',
    password: 'secret123'
  });
  const blockedDelete = await outsiderClient.delete(`/api/tournaments/${tournamentId}`);
  assert.equal(blockedDelete.status, 403);

  // ...but the admin can, via the isOrganizer() bypass on the regular route.
  const adminDelete = await adminClient.delete(`/api/tournaments/${tournamentId}`);
  assert.equal(adminDelete.status, 200);
});

test('card database: cardinfo.php looks up a card by id', async () => {
  const response = await request(app).get('/api/v7/cardinfo.php?id=89631139');

  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  const [card] = response.body.data;
  assert.equal(card.id, 89631139);
  assert.equal(card.name, 'Blue-Eyes White Dragon');
  assert.equal(card.atk, 3000);
  // No CARD_IMAGE_BASE_URL is set in tests, so image URLs route through this app's own endpoint.
  assert.ok(card.card_images[0].image_url.includes('/api/v7/card-image/89631139'));
});

test('card database: cardinfo.php falls back to fname search and reports no-match as 404', async () => {
  const matchResponse = await request(app).get('/api/v7/cardinfo.php?fname=Blue-Eyes');
  assert.equal(matchResponse.status, 200);
  assert.equal(matchResponse.body.data[0].name, 'Blue-Eyes White Dragon');

  const noMatchResponse = await request(app).get('/api/v7/cardinfo.php?fname=Definitely Not A Real Card');
  assert.equal(noMatchResponse.status, 404);
  assert.ok(noMatchResponse.body.error);
});

test('card database: cardinfo.php rejects a non-numeric id', async () => {
  const response = await request(app).get('/api/v7/cardinfo.php?id=not-a-number');

  assert.equal(response.status, 400);
  assert.ok(response.body.error);
});

test('card database: card-image returns 404 when no local image file exists', async () => {
  // The test env never downloads real card art (npm run cards:download-images
  // is an operator-run maintenance step), so a lookup for a real card id should
  // still correctly report "not found locally" rather than erroring.
  const response = await request(app).get('/api/v7/card-image/89631139');

  assert.equal(response.status, 404);
  assert.ok(response.body.message.includes('not found locally'));
});

test('card database: card-image rejects a non-numeric id', async () => {
  const response = await request(app).get('/api/v7/card-image/not-a-number');

  assert.equal(response.status, 400);
});

test('card database: health endpoint reports card count', async () => {
  const response = await request(app).get('/api/v7/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  // Blue-Eyes White Dragon plus the D012 seed.
  assert.equal(response.body.cards, 1 + UNRESOLVED_CARDS_SEED.length);
});

// ---------------------------------------------------------------------------
// Duel Links exclusive cards (board D011). Spec:
// ops/staff/cards/2026-10-27-duel-links-exclusive-cards-spec.md (gitignored).
//
// These hit the real checked in list, server/reference-data/duel-links-exclusive-cards.json,
// through the real router. The in-memory SQLite catalog only holds Blue-Eyes
// White Dragon (seeded above), so every Kiteroid hit below can only come from
// the exclusives list. tests/fixtures/duel-links-exclusive-cards.fixture.json
// is a six card copy the E2E mocks serve; the integrity test keeps it honest.
// ---------------------------------------------------------------------------
const DL_EXCLUSIVES_PATH = require('node:path').join(__dirname, '..', 'server', 'reference-data', 'duel-links-exclusive-cards.json');
const DL_EXCLUSIVES_FIXTURE = require('./fixtures/duel-links-exclusive-cards.fixture.json');
const KITEROID_ID = 'dlx-60c2b3aba0e24f2d54a52877';
const DLX_ID_PATTERN = /^dlx-[0-9a-f]{24}$/;

function loadDuelLinksExclusives() {
  // Read fresh rather than require(): a missing file fails with a clear
  // ENOENT naming the path dev has to create.
  return JSON.parse(require('node:fs').readFileSync(DL_EXCLUSIVES_PATH, 'utf8'));
}

test('dl exclusives: name lookup with game=duel-links returns Kiteroid in the catalog card shape', async () => {
  const response = await request(app).get('/api/v7/cardinfo.php?name=Kiteroid&game=duel-links');

  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  const card = response.body.data[0];
  assert.equal(card.name, 'Kiteroid');
  assert.match(String(card.id), DLX_ID_PATTERN);
  assert.equal(card.id, KITEROID_ID);
  assert.equal(card.type, 'Effect Monster');
  assert.equal(card.frameType, 'effect');
  assert.equal(card.attribute, 'WIND');
  assert.equal(card.level, 1);
  assert.equal(card.atk, 200);
  assert.equal(card.def, 400);
  assert.ok(card.desc && card.desc.length > 0);
  assert.deepEqual(card.card_images, []);
  assert.deepEqual(card.card_sets, []);
  assert.deepEqual(card.card_prices, []);
  assert.equal(card.banlist_info.ban_duel_links, 'Limited 2');
  assert.equal(card.dl_exclusive, true);

  // Case insensitive, like every other name lookup.
  const lower = await request(app).get('/api/v7/cardinfo.php?name=kiteroid&game=duel-links');
  assert.equal(lower.status, 200);
  assert.equal(lower.body.data[0].name, 'Kiteroid');

  // An exclusive with no Duel Links limit omits banlist_info entirely.
  const playmaker = await request(app).get('/api/v7/cardinfo.php?name=Playmaker&game=duel-links');
  assert.equal(playmaker.status, 200);
  assert.equal(playmaker.body.data[0].frameType, 'xyz');
  assert.equal(playmaker.body.data[0].banlist_info, undefined);
});

test('dl exclusives: name lookup without game=duel-links never finds an exclusive', async () => {
  for (const suffix of ['', '&game=ygo-tcg', '&game=master-duel', '&game=rush-duel']) {
    const response = await request(app).get(`/api/v7/cardinfo.php?name=Kiteroid${suffix}`);
    assert.equal(response.status, 404, `name=Kiteroid${suffix} should 404`);
  }

  // Control: the same name does resolve for Duel Links, so the 404s above are
  // about the game, not a missing card.
  const control = await request(app).get('/api/v7/cardinfo.php?name=Kiteroid&game=duel-links');
  assert.equal(control.status, 200);
});

test('dl exclusives: fname search adds exclusives only for game=duel-links, after catalog hits', async () => {
  const dl = await request(app).get('/api/v7/cardinfo.php?fname=kite&game=duel-links');
  assert.equal(dl.status, 200);
  assert.ok(dl.body.data.some((card) => card.name === 'Kiteroid'), 'Duel Links search should include Kiteroid');

  const plain = await request(app).get('/api/v7/cardinfo.php?fname=kite');
  assert.ok(!(plain.body.data || []).some((card) => card.name === 'Kiteroid'), 'search without game must not include Kiteroid');

  const tcg = await request(app).get('/api/v7/cardinfo.php?fname=kite&game=ygo-tcg');
  assert.ok(!(tcg.body.data || []).some((card) => card.name === 'Kiteroid'), 'TCG search must not include Kiteroid');

  // Catalog cards still come back for a Duel Links search.
  const catalog = await request(app).get('/api/v7/cardinfo.php?fname=Blue-Eyes&game=duel-links');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.data[0].name, 'Blue-Eyes White Dragon');
  assert.equal(catalog.body.data[0].dl_exclusive, undefined);
});

test('dl exclusives: id lookups never return an exclusive', async () => {
  // Control: Kiteroid exists for Duel Links, so a 400 below is the id rule,
  // not a card the server has never heard of.
  const control = await request(app).get('/api/v7/cardinfo.php?name=Kiteroid&game=duel-links');
  assert.equal(control.status, 200);
  const id = control.body.data[0].id;

  for (const suffix of ['', '&game=duel-links']) {
    const response = await request(app).get(`/api/v7/cardinfo.php?id=${encodeURIComponent(id)}${suffix}`);
    assert.equal(response.status, 400, `id=${id}${suffix} should be refused`);
  }

  // A numeric id with game=duel-links still answers from the catalog only.
  const numeric = await request(app).get('/api/v7/cardinfo.php?id=89631139&game=duel-links');
  assert.equal(numeric.status, 200);
  assert.equal(numeric.body.data.length, 1);
  assert.equal(numeric.body.data[0].name, 'Blue-Eyes White Dragon');
});

test('dl exclusives: card-image refuses a dlx id with a 400', async () => {
  const control = await request(app).get('/api/v7/cardinfo.php?name=Kiteroid&game=duel-links');
  assert.equal(control.status, 200);
  const id = control.body.data[0].id;

  for (const size of ['', '?size=small', '?size=cropped']) {
    const response = await request(app).get(`/api/v7/card-image/${encodeURIComponent(id)}${size}`);
    assert.equal(response.status, 400);
    assert.ok(response.body.message);
  }
});

test('dl exclusives: the checked in list is well formed and matches the test fixture', () => {
  const file = loadDuelLinksExclusives();
  assert.ok(Array.isArray(file.cards), 'cards must be an array');
  assert.ok(file.meta && file.meta.dlLimitAsOf, 'meta.dlLimitAsOf is required');

  const cards = file.cards;
  assert.ok(cards.length >= 90 && cards.length <= 200, `expected 90 to 200 exclusives, got ${cards.length}`);

  const ids = new Set();
  const names = new Set();
  const EXTRA_FRAMES = ['fusion', 'synchro', 'xyz', 'link'];
  for (const card of cards) {
    assert.match(String(card.id), DLX_ID_PATTERN, `bad id on ${card.name}`);
    assert.ok(!ids.has(card.id), `duplicate id ${card.id}`);
    ids.add(card.id);

    const key = String(card.name).toLowerCase();
    assert.ok(!names.has(key), `duplicate name ${card.name}`);
    names.add(key);

    assert.ok(['Monster', 'Spell', 'Trap'].includes(card.cardType), `bad cardType on ${card.name}`);
    const isExtra = EXTRA_FRAMES.some((frame) => String(card.frameType).startsWith(frame));
    assert.equal(card.extraDeck, isExtra, `extraDeck wrong on ${card.name} (${card.frameType})`);
    assert.ok([null, 'Forbidden', 'Limited 1', 'Limited 2', 'Limited 3'].includes(card.dlLimit), `bad dlLimit on ${card.name}`);
    assert.ok(!Object.keys(card).some((k) => /image/i.test(k)), `${card.name} must carry no image field`);
  }

  // Sorted by name, as the import script writes it.
  const sorted = cards.map((c) => c.name).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(cards.map((c) => c.name), sorted);

  // Renames and punctuation variants of catalog cards must never be added.
  for (const name of [
    'Synch Realm',
    'Tribute to The Doomed',
    'Twin Long Rods 1',
    'Vaylantz Wave – Master Phase',
    'Battlin’ Boxing Cross Counter'
  ]) {
    assert.ok(!names.has(name.toLowerCase()), `${name} is a catalog card and must not be listed`);
  }

  // The E2E fixture must agree with the real list on every field the app reads.
  for (const fixtureCard of DL_EXCLUSIVES_FIXTURE.cards) {
    const real = cards.find((c) => c.name === fixtureCard.name);
    assert.ok(real, `fixture card ${fixtureCard.name} missing from the real list`);
    for (const field of ['id', 'cardType', 'type', 'frameType', 'extraDeck', 'level', 'dlLimit']) {
      assert.deepEqual(real[field], fixtureCard[field], `${fixtureCard.name}.${field} drifted from the fixture`);
    }
  }
});

// ---------------------------------------------------------------------------
// Unresolved decklist cards (board D012). Memo:
// ops/ceo-memos/2026-11-07-unresolved-cards.md (gitignored).
//
// Server spec items 1 (alternate art passcodes on id=) and 2 (normalized
// name retry, single match only). The cards come from UNRESOLVED_CARDS_SEED
// at the top of this file.
// ---------------------------------------------------------------------------
async function lookup(query) {
  return request(app).get(`/api/v7/cardinfo.php?${query}`);
}

function assertSingleCard(response, { id, name }, label) {
  assert.equal(response.status, 200, `${label}: expected 200, got ${response.status}`);
  assert.equal(response.body.data.length, 1, `${label}: expected exactly one card`);
  assert.equal(response.body.data[0].id, id, `${label}: wrong card id`);
  assert.equal(response.body.data[0].name, name, `${label}: wrong card name`);
}

test('unresolved cards: an alternate art passcode on id= returns the main card', async () => {
  // Control: the main passcode works today.
  assertSingleCard(await lookup('id=46986414'), { id: 46986414, name: 'Dark Magician' }, 'id=46986414');

  for (const [altId, main] of [
    ['36996508', { id: 46986414, name: 'Dark Magician' }],
    ['46986415', { id: 46986414, name: 'Dark Magician' }],
    ['46986421', { id: 46986414, name: 'Dark Magician' }],
    ['14558128', { id: 14558127, name: 'Ash Blossom & Joyous Spring' }],
    ['18144506', { id: 18144507, name: "Harpie's Feather Duster" }]
  ]) {
    const response = await lookup(`id=${altId}`);
    assertSingleCard(response, main, `id=${altId}`);
    // The answer is the main card, alternate art included, not a copy keyed by the alt id.
    assert.ok(
      response.body.data[0].card_images.some((image) => String(image.id) === altId),
      `id=${altId}: card_images should still list the alternate art`
    );
  }
});

test('unresolved cards: an id that is no card and no alternate art still 404s', async () => {
  // Control so this can't pass just because every id lookup is broken.
  assertSingleCard(await lookup('id=36996508'), { id: 46986414, name: 'Dark Magician' }, 'control id=36996508');

  for (const id of ['99999999', '46986413', '1']) {
    const response = await lookup(`id=${id}`);
    assert.equal(response.status, 404, `id=${id} should 404`);
  }
});

test('unresolved cards: an exact name miss retries on a normalized name', async () => {
  const darkMagician = { id: 46986414, name: 'Dark Magician' };
  const maxx = { id: 23434538, name: 'Maxx "C"' };
  const blueEyes = { id: 89631139, name: 'Blue-Eyes White Dragon' };
  const harpie = { id: 18144507, name: "Harpie's Feather Duster" };

  // Control: exact names already work.
  assertSingleCard(await lookup(`name=${encodeURIComponent('Maxx "C"')}`), maxx, 'exact Maxx "C"');

  const cases = [
    // case only
    ['dark magician', darkMagician],
    ['DARK MAGICIAN', darkMagician],
    // whitespace collapsed and trimmed
    ['  Dark   Magician ', darkMagician],
    // double quotes stripped: the pasted list spelling from the memo
    ['Maxx C', maxx],
    ['maxx c', maxx],
    // curly double quotes
    ['Maxx “C”', maxx],
    // curly apostrophe
    ['Harpie’s Feather Duster', harpie],
    // en dash and em dash to hyphen
    ['Blue–Eyes White Dragon', blueEyes],
    ['blue—eyes white dragon', blueEyes]
  ];

  for (const [input, expected] of cases) {
    assertSingleCard(await lookup(`name=${encodeURIComponent(input)}`), expected, `name=${JSON.stringify(input)}`);
  }
});

test('unresolved cards: "and" finds an "&" name when that is the only match', async () => {
  const ash = { id: 14558127, name: 'Ash Blossom & Joyous Spring' };
  assertSingleCard(await lookup(`name=${encodeURIComponent('Ash Blossom & Joyous Spring')}`), ash, 'exact');
  assertSingleCard(await lookup(`name=${encodeURIComponent('Ash Blossom and Joyous Spring')}`), ash, 'and');
  assertSingleCard(await lookup(`name=${encodeURIComponent('ash blossom & joyous spring')}`), ash, 'case only');
});

test('unresolved cards: a normalized name that matches two cards returns 404, not a guess', async () => {
  // Exact names still pick their own card even though they share a normalized key.
  assertSingleCard(await lookup(`name=${encodeURIComponent('QA Twin "Echo"')}`), { id: 900000001, name: 'QA Twin "Echo"' }, 'exact quoted twin');
  assertSingleCard(await lookup(`name=${encodeURIComponent('QA Twin Echo')}`), { id: 900000002, name: 'QA Twin Echo' }, 'exact plain twin');

  // Both twins normalize to "qa twin echo", so a non exact spelling is ambiguous.
  for (const input of ['qa twin echo', 'QA  TWIN  ECHO', 'qa twin “echo”']) {
    const response = await lookup(`name=${encodeURIComponent(input)}`);
    assert.equal(response.status, 404, `name=${JSON.stringify(input)} matches two cards and must 404`);
  }

  // Control: the normalized retry exists, so the 404s above are the
  // single match rule and not a missing feature.
  assertSingleCard(await lookup('name=maxx%20c'), { id: 23434538, name: 'Maxx "C"' }, 'control maxx c');
});

test('unresolved cards: a name that is not in the catalog still 404s', async () => {
  for (const input of ['Definitely Not A Real Card', 'Maxx D', 'Dark Magician Girl']) {
    const response = await lookup(`name=${encodeURIComponent(input)}`);
    assert.equal(response.status, 404, `name=${JSON.stringify(input)} should 404`);
  }
  // Control: same shape of request, a normalized hit.
  assertSingleCard(await lookup('name=dark%20magician'), { id: 46986414, name: 'Dark Magician' }, 'control dark magician');
});

test('unresolved cards: normalizing catalog names leaves Duel Links exclusives as they were', async () => {
  // Exclusives still answer only for game=duel-links.
  assert.equal((await lookup('name=Kiteroid&game=duel-links')).status, 200);
  assert.equal((await lookup('name=kiteroid')).status, 404);
  assert.equal((await lookup('name=Kiteroid&game=ygo-tcg')).status, 404);

  // A catalog card found by a normalized name in a Duel Links deck is the
  // catalog card, not an exclusive.
  const maxx = await lookup('name=maxx%20c&game=duel-links');
  assertSingleCard(maxx, { id: 23434538, name: 'Maxx "C"' }, 'maxx c for duel links');
  assert.equal(maxx.body.data[0].dl_exclusive, undefined);
});
