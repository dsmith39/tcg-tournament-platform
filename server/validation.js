/*
 * API input contract definitions.
 *
 * This module centralizes all zod schemas so:
 * - handlers can trust req.validated data,
 * - validation messages stay consistent,
 * - schema drift is minimized between endpoints.
 */
const { z } = require('zod');

// Centralizing validation keeps route handlers focused on business rules instead of input parsing.
// The schemas below document the payload contract for every API write endpoint in one place.

const gameEnumValues = ['ygo-tcg', 'master-duel', 'duel-links'];
const tournamentFormatValues = ['swiss', 'single-elim', 'double-elim'];
const matchResultValues = ['player1', 'player2', 'draw'];
const topCutSizes = [0, 4, 8, 16, 32];

// Shared ObjectId shape for all route params and ID-bearing payloads.
const objectIdSchema = z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id format');

const trimmedString = (maxLength) => z.string().trim().max(maxLength);
const optionalTrimmedString = (maxLength) => trimmedString(maxLength).optional();

const registerBodySchema = z.object({
  username: z.string().trim().min(3).max(32),
  email: z.string().trim().email().max(120),
  password: z.string().min(8).max(128)
}).strict();

const loginBodySchema = z.object({
  email: z.string().trim().email().max(120),
  password: z.string().min(1).max(128)
}).strict();

const userProfileUpdateBodySchema = z.object({
  bio: optionalTrimmedString(500),
  location: optionalTrimmedString(100),
  favoriteGame: optionalTrimmedString(60),
  favoriteDeck: optionalTrimmedString(120),
  website: optionalTrimmedString(120),
  avatarUrl: optionalTrimmedString(500)
}).strict();

const createDecklistBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  game: z.enum(gameEnumValues),
  mainDeck: z.string().trim().min(1).max(12000),
  extraDeck: z.string().trim().max(6000).optional().default(''),
  sideDeck: z.string().trim().max(6000).optional().default(''),
  isPublic: z.boolean().optional().default(true),
  archetype: z.string().trim().max(80).optional().default(''),
  notes: z.string().trim().max(1000).optional().default('')
}).strict();

const updateDecklistBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  game: z.enum(gameEnumValues).optional(),
  mainDeck: z.string().trim().min(1).max(12000).optional(),
  extraDeck: z.string().trim().max(6000).optional(),
  sideDeck: z.string().trim().max(6000).optional(),
  isPublic: z.boolean().optional(),
  archetype: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(1000).optional()
}).strict();

const createTournamentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  game: z.enum(gameEnumValues),
  format: z.enum(tournamentFormatValues),
  maxPlayers: z.number().int().min(4).max(256),
  description: z.string().trim().max(1000).optional().default(''),
  roundTimerMinutes: z.number().int().min(0).max(180).optional().default(0),
  topCutSize: z.number().int().refine((value) => topCutSizes.includes(value), {
    message: 'Top cut size must be one of 0, 4, 8, 16, or 32'
  }).optional().default(0)
}).strict();

const joinTournamentBodySchema = z.object({
  decklistId: objectIdSchema
}).strict();

const matchReportBodySchema = z.object({
  result: z.enum(matchResultValues)
}).strict();

const matchDisputeBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional().default('Result disputed')
}).strict();

const matchResolveBodySchema = z.object({
  result: z.enum(matchResultValues),
  note: z.string().trim().max(500).optional().default('')
}).strict();

const matchReopenBodySchema = z.object({
  note: z.string().trim().max(500).optional().default('Organizer reopened the match for correction')
}).strict();

const tournamentIdParamsSchema = z.object({
  id: objectIdSchema
}).strict();

const roundIdParamsSchema = z.object({
  id: objectIdSchema,
  roundId: objectIdSchema
}).strict();

const matchIdParamsSchema = z.object({
  id: objectIdSchema,
  matchId: objectIdSchema
}).strict();

const formatValidationError = (error) => {
  if (!error?.issues) {
    return { error: 'Validation failed' };
  }

  return {
    error: 'Validation failed',
    details: error.issues.map((issue) => ({
      path: issue.path.join('.') || 'root',
      message: issue.message
    }))
  };
};

// This middleware validates request params/body up front and stores parsed values on req.validated.
// Handlers can then trust the payload shape and stay focused on domain logic.
const validateRequest = ({ body, params } = {}) => (req, res, next) => {
  try {
    req.validated = req.validated || {};

    if (params) {
      req.validated.params = params.parse(req.params || {});
    }

    if (body) {
      req.validated.body = body.parse(req.body || {});
    }

    next();
  } catch (error) {
    res.status(400).json(formatValidationError(error));
  }
};

module.exports = {
  gameEnumValues,
  tournamentFormatValues,
  registerBodySchema,
  loginBodySchema,
  userProfileUpdateBodySchema,
  createDecklistBodySchema,
  updateDecklistBodySchema,
  createTournamentBodySchema,
  joinTournamentBodySchema,
  matchReportBodySchema,
  matchDisputeBodySchema,
  matchResolveBodySchema,
  matchReopenBodySchema,
  tournamentIdParamsSchema,
  roundIdParamsSchema,
  matchIdParamsSchema,
  validateRequest
};