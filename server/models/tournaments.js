/*
 * Tournament repository backed by DynamoDB (theduelclub-Tournaments table).
 *
 * players/registrations/rounds/checkedInPlayers/topCutPlayers are native
 * DynamoDB List/Map attributes instead of a serialized JSON column -- the
 * DocumentClient marshals nested JS objects/arrays directly, so there's no
 * more JSON.parse/JSON.stringify step.
 *
 * `findById` returns the raw (unpopulated) tournament, matching the old
 * `Tournament.findById(id)` calls used for mutation. `findByIdHydrated`
 * replaces every embedded user/decklist id reference with the looked-up
 * object, matching the old `.populate(tournamentPopulate)` behavior --
 * used only to build response payloads, never for mutation.
 *
 * Optimistic locking: unlike SQLite's WAL mode (which incidentally
 * serialized every writer), concurrent DynamoDB writers can silently clobber
 * each other. Every item carries a `version` counter; `.save()` requires the
 * version read at findById() time to still match, or throws
 * TournamentVersionConflictError (caught centrally in api-server.js as an
 * HTTP 409) instead of losing one side's update.
 */
const {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');
const { getClient } = require('../dynamo');
const { TABLE_NAMES } = require('../dynamo-schema');
const { generateId } = require('./id');
const usersRepo = require('./users');
const decklistsRepo = require('./decklists');

const TABLE = TABLE_NAMES.TOURNAMENTS_TABLE;

class TournamentVersionConflictError extends Error {
  constructor() {
    super('This tournament was updated by someone else. Please refresh and retry.');
    this.name = 'TournamentVersionConflictError';
  }
}

// `_version` is attached non-enumerable (like `save`) so it never leaks into
// API responses that spread a tournament object (listSummaries, hydrate()).
function attachSave(tournament, version = 0) {
  Object.defineProperty(tournament, 'save', {
    value: async function save() {
      await persist(this);
      return this;
    },
    enumerable: false
  });
  Object.defineProperty(tournament, '_version', {
    value: version,
    writable: true,
    enumerable: false
  });
  return tournament;
}

function itemToTournament(item) {
  if (!item) return null;

  return attachSave({
    _id: item.id,
    name: item.name,
    game: item.game,
    format: item.format,
    maxPlayers: item.maxPlayers,
    currentPlayers: item.currentPlayers,
    players: item.players || [],
    registrations: item.registrations || [],
    description: item.description || '',
    createdBy: item.createdBy,
    createdAt: new Date(item.createdAt),
    status: item.status,
    champion: item.champion || null,
    startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
    completedAt: item.completedAt ? new Date(item.completedAt) : undefined,
    rounds: item.rounds || [],
    roundTimerMinutes: item.roundTimerMinutes,
    checkedInPlayers: item.checkedInPlayers || [],
    topCutSize: item.topCutSize,
    isTopCutPhase: !!item.isTopCutPhase,
    topCutPlayers: item.topCutPlayers || [],
    topCutStartRound: item.topCutStartRound
  }, item.version || 0);
}

function toItem(tournament) {
  const toIso = (value) => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : value;
  };

  // The DynamoDB DocumentClient can't marshal raw Date instances nested
  // inside these arrays (e.g. a match's reportedAt, a registration's
  // submittedAt), only top-level scalar attributes. A JSON round-trip
  // flattens every nested Date to an ISO string in one pass -- the exact
  // same thing JSON.stringify-ing the old SQLite `data` blob column used to
  // do, so nested date fields keep behaving as strings-after-persistence,
  // same as before this migration.
  const flatten = (value) => JSON.parse(JSON.stringify(value));

  return {
    id: tournament._id,
    name: tournament.name,
    game: tournament.game,
    format: tournament.format,
    maxPlayers: tournament.maxPlayers,
    currentPlayers: tournament.currentPlayers || 0,
    players: flatten(tournament.players || []),
    registrations: flatten(tournament.registrations || []),
    description: tournament.description || '',
    createdBy: tournament.createdBy,
    createdAt: toIso(tournament.createdAt) || new Date().toISOString(),
    status: tournament.status,
    champion: tournament.champion || null,
    startedAt: toIso(tournament.startedAt),
    completedAt: toIso(tournament.completedAt),
    rounds: flatten(tournament.rounds || []),
    roundTimerMinutes: tournament.roundTimerMinutes || 0,
    checkedInPlayers: flatten(tournament.checkedInPlayers || []),
    topCutSize: tournament.topCutSize || 0,
    isTopCutPhase: !!tournament.isTopCutPhase,
    topCutPlayers: flatten(tournament.topCutPlayers || []),
    topCutStartRound: tournament.topCutStartRound || null,
    version: (tournament._version || 0) + 1
  };
}

