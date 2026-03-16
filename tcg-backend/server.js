const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  bio: { type: String, default: '', maxlength: 500 },
  location: { type: String, default: '', maxlength: 100 },
  favoriteGame: { type: String, default: '', maxlength: 60 },
  favoriteDeck: { type: String, default: '', maxlength: 120 },
  website: { type: String, default: '', maxlength: 120 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const gameEnum = ['ygo-tcg', 'master-duel', 'duel-links'];

// Decklist Schema
const decklistSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  game: {
    type: String,
    enum: gameEnum,
    required: true
  },
  mainDeck: { type: String, required: true, trim: true, maxlength: 12000 },
  extraDeck: { type: String, default: '', trim: true, maxlength: 6000 },
  sideDeck: { type: String, default: '', trim: true, maxlength: 6000 },
  isPublic: { type: Boolean, default: true },
  notes: { type: String, default: '', trim: true, maxlength: 1000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

decklistSchema.pre('save', function updateDecklistTimestamp() {
  this.updatedAt = new Date();
});

const Decklist = mongoose.model('Decklist', decklistSchema);

// Match + Round sub-schemas
const disputeHistorySchema = new mongoose.Schema({
  reason: { type: String, default: null },
  disputedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  disputedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['open', 'resolved', 'reopened'], default: 'open' },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: { type: Date, default: null },
  resolutionNote: { type: String, default: null },
  resolvedResult: { type: String, enum: ['player1', 'player2', 'draw', null], default: null }
}, { _id: true });

const matchSchema = new mongoose.Schema({
  tableNumber: { type: Number, required: true },
  player1: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  player2: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  bracket: {
    type: String,
    enum: ['swiss', 'single', 'winners', 'losers', 'grand-final'],
    default: null
  },
  result: {
    type: String,
    enum: ['pending', 'player1', 'player2', 'draw', 'bye'],
    default: 'pending'
  },
  resultStatus: {
    type: String,
    enum: ['pending', 'awaiting-confirmation', 'confirmed', 'disputed'],
    default: 'pending'
  },
  winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  confirmedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  disputeReason: { type: String, default: null },
  disputedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  disputedAt: { type: Date, default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: { type: Date, default: null },
  resolutionNote: { type: String, default: null },
  disputeHistory: [disputeHistorySchema],
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reportedAt: { type: Date, default: null }
}, { _id: true });

const roundSchema = new mongoose.Schema({
  number: { type: Number, required: true },
  status: {
    type: String,
    enum: ['not_started', 'active', 'locked', 'completed'],
    default: 'not_started'
  },
  matches: [matchSchema],
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null }
}, { _id: true });

const registrationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  decklist: { type: mongoose.Schema.Types.ObjectId, ref: 'Decklist', default: null },
  deckName: { type: String, default: '' },
  deckGame: { type: String, enum: [...gameEnum, null], default: null },
  submittedAt: { type: Date, default: Date.now }
}, { _id: true });

// Tournament Schema
const tournamentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  game: {
    type: String,
    enum: gameEnum,
    required: true
  },
  format: {
    type: String,
    enum: ['swiss', 'single-elim', 'double-elim'],
    required: true
  },
  maxPlayers: { type: Number, required: true },
  currentPlayers: { type: Number, default: 0 },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  registrations: [registrationSchema],
  description: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ['registration', 'active', 'completed'],
    default: 'registration'
  },
  champion: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  startedAt: Date,
  completedAt: Date,
  rounds: [roundSchema]
});
const Tournament = mongoose.model('Tournament', tournamentSchema);

const toIdString = (value) => (value ? value.toString() : null);

const shuffleArray = (items) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const tournamentPopulate = [
  { path: 'createdBy', select: 'username email' },
  { path: 'players', select: 'username email createdAt' },
  { path: 'registrations.user', select: 'username email' },
  { path: 'registrations.decklist', select: 'name game mainDeck extraDeck sideDeck notes updatedAt' },
  { path: 'champion', select: 'username email' },
  { path: 'rounds.matches.player1', select: 'username email' },
  { path: 'rounds.matches.player2', select: 'username email' },
  { path: 'rounds.matches.winner', select: 'username email' },
  { path: 'rounds.matches.confirmedBy', select: 'username email' },
  { path: 'rounds.matches.disputedBy', select: 'username email' },
  { path: 'rounds.matches.resolvedBy', select: 'username email' },
  { path: 'rounds.matches.disputeHistory.disputedBy', select: 'username email' },
  { path: 'rounds.matches.disputeHistory.resolvedBy', select: 'username email' },
  { path: 'rounds.matches.reportedBy', select: 'username email' }
];

const getTournamentByIdWithDetails = async (id) => (
  Tournament.findById(id).populate(tournamentPopulate)
);

const calculateRecommendedSwissRounds = (playerCount) => {
  const rounds = Math.ceil(Math.log2(Math.max(playerCount, 2)));
  return Math.max(rounds, 3);
};

const isEliminationFormat = (format) => format === 'single-elim' || format === 'double-elim';

const getMatchResultStatus = (match) => {
  if (match.resultStatus) return match.resultStatus;
  return match.result === 'pending' ? 'pending' : 'confirmed';
};

const isMatchDisputed = (match) => getMatchResultStatus(match) === 'disputed';

const isMatchFinal = (match) => {
  if (match.result === 'bye') return true;
  return getMatchResultStatus(match) === 'confirmed';
};

const isRoundLocked = (round) => ['locked', 'completed'].includes(round.status);

const isRoundActive = (round) => round.status === 'active';

const canRoundBeLocked = (round) => round.matches.every((match) => isMatchFinal(match));

const markRoundStatusFromMatches = (round) => {
  if (!isRoundActive(round)) {
    return canRoundBeLocked(round);
  }

  const allFinal = canRoundBeLocked(round);
  if (!allFinal) {
    round.completedAt = null;
  }

  return allFinal;
};

const getPreviousOpponentMap = (tournament) => {
  const previousOpponents = new Map();

  tournament.players.forEach((player) => {
    const playerId = toIdString(player._id || player);
    previousOpponents.set(playerId, new Set());
  });

  tournament.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      const player1Id = toIdString(match.player1?._id || match.player1);
      const player2Id = toIdString(match.player2?._id || match.player2);

      if (!player1Id || !player2Id) return;

      if (!previousOpponents.has(player1Id)) {
        previousOpponents.set(player1Id, new Set());
      }
      if (!previousOpponents.has(player2Id)) {
        previousOpponents.set(player2Id, new Set());
      }

      previousOpponents.get(player1Id).add(player2Id);
      previousOpponents.get(player2Id).add(player1Id);
    });
  });

  return previousOpponents;
};

