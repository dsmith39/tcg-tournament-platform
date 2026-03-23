/*
 * End-to-end API integration tests (Node test runner + Supertest + in-memory MongoDB).
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
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { registerApi, ensureMongoConnection } = require('../server/api-server');
const { resetRateLimiters } = require('../server/security');

let mongod;
let app;

// Socket behavior is not under test here; provide minimal stub to satisfy registerApi.
function buildIoStub() {
  return {
    on: () => {},
    emit: () => {}
  };
}

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
  // Boot isolated in-memory MongoDB and mount the API once for the suite.
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test-jwt-secret';

  app = express();
  // Trust proxy headers during tests so X-Forwarded-For can represent different client IPs.
  app.set('trust proxy', true);
  registerApi(app, buildIoStub());
  await ensureMongoConnection();
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  }

  if (mongod) {
    await mongod.stop();
  }
});

test.beforeEach(async () => {
  // Clear MongoDB documents so each test starts with a clean data slate.
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));

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