async function persist(tournament) {
  const expectedVersion = tournament._version || 0;
  const item = toItem(tournament);

  try {
    if (expectedVersion === 0) {
      // First save of a brand-new tournament -- nothing to race against yet.
      await getClient().send(new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(id)'
      }));
    } else {
      await getClient().send(new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: 'version = :expected',
        ExpressionAttributeValues: { ':expected': expectedVersion }
      }));
    }
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new TournamentVersionConflictError();
    }
    throw error;
  }

  tournament._version = item.version;
}

async function create({ name, game, format, maxPlayers, description, roundTimerMinutes, topCutSize, createdBy }) {
  const tournament = attachSave({
    _id: generateId(),
    name,
    game,
    format,
    maxPlayers,
    currentPlayers: 0,
    players: [],
    registrations: [],
    description: description || '',
    createdBy,
    createdAt: new Date(),
    status: 'registration',
    champion: null,
    startedAt: undefined,
    completedAt: undefined,
    rounds: [],
    roundTimerMinutes: roundTimerMinutes || 0,
    checkedInPlayers: [],
    topCutSize: topCutSize || 0,
    isTopCutPhase: false,
    topCutPlayers: [],
    topCutStartRound: null
  });
  await persist(tournament);
  return tournament;
}

async function findById(id) {
  if (!id) return null;
  const { Item } = await getClient().send(new GetCommand({ TableName: TABLE, Key: { id } }));
  return itemToTournament(Item);
}

async function deleteById(id) {
  const tournament = await findById(id);
  if (!tournament) return null;
  await getClient().send(new DeleteCommand({ TableName: TABLE, Key: { id } }));
  return tournament;
}

// Used for the public tournament list -- mirrors `.select('-rounds').populate('createdBy',
// 'username').populate('players','username')`.
async function listSummaries() {
  const { Items } = await getClient().send(new ScanCommand({ TableName: TABLE }));
  const tournaments = (Items || []).map(itemToTournament)
    .sort((a, b) => b.createdAt - a.createdAt);

  return Promise.all(tournaments.map(async ({ rounds, createdBy, players, ...rest }) => ({
    ...rest,
    createdBy: userSummaryShape(await usersRepo.findById(createdBy)),
    players: await Promise.all((players || []).map(async (id) => userSummaryShape(await usersRepo.findById(id))))
  })));
}

async function listByCreator(creatorId, { limit } = {}) {
  const { Items } = await getClient().send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'creator-index',
    KeyConditionExpression: 'createdBy = :creatorId',
    ExpressionAttributeValues: { ':creatorId': creatorId },
    ScanIndexForward: false,
    ...(limit ? { Limit: limit } : {})
  }));
  return (Items || []).map(itemToTournament);
}

// No index exists for "tournaments a player has joined" (the old SQLite
// version was also an unindexed full-table scan filtered in JS) -- at hobby-
// app volume (well under a thousand tournaments ever) a Scan with a trimmed
// projection is simpler than adding an inverted membership index, and is no
// worse than the behavior this replaces.
async function listByPlayer(playerId, { limit } = {}) {
  const { Items } = await getClient().send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'contains(players, :playerId)',
    ExpressionAttributeValues: { ':playerId': playerId }
  }));
  const matching = (Items || [])
    .map(itemToTournament)
    .sort((a, b) => b.createdAt - a.createdAt);
  return limit ? matching.slice(0, limit) : matching;
}

async function countByCreator(creatorId) {
  const { Count } = await getClient().send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'creator-index',
    KeyConditionExpression: 'createdBy = :creatorId',
    ExpressionAttributeValues: { ':creatorId': creatorId },
    Select: 'COUNT'
  }));
  return Count || 0;
}

async function countByPlayer(playerId) {
  const tournaments = await listByPlayer(playerId);
  return tournaments.length;
}