const calculateStandings = (tournament) => {
  const standingsByPlayerId = new Map();

  tournament.players.forEach((player, index) => {
    const playerId = toIdString(player._id || player);
    standingsByPlayerId.set(playerId, {
      playerId,
      username: player.username || `Player ${index + 1}`,
      email: player.email || null,
      points: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      byes: 0,
      matchesPlayed: 0,
      opponents: new Set(),
      matchWinPct: 0,
      opponentMatchWinPct: 0
    });
  });

  const ensureStanding = (playerId) => {
    if (!standingsByPlayerId.has(playerId)) {
      standingsByPlayerId.set(playerId, {
        playerId,
        username: 'Unknown Player',
        email: null,
        points: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        byes: 0,
        matchesPlayed: 0,
        opponents: new Set(),
        matchWinPct: 0,
        opponentMatchWinPct: 0
      });
    }
    return standingsByPlayerId.get(playerId);
  };

  tournament.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      if (!isMatchFinal(match)) return;

      const player1Id = toIdString(match.player1?._id || match.player1);
      const player2Id = toIdString(match.player2?._id || match.player2);

      if (!player1Id) return;

      const player1Standing = ensureStanding(player1Id);

      if (match.result === 'bye') {
        player1Standing.points += 3;
        player1Standing.wins += 1;
        player1Standing.byes += 1;
        player1Standing.matchesPlayed += 1;
        return;
      }

      if (!player2Id) return;

      const player2Standing = ensureStanding(player2Id);
      player1Standing.opponents.add(player2Id);
      player2Standing.opponents.add(player1Id);

      player1Standing.matchesPlayed += 1;
      player2Standing.matchesPlayed += 1;

      if (match.result === 'draw') {
        player1Standing.points += 1;
        player2Standing.points += 1;
        player1Standing.draws += 1;
        player2Standing.draws += 1;
        return;
      }

      if (match.result === 'player1') {
        player1Standing.points += 3;
        player1Standing.wins += 1;
        player2Standing.losses += 1;
        return;
      }

      if (match.result === 'player2') {
        player2Standing.points += 3;
        player2Standing.wins += 1;
        player1Standing.losses += 1;
      }
    });
  });

  standingsByPlayerId.forEach((standing) => {
    const denominator = standing.matchesPlayed * 3;
    standing.matchWinPct = denominator > 0 ? standing.points / denominator : 0;
  });

  standingsByPlayerId.forEach((standing) => {
    const opponentIds = Array.from(standing.opponents);
    if (opponentIds.length === 0) {
      standing.opponentMatchWinPct = 0;
      return;
    }

    const totalOpponentPct = opponentIds.reduce((sum, opponentId) => {
      const opponent = standingsByPlayerId.get(opponentId);
      return sum + (opponent ? opponent.matchWinPct : 0);
    }, 0);

    standing.opponentMatchWinPct = totalOpponentPct / opponentIds.length;
  });

  const standings = Array.from(standingsByPlayerId.values())
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.opponentMatchWinPct !== a.opponentMatchWinPct) {
        return b.opponentMatchWinPct - a.opponentMatchWinPct;
      }
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.draws !== a.draws) return b.draws - a.draws;
      return a.username.localeCompare(b.username);
    })
    .map((standing, index) => ({
      rank: index + 1,
      playerId: standing.playerId,
      username: standing.username,
      email: standing.email,
      points: standing.points,
      wins: standing.wins,
      losses: standing.losses,
      draws: standing.draws,
      byes: standing.byes,
      matchesPlayed: standing.matchesPlayed,
      matchWinPct: Number(standing.matchWinPct.toFixed(3)),
      opponentMatchWinPct: Number(standing.opponentMatchWinPct.toFixed(3))
    }));

  return standings;
};

const calculatePlayerRecords = (tournament) => {
  const records = new Map();

  tournament.players.forEach((player) => {
    records.set(toIdString(player._id || player), {
      wins: 0,
      losses: 0,
      draws: 0,
      byes: 0
    });
  });

  const ensureRecord = (playerId) => {
    if (!records.has(playerId)) {
      records.set(playerId, {
        wins: 0,
        losses: 0,
        draws: 0,
        byes: 0
      });
    }
    return records.get(playerId);
  };

  tournament.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      if (!isMatchFinal(match)) return;

      const player1Id = toIdString(match.player1?._id || match.player1);
      const player2Id = toIdString(match.player2?._id || match.player2);

      if (!player1Id) return;

      const player1Record = ensureRecord(player1Id);

      if (match.result === 'bye') {
        player1Record.wins += 1;
        player1Record.byes += 1;
        return;
      }

      if (!player2Id) return;

      const player2Record = ensureRecord(player2Id);

      if (match.result === 'draw') {
        player1Record.draws += 1;
        player2Record.draws += 1;
        return;
      }

      if (match.result === 'player1') {
        player1Record.wins += 1;
        player2Record.losses += 1;
        return;
      }

      if (match.result === 'player2') {
        player2Record.wins += 1;
        player1Record.losses += 1;
      }
    });
  });

  return records;
};

const getRemainingPlayersByFormat = (tournament, records) => {
  const players = tournament.players.map((player) => toIdString(player._id || player));

  if (tournament.format === 'single-elim') {
    return players.filter((playerId) => (records.get(playerId)?.losses || 0) < 1).length;
  }

  if (tournament.format === 'double-elim') {
    return players.filter((playerId) => (records.get(playerId)?.losses || 0) < 2).length;
  }

  return players.length;
};

const shouldAutoCompleteTournament = (tournament, records) => {
  if (!isEliminationFormat(tournament.format)) return false;
  if (tournament.rounds.length === 0) return false;
  return getRemainingPlayersByFormat(tournament, records) <= 1;
};

const getChampionId = (tournament, records, standings = []) => {
  if (tournament.rounds.length === 0) return null;

  if (tournament.format === 'single-elim') {
    const finalists = tournament.players
      .map((player) => toIdString(player._id || player))
      .filter((playerId) => (records.get(playerId)?.losses || 0) < 1);

    return finalists.length === 1 ? finalists[0] : null;
  }

  if (tournament.format === 'double-elim') {
    const finalists = tournament.players
      .map((player) => toIdString(player._id || player))
      .filter((playerId) => (records.get(playerId)?.losses || 0) < 2);

    return finalists.length === 1 ? finalists[0] : null;
  }

  if (tournament.format === 'swiss') {
    const minimumRounds = calculateRecommendedSwissRounds(tournament.players.length);
    if (tournament.rounds.length < minimumRounds) return null;
    return standings[0]?.playerId || null;
  }

  return null;
};

