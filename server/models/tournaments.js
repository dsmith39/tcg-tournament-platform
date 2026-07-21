/*
 * Tournament repository backed by SQLite (replaces the Mongoose Tournament model).
 *
 * Indexed top-level columns (created_by, status, ...) support list/filter
 * queries. The nested rounds/matches/registrations tree -- which every route
 * handler already loads whole, mutates in memory, and saves back whole --
 * is stored as a single JSON column instead of being normalized into child
 * tables, since there is no per-row concurrent-update pattern here.
 *
 * `findById` returns the raw (unpopulated) tournament, matching the old
 * `Tournament.findById(id)` calls used for mutation. `findByIdHydrated`
 * replaces every embedded user/decklist id reference with the looked-up
 * object, matching the old `.populate(tournamentPopulate)` behavior --
 * used only to build response payloads, never for mutation.
 */
const { getDb } = require('../db');
const { generateId } = require('./id');
const usersRepo = require('./users');
const decklistsRepo = require('./decklists');

function attachSave(tournament) {
  Object.defineProperty(tournament, 'save', {
    value: async function save() {
      persist(this);
      return this;
    },
    enumerable: false
  });
  return tournament;
}

function rowToTournament(row) {
  if (!row) return null;
  const data = JSON.parse(row.data || '{}');

  return attachSave({
    _id: row.id,
    name: row.name,
    game: row.game,
    format: row.format,
    maxPlayers: row.max_players,
    currentPlayers: row.current_players,
    players: data.players || [],
    registrations: data.registrations || [],
    description: row.description || '',
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    status: row.status,
    champion: row.champion || null,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    rounds: data.rounds || [],
    roundTimerMinutes: row.round_timer_minutes,
    checkedInPlayers: data.checkedInPlayers || [],
    topCutSize: row.top_cut_size,
    isTopCutPhase: !!row.is_top_cut_phase,
    topCutPlayers: data.topCutPlayers || [],
    topCutStartRound: row.top_cut_start_round
  });
}

function persist(tournament) {
  const data = JSON.stringify({
    players: tournament.players || [],
    registrations: tournament.registrations || [],
    rounds: tournament.rounds || [],
    checkedInPlayers: tournament.checkedInPlayers || [],
    topCutPlayers: tournament.topCutPlayers || []
  });

  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO tournaments (
      id, name, game, format, max_players, current_players, description,
      created_by, status, champion, created_at, started_at, completed_at,
      round_timer_minutes, top_cut_size, is_top_cut_phase, top_cut_start_round, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const toIso = (value) => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : value;
  };

  stmt.run(
    tournament._id,
    tournament.name,
    tournament.game,
    tournament.format,
    tournament.maxPlayers,
    tournament.currentPlayers || 0,
    tournament.description || '',
    tournament.createdBy,
    tournament.status,
    tournament.champion || null,
    toIso(tournament.createdAt) || new Date().toISOString(),
    toIso(tournament.startedAt),
    toIso(tournament.completedAt),
    tournament.roundTimerMinutes || 0,
    tournament.topCutSize || 0,
    tournament.isTopCutPhase ? 1 : 0,
    tournament.topCutStartRound || null,
    data
  );
}

function create({ name, game, format, maxPlayers, description, roundTimerMinutes, topCutSize, createdBy }) {
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
  persist(tournament);
  return tournament;
}

function findById(id) {
  const row = getDb().prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
  return rowToTournament(row);
}

function deleteById(id) {
  const tournament = findById(id);
  if (!tournament) return null;
  getDb().prepare('DELETE FROM tournaments WHERE id = ?').run(id);
  return tournament;
}

// Used for the public tournament list -- mirrors `.select('-rounds').populate('createdBy',
// 'username').populate('players','username')`.
function listSummaries() {
  const rows = getDb().prepare('SELECT * FROM tournaments ORDER BY created_at DESC').all();
  return rows.map(rowToTournament).map(({ rounds, createdBy, players, ...rest }) => ({
    ...rest,
    createdBy: userSummaryShape(usersRepo.findById(createdBy)),
    players: (players || []).map((id) => userSummaryShape(usersRepo.findById(id)))
  }));
}

function listByCreator(creatorId, { limit } = {}) {
  const rows = getDb()
    .prepare(`SELECT * FROM tournaments WHERE created_by = ? ORDER BY created_at DESC${limit ? ' LIMIT ?' : ''}`)
    .all(...(limit ? [creatorId, limit] : [creatorId]));
  return rows.map(rowToTournament);
}

function listByPlayer(playerId, { limit } = {}) {
  const rows = getDb().prepare('SELECT * FROM tournaments').all();
  const matching = rows
    .map(rowToTournament)
    .filter((t) => t.players.includes(playerId))
    .sort((a, b) => b.createdAt - a.createdAt);
  return limit ? matching.slice(0, limit) : matching;
}

function countByCreator(creatorId) {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM tournaments WHERE created_by = ?').get(creatorId);
  return row.count;
}

function countByPlayer(playerId) {
  return listByPlayer(playerId).length;
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

function buildLookupMaps(userIds, decklistIds) {
  const userMap = new Map();
  userIds.forEach((id) => {
    const user = usersRepo.findById(id);
    if (user) userMap.set(id, userPublicShape(user));
  });

  const decklistMap = new Map();
  decklistIds.forEach((id) => {
    const decklist = decklistsRepo.findById(id);
    if (decklist) decklistMap.set(id, decklistPublicShape(decklist));
  });

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

function findByIdHydrated(id) {
  const tournament = findById(id);
  if (!tournament) return null;
  const { userIds, decklistIds } = collectReferencedIds(tournament);
  const maps = buildLookupMaps(userIds, decklistIds);
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
  countByPlayer
};
