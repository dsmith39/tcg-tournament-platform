/*
 * Route-specific rate limiting policy for API protection.
 *
 * Why separate limiters:
 * - Auth endpoints require stricter brute-force protection.
 * - General write endpoints need broader but bounded throughput.
 * - Match actions are sensitive to race-condition abuse.
 */
const { ipKeyGenerator, rateLimit, MemoryStore } = require('express-rate-limit');

// These limiters are intentionally scoped by route type instead of one global setting.
// Auth endpoints need tighter protection against brute force attempts, while organizer actions
// need enough headroom for legitimate use but still benefit from abuse throttling.

// Explicit MemoryStore instances are kept so the test suite can call resetRateLimiters()
// in beforeEach, preventing IP-keyed auth limits from accumulating across test cases.
const authStore = new MemoryStore();
const writeStore = new MemoryStore();
const matchActionStore = new MemoryStore();

// Shared factory ensures all limiters emit the same structured JSON errors.
const buildLimiter = ({
  windowMs,
  max,
  message,
  keyGenerator,
  store
}) => rateLimit({
  windowMs,
  max,
  store,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: {
    error: message,
    details: [{ path: 'rateLimit', message }]
  }
});

const defaultKey = (req) => ipKeyGenerator(req.ip || 'unknown');
const userOrIpKey = (req) => req.user?.id || ipKeyGenerator(req.ip || 'unknown');

// Login/register/refresh/logout routes are the most common abuse target.
const authLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts. Please try again later.',
  keyGenerator: defaultKey,
  store: authStore
});

// Profile/decklist/tournament writes are limited more loosely to avoid harming normal use.
const writeLimiter = buildLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: 'Too many write requests. Please slow down and try again shortly.',
  keyGenerator: userOrIpKey,
  store: writeStore
});

// Match reporting and organizer round controls are especially sensitive because repeated requests
// can corrupt tournament flow or create noisy race conditions.
const matchActionLimiter = buildLimiter({
  windowMs: 2 * 60 * 1000,
  max: 30,
  message: 'Too many tournament action requests. Please wait a moment and try again.',
  keyGenerator: userOrIpKey,
  store: matchActionStore
});

// Flush all in-memory rate limit counters. Called by the integration test suite in
// beforeEach so IP-keyed auth buckets don't accumulate across otherwise-isolated tests.
const resetRateLimiters = () => {
  authStore.resetAll();
  writeStore.resetAll();
  matchActionStore.resetAll();
};

module.exports = {
  authLimiter,
  writeLimiter,
  matchActionLimiter,
  resetRateLimiters
};