const buildSequentialPairings = (playerIds, startingTableNumber = 1, bracket = 'single') => {
  const ordered = [...playerIds];
  const matches = [];
  let tableNumber = startingTableNumber;

  while (ordered.length > 1) {
    const player1Id = ordered.shift();
    const player2Id = ordered.shift();

    matches.push({
      tableNumber,
      player1: player1Id,
      player2: player2Id,
      bracket,
      result: 'pending',
      resultStatus: 'pending',
      confirmedBy: []
    });

    tableNumber += 1;
  }

  if (ordered.length === 1) {
    const byePlayerId = ordered.shift();
    matches.push({
      tableNumber,
      player1: byePlayerId,
      player2: null,
      bracket,
      result: 'bye',
      resultStatus: 'confirmed',
      winner: byePlayerId,
      confirmedBy: [byePlayerId],
      reportedAt: new Date()
    });
    tableNumber += 1;
  }

  return { matches, nextTableNumber: tableNumber };
};

const buildSingleEliminationRound = (tournament, records) => {
  const activePlayers = tournament.players
    .map((player) => toIdString(player._id || player))
    .filter((playerId) => (records.get(playerId)?.losses || 0) < 1)
    .sort((a, b) => (records.get(b)?.wins || 0) - (records.get(a)?.wins || 0));

  if (activePlayers.length <= 1) return null;

  const { matches } = buildSequentialPairings(activePlayers, 1, 'single');

  return {
    number: tournament.rounds.length + 1,
    status: 'not_started',
    matches,
    createdAt: new Date(),
    completedAt: null
  };
};

const buildDoubleEliminationRound = (tournament, records) => {
  const activePlayers = tournament.players
    .map((player) => toIdString(player._id || player))
    .filter((playerId) => (records.get(playerId)?.losses || 0) < 2);

  if (activePlayers.length <= 1) return null;

  const undefeatedPlayers = activePlayers
    .filter((playerId) => (records.get(playerId)?.losses || 0) === 0)
    .sort((a, b) => (records.get(b)?.wins || 0) - (records.get(a)?.wins || 0));

  const oneLossPlayers = activePlayers
    .filter((playerId) => (records.get(playerId)?.losses || 0) === 1)
    .sort((a, b) => (records.get(b)?.wins || 0) - (records.get(a)?.wins || 0));

  const matches = [];
  let tableNumber = 1;

  // Final stage: one undefeated player faces one one-loss player.
  if (activePlayers.length === 2 && undefeatedPlayers.length === 1 && oneLossPlayers.length === 1) {
    matches.push({
      tableNumber,
      player1: undefeatedPlayers[0],
      player2: oneLossPlayers[0],
      bracket: 'grand-final',
      result: 'pending',
      resultStatus: 'pending',
      confirmedBy: []
    });
  } else {
    const undefeatedPairings = buildSequentialPairings(undefeatedPlayers, tableNumber, 'winners');
    matches.push(...undefeatedPairings.matches);
    tableNumber = undefeatedPairings.nextTableNumber;

    const oneLossPairings = buildSequentialPairings(oneLossPlayers, tableNumber, 'losers');
    matches.push(...oneLossPairings.matches);
  }

  if (matches.length === 0) return null;

  return {
    number: tournament.rounds.length + 1,
    status: 'not_started',
    matches,
    createdAt: new Date(),
    completedAt: null
  };
};

const buildNextRoundForFormat = (tournament, standings, records) => {
  if (tournament.format === 'swiss') {
    return buildSwissRound(tournament, standings);
  }

  if (tournament.format === 'single-elim') {
    return buildSingleEliminationRound(tournament, records);
  }

  if (tournament.format === 'double-elim') {
    return buildDoubleEliminationRound(tournament, records);
  }

  return null;
};

const buildSwissRound = (tournament, standings) => {
  const allPlayerIds = tournament.players.map((player) => toIdString(player._id || player));
  const standingsByPlayerId = new Map(standings.map((entry) => [entry.playerId, entry]));

  let orderedPlayers = standings.length > 0
    ? standings.map((entry) => entry.playerId).filter((playerId) => allPlayerIds.includes(playerId))
    : shuffleArray([...allPlayerIds]);

  const previousOpponents = getPreviousOpponentMap(tournament);
  const matches = [];

  if (orderedPlayers.length % 2 === 1) {
    const byeCandidates = [...orderedPlayers].reverse();
    const byePlayerId = byeCandidates.find(
      (playerId) => (standingsByPlayerId.get(playerId)?.byes || 0) === 0
    ) || byeCandidates[0];

    orderedPlayers = orderedPlayers.filter((playerId) => playerId !== byePlayerId);

    matches.push({
      tableNumber: 1,
      player1: byePlayerId,
      player2: null,
      bracket: 'swiss',
      result: 'bye',
      resultStatus: 'confirmed',
      winner: byePlayerId,
      confirmedBy: [byePlayerId],
      reportedAt: new Date()
    });
  }

  while (orderedPlayers.length > 1) {
    const player1Id = orderedPlayers.shift();
    let opponentIndex = orderedPlayers.findIndex(
      (candidateId) => !previousOpponents.get(player1Id)?.has(candidateId)
    );

    if (opponentIndex === -1) {
      opponentIndex = 0;
    }

    const [player2Id] = orderedPlayers.splice(opponentIndex, 1);

    matches.push({
      tableNumber: matches.length + 1,
      player1: player1Id,
      player2: player2Id,
      bracket: 'swiss',
      result: 'pending',
      resultStatus: 'pending',
      confirmedBy: []
    });
  }

  return {
    number: tournament.rounds.length + 1,
    status: 'not_started',
    matches,
    createdAt: new Date(),
    completedAt: null
  };
};

