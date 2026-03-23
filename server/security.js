const { ipKeyGenerator, rateLimit } = require('express-rate-limit');

// These limiters are intentionally scoped by route type instead of one global setting.
// Auth endpoints need tighter protection against brute force attempts, while organizer actions
// need enough headroom for legitimate use but still benefit from abuse throttling.

const isTestEnv = process.env.NODE_ENV === 'test';

const buildLimiter = ({
  windowMs,
  max,
  message,
  keyGenerator
}) => rateLimit({
  windowMs,
  max,
  skip: () => isTestEnv,
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
  keyGenerator: defaultKey
});

// Profile/decklist/tournament writes are limited more loosely to avoid harming normal use.
const writeLimiter = buildLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: 'Too many write requests. Please slow down and try again shortly.',
  keyGenerator: userOrIpKey
});

// Match reporting and organizer round controls are especially sensitive because repeated requests
// can corrupt tournament flow or create noisy race conditions.
const matchActionLimiter = buildLimiter({
  windowMs: 2 * 60 * 1000,
  max: 30,
  message: 'Too many tournament action requests. Please wait a moment and try again.',
  keyGenerator: userOrIpKey
});

module.exports = {
  authLimiter,
  writeLimiter,
  matchActionLimiter
};