// --- Population (replaces Mongoose's .populate(tournamentPopulate)) ---

const userPublicShape = (user) => (user ? {
  _id: user._id,
  username: user.username,
  email: user.email,
  createdAt: user.createdAt
} : null);
const userSummaryShape = (user) => (user ? { _id: user._id, username: user.username } : null);
const decklistPublicShape = (decklist) => (decklist ? {
  _id: decklist._id,
  name: decklist.name,
  game: decklist.game,
  mainDeck: decklist.mainDeck,
  extraDeck: decklist.extraDeck,
  sideDeck: decklist.sideDeck,
  notes: decklist.notes,
  updatedAt: decklist.updatedAt
} : null);

function collectReferencedIds(tournament) {
  const userIds = new Set();
  const decklistIds = new Set();

  const addUser = (id) => { if (id) userIds.add(id); };

  addUser(tournament.createdBy);
  addUser(tournament.champion);
  (tournament.players || []).forEach(addUser);
  (tournament.checkedInPlayers || []).forEach(addUser);
  (tournament.topCutPlayers || []).forEach(addUser);

  (tournament.registrations || []).forEach((registration) => {
    addUser(registration.user);
    if (registration.decklist) decklistIds.add(registration.decklist);
  });

  (tournament.rounds || []).forEach((round) => {
    (round.matches || []).forEach((match) => {
      addUser(match.player1);
      addUser(match.player2);
      addUser(match.winner);
      (match.confirmedBy || []).forEach(addUser);
      addUser(match.disputedBy);
      addUser(match.resolvedBy);
      addUser(match.reportedBy);
      (match.disputeHistory || []).forEach((entry) => {
        addUser(entry.disputedBy);
        addUser(entry.resolvedBy);
      });
    });
  });

  return { userIds: Array.from(userIds), decklistIds: Array.from(decklistIds) };
}

async function buildLookupMaps(userIds, decklistIds) {
  const userMap = new Map();
  await Promise.all(userIds.map(async (id) => {
    const user = await usersRepo.findById(id);
    if (user) userMap.set(id, userPublicShape(user));
  }));

  const decklistMap = new Map();
  await Promise.all(decklistIds.map(async (id) => {
    const decklist = await decklistsRepo.findById(id);
    if (decklist) decklistMap.set(id, decklistPublicShape(decklist));
  }));

  return { userMap, decklistMap };
}

function hydrate(tournament, { userMap, decklistMap }) {
  const u = (id) => (id ? userMap.get(id) || null : null);
  const d = (id) => (id ? decklistMap.get(id) || null : null);

  return {
    ...tournament,
    createdBy: u(tournament.createdBy),
    champion: u(tournament.champion),
    players: (tournament.players || []).map(u),
    // checkedInPlayers/topCutPlayers stay as raw id arrays -- the original Mongoose
    // populate() list never populated these paths either.
    checkedInPlayers: tournament.checkedInPlayers || [],
    topCutPlayers: tournament.topCutPlayers || [],
    registrations: (tournament.registrations || []).map((registration) => ({
      ...registration,
      user: u(registration.user),
      decklist: d(registration.decklist)
    })),
    rounds: (tournament.rounds || []).map((round) => ({
      ...round,
      matches: (round.matches || []).map((match) => ({
        ...match,
        player1: u(match.player1),
        player2: u(match.player2),
        winner: u(match.winner),
        confirmedBy: (match.confirmedBy || []).map(u),
        disputedBy: u(match.disputedBy),
        resolvedBy: u(match.resolvedBy),
        reportedBy: u(match.reportedBy),
        disputeHistory: (match.disputeHistory || []).map((entry) => ({
          ...entry,
          disputedBy: u(entry.disputedBy),
          resolvedBy: u(entry.resolvedBy)
        }))
      }))
    }))
  };
}

async function findByIdHydrated(id) {
  const tournament = await findById(id);
  if (!tournament) return null;
  const { userIds, decklistIds } = collectReferencedIds(tournament);
  const maps = await buildLookupMaps(userIds, decklistIds);
  return hydrate(tournament, maps);
}

module.exports = {
  create,
  findById,
  findByIdHydrated,
  deleteById,
  listSummaries,
  listByCreator,
  listByPlayer,
  countByCreator,
  countByPlayer,
  TournamentVersionConflictError
};