const buildTournamentResponse = (tournament) => {
  const standings = calculateStandings(tournament);
  const records = calculatePlayerRecords(tournament);
  const championId = toIdString(tournament.champion?._id || tournament.champion) || getChampionId(tournament, records, standings);
  const roundsPlayed = tournament.rounds.length;
  const hasActiveRound = tournament.rounds.some((round) => isRoundActive(round));
  const hasPendingRound = tournament.rounds.some((round) => round.status === 'not_started');
  const activeRound = tournament.rounds.find((round) => isRoundActive(round));
  const pendingRound = tournament.rounds.find((round) => round.status === 'not_started');
  const latestRound = roundsPlayed > 0 ? tournament.rounds[roundsPlayed - 1] : null;
  const unresolvedMatchCount = tournament.rounds.reduce(
    (total, round) => total + round.matches.filter((match) => !isMatchFinal(match)).length,
    0
  );
  const disputedMatchCount = tournament.rounds.reduce(
    (total, round) => total + round.matches.filter((match) => isMatchDisputed(match)).length,
    0
  );
  const isConcluded = shouldAutoCompleteTournament(tournament, records);
  const canLockActiveRound = !!activeRound && canRoundBeLocked(activeRound);
  const canGenerateNextRound = tournament.status === 'active'
    && !hasActiveRound
    && !hasPendingRound
    && !isConcluded
    && unresolvedMatchCount === 0
    && !!latestRound
    && isRoundLocked(latestRound)
    && roundsPlayed > 0;
  const canCompleteNow = !!championId && !!latestRound && isRoundLocked(latestRound);

  return {
    ...tournament.toObject(),
    standings,
    roundMeta: {
      roundsPlayed,
      recommendedSwissRounds: tournament.format === 'swiss'
        ? calculateRecommendedSwissRounds(tournament.players.length)
        : null,
      remainingPlayers: getRemainingPlayersByFormat(tournament, records),
      championId,
      canCompleteNow,
      activeRoundId: activeRound ? toIdString(activeRound._id) : null,
      pendingRoundId: pendingRound ? toIdString(pendingRound._id) : null,
      hasPendingRound,
      canStartPendingRound: tournament.status === 'active' && !hasActiveRound && !!pendingRound,
      canLockActiveRound,
      canGenerateNextRound,
      unresolvedMatchCount,
      disputedMatchCount,
      isConcluded
    }
  };
};

const getMatchLocation = (tournament, matchId) => {
  let targetRound = null;
  let targetMatch = null;

  tournament.rounds.forEach((round) => {
    if (targetMatch) return;
    const foundMatch = round.matches.id(matchId);
    if (foundMatch) {
      targetRound = round;
      targetMatch = foundMatch;
    }
  });

  return { targetRound, targetMatch };
};

const canUserManageMatch = (match, organizerId, userId) => {
  const player1Id = toIdString(match.player1);
  const player2Id = toIdString(match.player2);
  return userId === organizerId || userId === player1Id || userId === player2Id;
};

const getOpenDisputeHistoryEntry = (match) => {
  const history = match.disputeHistory || [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].status === 'open') return history[i];
  }
  return null;
};

const closeDisputeHistoryEntry = (entry, status, userId, note = null, resolvedResult = null) => {
  if (!entry) return;
  entry.status = status;
  entry.resolvedBy = userId;
  entry.resolvedAt = new Date();
  entry.resolutionNote = note ? String(note).trim().slice(0, 500) : null;
  entry.resolvedResult = resolvedResult;
};

const buildUserMatchStats = async (userId) => {
  const joinedTournaments = await Tournament.find({ players: userId })
    .select('name createdAt champion rounds.matches.player1 rounds.matches.player2 rounds.matches.result rounds.matches.resultStatus rounds.matches.reportedAt');

  let wins = 0;
  let losses = 0;
  let draws = 0;
  let byes = 0;
  let matchesPlayed = 0;
  let championships = 0;
  const recentMatches = [];

  joinedTournaments.forEach((tournament) => {
    if (toIdString(tournament.champion) === userId) {
      championships += 1;
    }

    (tournament.rounds || []).forEach((round) => {
      (round.matches || []).forEach((match) => {
        if (!isMatchFinal(match)) return;

        const player1Id = toIdString(match.player1?._id || match.player1);
        const player2Id = toIdString(match.player2?._id || match.player2);
        const isP1 = player1Id === userId;
        const isP2 = player2Id === userId;
        if (!isP1 && !isP2) return;

        let outcome = 'draw';

        if (match.result === 'bye' && isP1) {
          wins += 1;
          byes += 1;
          matchesPlayed += 1;
          outcome = 'bye';
        } else if (match.result === 'draw') {
          draws += 1;
          matchesPlayed += 1;
          outcome = 'draw';
        } else if ((match.result === 'player1' && isP1) || (match.result === 'player2' && isP2)) {
          wins += 1;
          matchesPlayed += 1;
          outcome = 'win';
        } else {
          losses += 1;
          matchesPlayed += 1;
          outcome = 'loss';
        }

        recentMatches.push({
          tournamentId: tournament._id,
          tournamentName: tournament.name,
          outcome,
          reportedAt: match.reportedAt || tournament.createdAt || new Date()
        });
      });
    });
  });

  recentMatches.sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt));

  return {
    wins,
    losses,
    draws,
    byes,
    matchesPlayed,
    winRate: matchesPlayed > 0 ? Number(((wins / matchesPlayed) * 100).toFixed(1)) : 0,
    championships,
    recentMatches: recentMatches.slice(0, 10)
  };
};

const buildUserProfileResponse = async (user) => {
  const userId = toIdString(user._id);

  const [createdTournaments, joinedTournaments, createdCount, joinedCount, matchStats] = await Promise.all([
    Tournament.find({ createdBy: userId })
      .select('name game format status createdAt')
      .sort({ createdAt: -1 })
      .limit(8),
    Tournament.find({ players: userId })
      .select('name game format status createdAt')
      .sort({ createdAt: -1 })
      .limit(8),
    Tournament.countDocuments({ createdBy: userId }),
    Tournament.countDocuments({ players: userId }),
    buildUserMatchStats(userId)
  ]);

  return {
    _id: user._id,
    username: user.username,
    email: user.email,
    bio: user.bio || '',
    location: user.location || '',
    favoriteGame: user.favoriteGame || '',
    favoriteDeck: user.favoriteDeck || '',
    website: user.website || '',
    createdAt: user.createdAt,
    stats: {
      createdCount,
      joinedCount,
      matchesPlayed: matchStats.matchesPlayed,
      wins: matchStats.wins,
      losses: matchStats.losses,
      draws: matchStats.draws,
      byes: matchStats.byes,
      winRate: matchStats.winRate,
      championships: matchStats.championships
    },
    recentCreatedTournaments: createdTournaments,
    recentJoinedTournaments: joinedTournaments,
    recentMatches: matchStats.recentMatches
  };
};

// JWT middleware
const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const getOptionalUserIdFromAuthHeader = (req) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.id || null;
  } catch (error) {
    return null;
  }
};

const emitTournamentUpdate = (reason, tournament) => {
  if (!tournament) return;

  const tournamentId = toIdString(tournament._id || tournament.id);
  io.emit('tournaments:updated', {
    reason,
    tournamentId,
    name: tournament.name || 'Tournament',
    status: tournament.status || 'registration'
  });
};

const emitDecklistUpdate = (reason, decklist) => {
  if (!decklist) return;

  const decklistId = toIdString(decklist._id || decklist.id);
  const ownerId = toIdString(decklist.owner?._id || decklist.owner);
  io.emit('decklists:updated', {
    reason,
    decklistId,
    ownerId,
    isPublic: decklist.isPublic !== false,
    name: decklist.name || 'Decklist'
  });
};

io.on('connection', (socket) => {
  socket.emit('socket:ready', { connectedAt: Date.now() });
});

// Routes
// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      username,
      email,
      password: hashedPassword
    });

    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: { id: user._id, username, email } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: { id: user._id, username: user.username, email } });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  res.json(user);
});

// Update current user's public profile
app.patch('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const sanitizeField = (value, maxLength) => {
      if (typeof value !== 'string') return null;
      return value.trim().slice(0, maxLength);
    };

    const updatableFields = {
      bio: 500,
      location: 100,
      favoriteGame: 60,
      favoriteDeck: 120,
      website: 120
    };

    Object.entries(updatableFields).forEach(([field, maxLength]) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        const sanitized = sanitizeField(req.body[field], maxLength);
        if (sanitized !== null) {
          user[field] = sanitized;
        }
      }
    });

    await user.save();
    const profile = await buildUserProfileResponse(user);
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Public user profile for user portal pages
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const profile = await buildUserProfileResponse(user);
    res.json(profile);
  } catch (error) {
    res.status(404).json({ error: 'User not found' });
  }
});

// Public recent decklists (visible to non-users)
app.get('/api/decklists/recent', async (req, res) => {
  try {
    const decklists = await Decklist.find({
      $or: [{ isPublic: true }, { isPublic: { $exists: false } }]
    })
      .select('name game mainDeck extraDeck sideDeck notes createdAt updatedAt owner isPublic')
      .populate('owner', 'username')
      .sort({ createdAt: -1 })
      .limit(10);

    res.json(decklists);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single decklist (public or owner)
app.get('/api/decklists/:id', async (req, res) => {
  try {
    const decklist = await Decklist.findById(req.params.id)
      .populate('owner', 'username');

    if (!decklist) return res.status(404).json({ error: 'Decklist not found' });

    const requesterId = getOptionalUserIdFromAuthHeader(req);
    const ownerId = toIdString(decklist.owner?._id || decklist.owner);
    const isOwner = requesterId && requesterId === ownerId;
    const isPublic = decklist.isPublic !== false;

    if (!isPublic && !isOwner) {
      return res.status(403).json({ error: 'This decklist is private' });
    }

    res.json(decklist);
  } catch (error) {
    res.status(404).json({ error: 'Decklist not found' });
  }
});

// Get authenticated user's decklists
app.get('/api/decklists', authMiddleware, async (req, res) => {
  try {
    const decklists = await Decklist.find({ owner: req.user.id })
      .sort({ updatedAt: -1, createdAt: -1 });
    res.json(decklists);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create decklist
app.post('/api/decklists', authMiddleware, async (req, res) => {
  try {
    const {
      name,
      game,
      mainDeck = '',
      extraDeck = '',
      sideDeck = '',
      isPublic = true,
      notes = ''
    } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Decklist name is required' });
    }

    if (!gameEnum.includes(game)) {
      return res.status(400).json({ error: 'Invalid game format' });
    }

    if (!mainDeck || typeof mainDeck !== 'string' || !mainDeck.trim()) {
      return res.status(400).json({ error: 'Main deck content is required' });
    }

    const decklist = await Decklist.create({
      owner: req.user.id,
      name: name.trim(),
      game,
      mainDeck: mainDeck.trim(),
      extraDeck: typeof extraDeck === 'string' ? extraDeck.trim() : '',
      sideDeck: typeof sideDeck === 'string' ? sideDeck.trim() : '',
      isPublic: typeof isPublic === 'boolean' ? isPublic : true,
      notes: typeof notes === 'string' ? notes.trim() : ''
    });

    emitDecklistUpdate('created', decklist);
    res.status(201).json(decklist);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update decklist
app.patch('/api/decklists/:id', authMiddleware, async (req, res) => {
  try {
    const decklist = await Decklist.findOne({ _id: req.params.id, owner: req.user.id });
    if (!decklist) return res.status(404).json({ error: 'Decklist not found' });

    const updatableFields = ['name', 'game', 'mainDeck', 'extraDeck', 'sideDeck', 'notes'];

    if (Object.prototype.hasOwnProperty.call(req.body, 'isPublic') && typeof req.body.isPublic === 'boolean') {
      decklist.isPublic = req.body.isPublic;
    }

    updatableFields.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) return;
      if (typeof req.body[field] !== 'string') return;

      if (field === 'game') {
        if (gameEnum.includes(req.body[field])) {
          decklist.game = req.body[field];
        }
        return;
      }

      decklist[field] = req.body[field].trim();
    });

    if (!decklist.name) {
      return res.status(400).json({ error: 'Decklist name is required' });
    }

    if (!decklist.mainDeck) {
      return res.status(400).json({ error: 'Main deck content is required' });
    }

    await decklist.save();
    emitDecklistUpdate('updated', decklist);
    res.json(decklist);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete decklist
app.delete('/api/decklists/:id', authMiddleware, async (req, res) => {
  try {
    const decklist = await Decklist.findOneAndDelete({ _id: req.params.id, owner: req.user.id });
    if (!decklist) return res.status(404).json({ error: 'Decklist not found' });
    emitDecklistUpdate('deleted', decklist);
    res.json({ message: 'Decklist deleted' });
  } catch (error) {
    res.status(400).json({ error: 'Invalid decklist id' });
  }
});

// Get all tournaments
app.get('/api/tournaments', async (req, res) => {
  try {
    const tournaments = await Tournament.find()
      .select('-rounds')
      .populate('createdBy', 'username')
      .populate('players', 'username')
      .sort({ createdAt: -1 });

    res.json(tournaments);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create tournament
app.post('/api/tournaments', authMiddleware, async (req, res) => {
  try {
    const tournament = new Tournament({
      ...req.body,
      createdBy: req.user.id,
      players: [],
      registrations: [],
      champion: null,
      rounds: [],
      status: 'registration'
    });

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('created', populated);
    res.status(201).json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get single tournament
app.get('/api/tournaments/:id', async (req, res) => {
  try {
    const tournament = await getTournamentByIdWithDetails(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    res.json(buildTournamentResponse(tournament));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete tournament (only creator)
app.delete('/api/tournaments/:id', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    if (tournament.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await Tournament.findByIdAndDelete(req.params.id);
    emitTournamentUpdate('deleted', tournament);
    res.json({ message: 'Tournament deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Join tournament
app.patch('/api/tournaments/:id/join', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    const { decklistId } = req.body || {};

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.status !== 'registration') {
      return res.status(400).json({ error: 'Tournament is not accepting players' });
    }

    const hasJoined = tournament.players.some((playerId) => toIdString(playerId) === req.user.id);
    if (hasJoined) {
      return res.status(400).json({ error: 'You have already joined this tournament' });
    }

    if (tournament.currentPlayers >= tournament.maxPlayers) {
      return res.status(400).json({ error: 'Tournament is full' });
    }

    if (!decklistId) {
      return res.status(400).json({ error: 'Please select a decklist before joining this tournament' });
    }

    const decklist = await Decklist.findOne({ _id: decklistId, owner: req.user.id });
    if (!decklist) {
      return res.status(400).json({ error: 'Selected decklist was not found' });
    }

    if (decklist.game !== tournament.game) {
      return res.status(400).json({ error: 'Selected decklist does not match this tournament game format' });
    }

    tournament.players.push(req.user.id);
    tournament.registrations.push({
      user: req.user.id,
      decklist: decklist._id,
      deckName: decklist.name,
      deckGame: decklist.game,
      submittedAt: new Date()
    });
    tournament.currentPlayers = tournament.players.length;
    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('joined', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Leave tournament
app.patch('/api/tournaments/:id/leave', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.status !== 'registration') {
      return res.status(400).json({ error: 'Cannot leave tournament after it has started' });
    }

    const hasJoined = tournament.players.some((playerId) => toIdString(playerId) === req.user.id);
    if (!hasJoined) {
      return res.status(400).json({ error: 'You are not in this tournament' });
    }

    tournament.players = tournament.players.filter(
      (playerId) => toIdString(playerId) !== req.user.id
    );
    tournament.registrations = (tournament.registrations || []).filter(
      (registration) => toIdString(registration.user) !== req.user.id
    );
    tournament.currentPlayers = tournament.players.length;
    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('left', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Start tournament and create Round 1 pairings
app.patch('/api/tournaments/:id/start', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Only the creator can start the tournament' });
    }

    if (tournament.status !== 'registration') {
      return res.status(400).json({ error: 'Tournament already started or completed' });
    }

    if (tournament.currentPlayers < 4) {
      return res.status(400).json({ error: 'Need at least 4 players to start tournament' });
    }

    tournament.status = 'active';
    tournament.startedAt = new Date();
    tournament.champion = null;
    tournament.rounds = [];

    const firstRound = buildNextRoundForFormat(tournament, [], new Map());
    if (!firstRound) {
      return res.status(400).json({ error: 'Unable to generate the first round for this format' });
    }
    firstRound.status = 'active';
    tournament.rounds.push(firstRound);

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('started', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Report a match result in the active tournament
app.patch('/api/tournaments/:id/matches/:matchId/report', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const { result } = req.body;
    const allowedResults = tournament.format === 'swiss'
      ? ['player1', 'player2', 'draw']
      : ['player1', 'player2'];

    if (!allowedResults.includes(result)) {
      return res.status(400).json({ error: 'Invalid match result for this tournament format' });
    }

    if (tournament.status !== 'active') {
      return res.status(400).json({ error: 'Tournament is not active' });
    }

    const creatorId = toIdString(tournament.createdBy);
    const { targetRound, targetMatch } = getMatchLocation(tournament, req.params.matchId);

    if (!targetRound || !targetMatch) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (!isRoundActive(targetRound)) {
      return res.status(400).json({ error: 'This round is not active for result reporting' });
    }

    if (!targetMatch.player2 || targetMatch.result === 'bye') {
      return res.status(400).json({ error: 'Cannot report a result for a bye match' });
    }

    if (isMatchDisputed(targetMatch)) {
      return res.status(400).json({ error: 'This match is disputed. Organizer must resolve it.' });
    }

    const canReport = canUserManageMatch(targetMatch, creatorId, req.user.id);

    if (!canReport) {
      return res.status(403).json({ error: 'Only tournament participants in this match or the organizer can report results' });
    }

    const player1Id = toIdString(targetMatch.player1);
    const player2Id = toIdString(targetMatch.player2);
    const isParticipantReporter = req.user.id === player1Id || req.user.id === player2Id;

    targetMatch.result = result;
    targetMatch.winner = result === 'player1'
      ? targetMatch.player1
      : result === 'player2'
        ? targetMatch.player2
        : null;
    targetMatch.resultStatus = 'awaiting-confirmation';
    targetMatch.confirmedBy = isParticipantReporter ? [req.user.id] : [];
    targetMatch.disputeReason = null;
    targetMatch.disputedBy = null;
    targetMatch.disputedAt = null;
    targetMatch.resolvedBy = null;
    targetMatch.resolvedAt = null;
    targetMatch.resolutionNote = null;
    targetMatch.reportedBy = req.user.id;
    targetMatch.reportedAt = new Date();

    markRoundStatusFromMatches(targetRound);

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('match-reported', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Confirm a reported match result
app.patch('/api/tournaments/:id/matches/:matchId/confirm', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.status !== 'active') {
      return res.status(400).json({ error: 'Tournament is not active' });
    }

    const creatorId = toIdString(tournament.createdBy);
    const { targetRound, targetMatch } = getMatchLocation(tournament, req.params.matchId);

    if (!targetRound || !targetMatch) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (!isRoundActive(targetRound)) {
      return res.status(400).json({ error: 'This round is not active for confirmations' });
    }

    if (!targetMatch.player2 || targetMatch.result === 'bye') {
      return res.status(400).json({ error: 'Bye matches are already confirmed' });
    }

    if (isMatchDisputed(targetMatch)) {
      return res.status(400).json({ error: 'This match is disputed. Organizer must resolve it.' });
    }

    const status = getMatchResultStatus(targetMatch);
    if (status === 'pending') {
      return res.status(400).json({ error: 'No reported result to confirm yet' });
    }

    const canConfirm = canUserManageMatch(targetMatch, creatorId, req.user.id);
    if (!canConfirm) {
      return res.status(403).json({ error: 'Only tournament participants in this match or the organizer can confirm results' });
    }

    const player1Id = toIdString(targetMatch.player1);
    const player2Id = toIdString(targetMatch.player2);
    const participantIds = [player1Id, player2Id].filter(Boolean);
    const confirmedSet = new Set((targetMatch.confirmedBy || []).map((value) => toIdString(value)));

    if (req.user.id === creatorId) {
      participantIds.forEach((id) => confirmedSet.add(id));
    } else {
      confirmedSet.add(req.user.id);
    }

    targetMatch.confirmedBy = Array.from(confirmedSet);

    const everyoneConfirmed = participantIds.every((id) => confirmedSet.has(id));
    if (everyoneConfirmed) {
      targetMatch.resultStatus = 'confirmed';
      targetRound.completedAt = null;
    } else {
      targetMatch.resultStatus = 'awaiting-confirmation';
      targetRound.status = 'active';
      targetRound.completedAt = null;
    }

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('match-confirmed', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Dispute a reported result
app.patch('/api/tournaments/:id/matches/:matchId/dispute', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.status !== 'active') {
      return res.status(400).json({ error: 'Tournament is not active' });
    }

    const creatorId = toIdString(tournament.createdBy);
    const { targetRound, targetMatch } = getMatchLocation(tournament, req.params.matchId);

    if (!targetRound || !targetMatch) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (!isRoundActive(targetRound)) {
      return res.status(400).json({ error: 'This round is not active for disputes' });
    }

    if (!targetMatch.player2 || targetMatch.result === 'bye') {
      return res.status(400).json({ error: 'Cannot dispute a bye match' });
    }

    const canDispute = canUserManageMatch(targetMatch, creatorId, req.user.id);
    if (!canDispute) {
      return res.status(403).json({ error: 'Only tournament participants in this match or the organizer can dispute results' });
    }

    if (targetMatch.result === 'pending') {
      return res.status(400).json({ error: 'Cannot dispute before a result is reported' });
    }

    if (isMatchDisputed(targetMatch)) {
      return res.status(400).json({ error: 'This match is already disputed' });
    }

    const { reason } = req.body || {};
    const normalizedReason = reason ? String(reason).trim().slice(0, 500) : 'Result disputed';
    targetMatch.resultStatus = 'disputed';
    targetMatch.disputeReason = normalizedReason;
    targetMatch.disputedBy = req.user.id;
    targetMatch.disputedAt = new Date();
    targetMatch.resolvedBy = null;
    targetMatch.resolvedAt = null;
    targetMatch.resolutionNote = null;
    targetMatch.disputeHistory = targetMatch.disputeHistory || [];
    targetMatch.disputeHistory.push({
      reason: normalizedReason,
      disputedBy: req.user.id,
      disputedAt: new Date(),
      status: 'open'
    });
    targetRound.status = 'active';
    targetRound.completedAt = null;

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('match-disputed', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Organizer resolves a disputed or unconfirmed result
app.patch('/api/tournaments/:id/matches/:matchId/resolve', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (toIdString(tournament.createdBy) !== req.user.id) {
      return res.status(403).json({ error: 'Only the organizer can resolve disputed results' });
    }

    if (tournament.status !== 'active') {
      return res.status(400).json({ error: 'Tournament is not active' });
    }

    const { targetRound, targetMatch } = getMatchLocation(tournament, req.params.matchId);

    if (!targetRound || !targetMatch) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (!isRoundActive(targetRound)) {
      return res.status(400).json({ error: 'This round is not active for organizer resolution' });
    }

    if (!targetMatch.player2 || targetMatch.result === 'bye') {
      return res.status(400).json({ error: 'Cannot resolve a bye match' });
    }

    const { result, note } = req.body || {};
    const allowedResults = tournament.format === 'swiss'
      ? ['player1', 'player2', 'draw']
      : ['player1', 'player2'];

    if (!allowedResults.includes(result)) {
      return res.status(400).json({ error: 'Invalid result for this tournament format' });
    }

    targetMatch.result = result;
    targetMatch.winner = result === 'player1'
      ? targetMatch.player1
      : result === 'player2'
        ? targetMatch.player2
        : null;
    targetMatch.resultStatus = 'confirmed';
    targetMatch.reportedBy = req.user.id;
    targetMatch.reportedAt = new Date();

    const player1Id = toIdString(targetMatch.player1);
    const player2Id = toIdString(targetMatch.player2);
    targetMatch.confirmedBy = [player1Id, player2Id].filter(Boolean);

    targetMatch.resolvedBy = req.user.id;
    targetMatch.resolvedAt = new Date();
    targetMatch.resolutionNote = note ? String(note).trim().slice(0, 500) : null;

    const openDisputeEntry = getOpenDisputeHistoryEntry(targetMatch);
    closeDisputeHistoryEntry(
      openDisputeEntry,
      'resolved',
      req.user.id,
      targetMatch.resolutionNote,
      result
    );

    targetRound.completedAt = null;

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('match-resolved', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Organizer reopens a match for correction
app.patch('/api/tournaments/:id/matches/:matchId/reopen', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (toIdString(tournament.createdBy) !== req.user.id) {
      return res.status(403).json({ error: 'Only the organizer can reopen a match result' });
    }

    if (!['active', 'completed'].includes(tournament.status)) {
      return res.status(400).json({ error: 'Tournament must be active or completed to reopen results' });
    }

    const { targetRound, targetMatch } = getMatchLocation(tournament, req.params.matchId);

    if (!targetRound || !targetMatch) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (!targetMatch.player2 || targetMatch.result === 'bye') {
      return res.status(400).json({ error: 'Cannot reopen a bye match' });
    }

    const { note } = req.body || {};
    const reopenNote = note ? String(note).trim().slice(0, 500) : 'Organizer reopened the match for correction';

    const openDisputeEntry = getOpenDisputeHistoryEntry(targetMatch);
    if (openDisputeEntry) {
      closeDisputeHistoryEntry(openDisputeEntry, 'reopened', req.user.id, reopenNote, null);
    } else {
      targetMatch.disputeHistory = targetMatch.disputeHistory || [];
      targetMatch.disputeHistory.push({
        reason: 'Organizer correction reopen',
        disputedBy: req.user.id,
        disputedAt: new Date(),
        status: 'reopened',
        resolvedBy: req.user.id,
        resolvedAt: new Date(),
        resolutionNote: reopenNote,
        resolvedResult: null
      });
    }

    targetMatch.result = 'pending';
    targetMatch.resultStatus = 'pending';
    targetMatch.winner = null;
    targetMatch.confirmedBy = [];
    targetMatch.disputeReason = null;
    targetMatch.disputedBy = null;
    targetMatch.disputedAt = null;
    targetMatch.resolvedBy = null;
    targetMatch.resolvedAt = null;
    targetMatch.resolutionNote = null;
    targetMatch.reportedBy = null;
    targetMatch.reportedAt = null;

    targetRound.status = 'active';
    targetRound.completedAt = null;

    tournament.status = 'active';
    tournament.completedAt = null;
    tournament.champion = null;

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('match-reopened', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Start a generated round
app.patch('/api/tournaments/:id/rounds/:roundId/start', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (toIdString(tournament.createdBy) !== req.user.id) {
      return res.status(403).json({ error: 'Only the organizer can start rounds' });
    }

    if (tournament.status !== 'active') {
      return res.status(400).json({ error: 'Tournament must be active to start rounds' });
    }

    const targetRound = tournament.rounds.id(req.params.roundId);
    if (!targetRound) {
      return res.status(404).json({ error: 'Round not found' });
    }

    if (isRoundLocked(targetRound)) {
      return res.status(400).json({ error: 'Cannot start a locked round' });
    }

    if (targetRound.status === 'active') {
      return res.status(400).json({ error: 'Round is already active' });
    }

    const hasAnotherActiveRound = tournament.rounds.some(
      (round) => toIdString(round._id) !== toIdString(targetRound._id) && isRoundActive(round)
    );

    if (hasAnotherActiveRound) {
      return res.status(400).json({ error: 'Another round is already active' });
    }

    targetRound.status = 'active';
    targetRound.completedAt = null;

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('round-started', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Lock an active round when all results are confirmed
app.patch('/api/tournaments/:id/rounds/:roundId/lock', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (toIdString(tournament.createdBy) !== req.user.id) {
      return res.status(403).json({ error: 'Only the organizer can lock rounds' });
    }

    if (tournament.status !== 'active') {
      return res.status(400).json({ error: 'Tournament must be active to lock rounds' });
    }

    const targetRound = tournament.rounds.id(req.params.roundId);
    if (!targetRound) {
      return res.status(404).json({ error: 'Round not found' });
    }

    if (!isRoundActive(targetRound)) {
      return res.status(400).json({ error: 'Only active rounds can be locked' });
    }

    if (!canRoundBeLocked(targetRound)) {
      return res.status(400).json({ error: 'All match results must be confirmed before locking this round' });
    }

    targetRound.status = 'locked';
    targetRound.completedAt = new Date();

    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('round-locked', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate next Swiss round once current round is complete
app.post('/api/tournaments/:id/rounds/next', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (toIdString(tournament.createdBy) !== req.user.id) {
      return res.status(403).json({ error: 'Only the creator can generate the next round' });
    }

    if (tournament.status !== 'active') {
      return res.status(400).json({ error: 'Tournament must be active to generate rounds' });
    }

    if (tournament.rounds.length === 0) {
      return res.status(400).json({ error: 'Round 1 has not been created yet' });
    }

    const hasActiveRound = tournament.rounds.some((round) => isRoundActive(round));
    if (hasActiveRound) {
      return res.status(400).json({ error: 'Lock the current active round before generating a new one' });
    }

    const hasPendingRound = tournament.rounds.some((round) => round.status === 'not_started');
    if (hasPendingRound) {
      return res.status(400).json({ error: 'Start the pending round before generating another one' });
    }

    const latestRound = tournament.rounds[tournament.rounds.length - 1];
    if (!isRoundLocked(latestRound)) {
      return res.status(400).json({ error: 'Current round must be locked before generating the next round' });
    }

    const hasUnresolvedInLatestRound = latestRound.matches.some((match) => !isMatchFinal(match));
    if (hasUnresolvedInLatestRound) {
      return res.status(400).json({ error: 'All match results in the current round must be confirmed before generating the next round' });
    }

    const populatedForStandings = await getTournamentByIdWithDetails(tournament._id);
    const records = calculatePlayerRecords(populatedForStandings);
    if (shouldAutoCompleteTournament(populatedForStandings, records)) {
      const championId = getChampionId(populatedForStandings, records);
      if (championId) {
        tournament.champion = championId;
      }
      tournament.status = 'completed';
      tournament.completedAt = new Date();
      await tournament.save();

      const completed = await getTournamentByIdWithDetails(tournament._id);
      emitTournamentUpdate('completed', completed);
      return res.json(buildTournamentResponse(completed));
    }

    const standings = calculateStandings(populatedForStandings);
    const nextRound = buildNextRoundForFormat(tournament, standings, records);
    if (!nextRound) {
      return res.status(400).json({ error: 'No valid next round could be generated for this tournament format' });
    }
    tournament.rounds.push(nextRound);
    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('round-generated', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Complete tournament
app.patch('/api/tournaments/:id/complete', authMiddleware, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Only the creator can complete the tournament' });
    }

    if (tournament.status !== 'active') {
      return res.status(400).json({ error: 'Tournament is not active' });
    }

    const hasUnresolvedMatches = tournament.rounds.some((round) =>
      round.matches.some((match) => !isMatchFinal(match))
    );

    if (hasUnresolvedMatches) {
      return res.status(400).json({ error: 'All match results must be confirmed before completing the tournament' });
    }

    if (tournament.rounds.length === 0) {
      return res.status(400).json({ error: 'Cannot complete tournament before any rounds are played' });
    }

    const latestRound = tournament.rounds[tournament.rounds.length - 1];
    if (!isRoundLocked(latestRound)) {
      return res.status(400).json({ error: 'The final round must be locked before completing the tournament' });
    }

    const records = calculatePlayerRecords(tournament);
    const standings = calculateStandings(tournament);
    const championId = getChampionId(tournament, records, standings);

    if (!championId) {
      if (tournament.format === 'swiss') {
        const minimumRounds = calculateRecommendedSwissRounds(tournament.players.length);
        return res.status(400).json({
          error: `Swiss winner not declared yet. Complete at least ${minimumRounds} rounds before finishing the tournament.`
        });
      }

      return res.status(400).json({
        error: 'Elimination winner not declared yet. Generate and complete the next round first.'
      });
    }

    tournament.champion = championId;
    tournament.status = 'completed';
    tournament.completedAt = new Date();
    await tournament.save();

    const populated = await getTournamentByIdWithDetails(tournament._id);
    emitTournamentUpdate('completed', populated);
    res.json(buildTournamentResponse(populated));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});