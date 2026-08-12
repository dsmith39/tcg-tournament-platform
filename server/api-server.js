/*
 * Core API module for authentication, decklists, tournaments, and match flow.
 *
 * Architecture notes:
 * - Exports registerApi(app, io) so HTTP wiring stays in server.js.
 * - Persistence is DynamoDB via server/dynamo.js + server/models/*.
 *   Tournament/round/match mutation logic below is storage-agnostic: it
 *   loads a whole tournament, mutates the in-memory tree, and saves it back
 *   whole -- the same shape regardless of the backing store.
 * - Uses validation + security modules to keep handlers focused on domain logic.
 */
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { generateId } = require('./models/id');
const usersRepo = require('./models/users');
const decklistsRepo = require('./models/decklists');
const tournamentsRepo = require('./models/tournaments');
const { TournamentVersionConflictError } = tournamentsRepo;
const {
  gameEnumValues,
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
} = require('./validation');
const {
  authLimiter,
  writeLimiter,
  matchActionLimiter
} = require('./security');

function registerApi(app, io) {
  // Global middleware is intentionally kept minimal here so route handlers remain explicit.
  app.use(cors());
  app.use(express.json());

  // Card lookups/images are served from the local SQLite mirror (card-database/), never
  // proxied live to db.ygoprodeck.com -- keeps the running app off the public API entirely.
  app.use('/api/v7', require('../card-database/src/api_router'));

  // Shared enums come from the validation module so runtime validation and stored data stay aligned.
  const gameEnum = gameEnumValues;

  const toIdString = (value) => (value ? value.toString() : null);

  // Route catch blocks call this instead of hardcoding a 500 so a tournament
  // optimistic-locking conflict (two organizers/players racing a mutation on
  // the same tournament) surfaces as a 409 the frontend can react to, rather
  // than a generic server error.
  const sendServerError = (res, error) => {
    if (error instanceof TournamentVersionConflictError) {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Server error' });
  };

  const shuffleArray = (items) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const getTournamentByIdWithDetails = async (id) => tournamentsRepo.findByIdHydrated(id);

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

  const calculateTopCutLosses = (tournament) => {
    const losses = new Map();
    (tournament.topCutPlayers || []).forEach((p) => losses.set(toIdString(p._id || p), 0));
    tournament.rounds
      .filter((r) => r.number >= (tournament.topCutStartRound || Infinity))
      .forEach((round) => {
        round.matches.forEach((match) => {
          if (!isMatchFinal(match) || match.result === 'bye' || match.result === 'draw') return;
          const loserId = match.result === 'player1'
            ? toIdString(match.player2?._id || match.player2)
            : toIdString(match.player1?._id || match.player1);
          if (losses.has(loserId)) {
            losses.set(loserId, losses.get(loserId) + 1);
          }
        });
      });
    return losses;
  };

  const getRemainingPlayersByFormat = (tournament, records) => {
    if (tournament.isTopCutPhase) {
      const topCutLosses = calculateTopCutLosses(tournament);
      return (tournament.topCutPlayers || []).filter((p) => (topCutLosses.get(toIdString(p._id || p)) || 0) === 0).length;
    }

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
    if (tournament.isTopCutPhase) {
      if ((tournament.topCutPlayers || []).length === 0) return false;
      const topCutLosses = calculateTopCutLosses(tournament);
      const remaining = (tournament.topCutPlayers || []).filter((p) => (topCutLosses.get(toIdString(p._id || p)) || 0) === 0);
      return remaining.length <= 1;
    }

    if (!isEliminationFormat(tournament.format)) return false;
    if (tournament.rounds.length === 0) return false;
    return getRemainingPlayersByFormat(tournament, records) <= 1;
  };

  const getChampionId = (tournament, records, standings = []) => {
    if (tournament.rounds.length === 0) return null;

    if (tournament.isTopCutPhase) {
      const topCutLosses = calculateTopCutLosses(tournament);
      const finalists = (tournament.topCutPlayers || [])
        .map((p) => toIdString(p._id || p))
        .filter((id) => (topCutLosses.get(id) || 0) === 0);
      return finalists.length === 1 ? finalists[0] : null;
    }

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
        _id: generateId(),
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
        _id: generateId(),
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
      _id: generateId(),
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
        _id: generateId(),
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
      _id: generateId(),
      number: tournament.rounds.length + 1,
      status: 'not_started',
      matches,
      createdAt: new Date(),
      completedAt: null
    };
  };

  const buildTopCutNextRound = (tournament) => {
    const topCutLosses = calculateTopCutLosses(tournament);
    const topCutWins = new Map();
    (tournament.topCutPlayers || []).forEach((p) => topCutWins.set(toIdString(p._id || p), 0));
    tournament.rounds
      .filter((r) => r.number >= (tournament.topCutStartRound || Infinity))
      .forEach((round) => {
        round.matches.forEach((match) => {
          if (!isMatchFinal(match) || match.result === 'bye') return;
          const winnerId = match.result === 'player1'
            ? toIdString(match.player1?._id || match.player1)
            : toIdString(match.player2?._id || match.player2);
          if (topCutWins.has(winnerId)) {
            topCutWins.set(winnerId, topCutWins.get(winnerId) + 1);
          }
        });
      });

    const remaining = (tournament.topCutPlayers || [])
      .map((p) => toIdString(p._id || p))
      .filter((id) => (topCutLosses.get(id) || 0) === 0)
      .sort((a, b) => (topCutWins.get(b) || 0) - (topCutWins.get(a) || 0));

    if (remaining.length <= 1) return null;

    const { matches } = buildSequentialPairings(remaining, 1, 'single');

    return {
      _id: generateId(),
      number: tournament.rounds.length + 1,
      status: 'not_started',
      matches,
      createdAt: new Date(),
      completedAt: null
    };
  };

  const buildNextRoundForFormat = (tournament, standings, records) => {
    if (tournament.isTopCutPhase) {
      return buildTopCutNextRound(tournament);
    }

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
        _id: generateId(),
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
        _id: generateId(),
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
      _id: generateId(),
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
    const recommendedSwissRounds = tournament.format === 'swiss'
      ? calculateRecommendedSwissRounds(tournament.players.length)
      : null;
    const canGenerateNextRound = tournament.status === 'active'
      && !hasActiveRound
      && !hasPendingRound
      && !isConcluded
      && unresolvedMatchCount === 0
      && !!latestRound
      && isRoundLocked(latestRound)
      && roundsPlayed > 0;
    const canCompleteNow = !!championId && !!latestRound && isRoundLocked(latestRound);
    const canStartTopCut = tournament.format === 'swiss'
      && (tournament.topCutSize || 0) > 0
      && !tournament.isTopCutPhase
      && tournament.status === 'active'
      && !hasActiveRound
      && !hasPendingRound
      && roundsPlayed > 0
      && !!latestRound
      && isRoundLocked(latestRound)
      && !!recommendedSwissRounds
      && roundsPlayed >= recommendedSwissRounds;

    const checkedInPlayerIds = (tournament.checkedInPlayers || []).map((id) => toIdString(id));

    return {
      ...tournament,
      standings,
      checkedInPlayerIds,
      roundMeta: {
        roundsPlayed,
        recommendedSwissRounds,
        remainingPlayers: getRemainingPlayersByFormat(tournament, records),
        championId,
        canCompleteNow,
        activeRoundId: activeRound ? toIdString(activeRound._id) : null,
        pendingRoundId: pendingRound ? toIdString(pendingRound._id) : null,
        hasPendingRound,
        canStartPendingRound: tournament.status === 'active' && !hasActiveRound && !!pendingRound,
        canLockActiveRound,
        canGenerateNextRound,
        canStartTopCut,
        unresolvedMatchCount,
        disputedMatchCount,
        isConcluded,
        isTopCutPhase: tournament.isTopCutPhase || false,
        topCutSize: tournament.topCutSize || 0
      }
    };
  };

  const getMatchLocation = (tournament, matchId) => {
    let targetRound = null;
    let targetMatch = null;

    tournament.rounds.forEach((round) => {
      if (targetMatch) return;
      const foundMatch = round.matches.find((match) => match._id === matchId);
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
    const joinedTournaments = await tournamentsRepo.listByPlayer(userId);

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
      tournamentsRepo.listByCreator(userId, { limit: 8 }),
      tournamentsRepo.listByPlayer(userId, { limit: 8 }),
      tournamentsRepo.countByCreator(userId),
      tournamentsRepo.countByPlayer(userId),
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
      avatarUrl: user.avatarUrl || '',
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
      recentCreatedTournaments: createdTournaments.map(({ _id, name, game, format, status, createdAt }) => (
        { _id, name, game, format, status, createdAt }
      )),
      recentJoinedTournaments: joinedTournaments.map(({ _id, name, game, format, status, createdAt }) => (
        { _id, name, game, format, status, createdAt }
      )),
      recentMatches: matchStats.recentMatches
    };
  };

  // Access tokens are intentionally short-lived so stolen cookies expire quickly.
  // Refresh tokens are stored hashed in SQLite and rotated on every refresh request.
  const ACCESS_COOKIE_NAME = 'tcg_access';
  const REFRESH_COOKIE_NAME = 'tcg_refresh';
  const ACCESS_TTL_SECONDS = 15 * 60;
  const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
  const MAX_REFRESH_TOKENS = 10;

  // Cookie parsing is implemented locally to avoid pulling another dependency into the server.
  const parseCookies = (req) => {
    const rawCookie = req.headers?.cookie;
    if (!rawCookie) return {};

    return rawCookie.split(';').reduce((acc, pair) => {
      const [rawName, ...rest] = pair.trim().split('=');
      if (!rawName) return acc;
      acc[rawName] = decodeURIComponent(rest.join('='));
      return acc;
    }, {});
  };

  const getCookieValue = (req, name) => parseCookies(req)[name] || null;

  const getBearerToken = (req) => {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    return authHeader.replace('Bearer ', '').trim();
  };

  const getAccessTokenFromRequest = (req) => getBearerToken(req) || getCookieValue(req, ACCESS_COOKIE_NAME);

  const isSecureCookie = process.env.NODE_ENV === 'production';

  const buildCookieOptions = (maxAgeMs, path = '/') => ({
    httpOnly: true,
    secure: isSecureCookie,
    sameSite: 'lax',
    path,
    maxAge: maxAgeMs
  });

  const clearAuthCookies = (res) => {
    res.clearCookie(ACCESS_COOKIE_NAME, { path: '/' });
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
  };

  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

  const pruneRefreshTokens = (user) => {
    const now = new Date();
    user.refreshTokens = (user.refreshTokens || [])
      .filter((entry) => entry.expiresAt > now)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, MAX_REFRESH_TOKENS);
  };

  const signAccessToken = (user) => jwt.sign(
    {
      id: toIdString(user._id),
      ver: user.sessionVersion || 0,
      type: 'access'
    },
    process.env.JWT_SECRET,
    { expiresIn: `${ACCESS_TTL_SECONDS}s` }
  );

  const signRefreshToken = (user, jti) => jwt.sign(
    {
      id: toIdString(user._id),
      ver: user.sessionVersion || 0,
      type: 'refresh',
      jti
    },
    process.env.JWT_SECRET,
    { expiresIn: `${REFRESH_TTL_SECONDS}s` }
  );

  const addRefreshTokenToUser = (user, refreshToken, expiresAt) => {
    const tokenHash = hashToken(refreshToken);
    user.refreshTokens = (user.refreshTokens || []).filter((entry) => entry.tokenHash !== tokenHash);
    user.refreshTokens.push({
      tokenHash,
      expiresAt,
      createdAt: new Date()
    });
    pruneRefreshTokens(user);
  };

  const removeRefreshTokenFromUser = (user, refreshToken) => {
    const tokenHash = hashToken(refreshToken);
    user.refreshTokens = (user.refreshTokens || []).filter((entry) => entry.tokenHash !== tokenHash);
  };

  const hasRefreshToken = (user, refreshToken) => {
    const tokenHash = hashToken(refreshToken);
    const now = new Date();
    return (user.refreshTokens || []).some((entry) => entry.tokenHash === tokenHash && entry.expiresAt > now);
  };

  // Every successful login/register/refresh issues a fresh access token and a rotated refresh token.
  // The caller's browser becomes the credential store while the frontend only tracks user/session presence.
  const issueAuthCookies = (res, user) => {
    const accessToken = signAccessToken(user);
    const refreshJti = crypto.randomUUID();
    const refreshToken = signRefreshToken(user, refreshJti);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);

    addRefreshTokenToUser(user, refreshToken, refreshExpiresAt);

    res.cookie(
      ACCESS_COOKIE_NAME,
      accessToken,
      buildCookieOptions(ACCESS_TTL_SECONDS * 1000, '/')
    );
    res.cookie(
      REFRESH_COOKIE_NAME,
      refreshToken,
      buildCookieOptions(REFRESH_TTL_SECONDS * 1000, '/api/auth')
    );
  };

  // JWT middleware
  const authMiddleware = async (req, res, next) => {
    const token = getAccessTokenFromRequest(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded?.type !== 'access' || !decoded?.id) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const user = await usersRepo.findById(decoded.id);
      if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      if ((decoded.ver || 0) !== (user.sessionVersion || 0)) {
        return res.status(401).json({ error: 'Session expired. Please login again.' });
      }

      req.user = { id: toIdString(user._id), sessionVersion: user.sessionVersion || 0 };
      next();
    } catch (error) {
      res.status(401).json({ error: 'Invalid token' });
    }
  };

  const getOptionalUserIdFromAuthHeader = (req) => {
    const token = getAccessTokenFromRequest(req);
    if (!token) return null;

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded?.type !== 'access') return null;
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
  // Register creates a new user and immediately issues cookie-based session tokens.
  app.post('/api/auth/register', authLimiter, validateRequest({ body: registerBodySchema }), async (req, res) => {
    try {
      const { username, email, password } = req.validated.body;

      const hashedPassword = await bcrypt.hash(password, 10);

      const user = usersRepo.buildUser({
        username,
        email,
        password: hashedPassword
      });

      issueAuthCookies(res, user);
      await user.save();

      res.json({ user: { id: user._id, username, email } });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Login rotates session cookies so the browser becomes the token store instead of localStorage.
  app.post('/api/auth/login', authLimiter, validateRequest({ body: loginBodySchema }), async (req, res) => {
    try {
      const { email, password } = req.validated.body;

      const user = await usersRepo.findByEmail(email);
      if (!user) return res.status(400).json({ error: 'Invalid credentials' });

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) return res.status(400).json({ error: 'Invalid credentials' });

      issueAuthCookies(res, user);
      await user.save();

      res.json({ user: { id: user._id, username: user.username, email } });
    } catch (error) {
      sendServerError(res, error);
    }
  });

  app.post('/api/auth/refresh', authLimiter, async (req, res) => {
    try {
      const refreshToken = getCookieValue(req, REFRESH_COOKIE_NAME);
      if (!refreshToken) {
        clearAuthCookies(res);
        return res.status(401).json({ error: 'No refresh token provided' });
      }

      const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
      if (decoded?.type !== 'refresh' || !decoded?.id) {
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Invalid refresh token' });
      }

      const user = await usersRepo.findById(decoded.id);
      if (!user) {
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Invalid refresh token' });
      }

      if ((decoded.ver || 0) !== (user.sessionVersion || 0)) {
        user.refreshTokens = [];
        await user.save();
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Session expired. Please login again.' });
      }

      if (!hasRefreshToken(user, refreshToken)) {
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Refresh token revoked or expired' });
      }

      removeRefreshTokenFromUser(user, refreshToken);
      issueAuthCookies(res, user);
      await user.save();

      res.json({ user: { id: user._id, username: user.username, email: user.email } });
    } catch (error) {
      clearAuthCookies(res);
      res.status(401).json({ error: 'Invalid refresh token' });
    }
  });

  app.post('/api/auth/logout', authLimiter, async (req, res) => {
    try {
      const refreshToken = getCookieValue(req, REFRESH_COOKIE_NAME);
      if (refreshToken) {
        try {
          const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
          if (decoded?.type === 'refresh' && decoded?.id) {
            const user = await usersRepo.findById(decoded.id);
            if (user) {
              removeRefreshTokenFromUser(user, refreshToken);
              pruneRefreshTokens(user);
              await user.save();
            }
          }
        } catch {
          // Intentionally ignore invalid refresh tokens during logout.
        }
      }

      clearAuthCookies(res);
      res.json({ message: 'Logged out' });
    } catch (error) {
      clearAuthCookies(res);
      sendServerError(res, error);
    }
  });

  app.post('/api/auth/logout-all', authMiddleware, authLimiter, async (req, res) => {
    try {
      const user = await usersRepo.findById(req.user.id);
      if (!user) {
        clearAuthCookies(res);
        return res.status(404).json({ error: 'User not found' });
      }

      user.sessionVersion = (user.sessionVersion || 0) + 1;
      user.refreshTokens = [];
      await user.save();

      clearAuthCookies(res);
      res.json({ message: 'Logged out from all sessions' });
    } catch (error) {
      clearAuthCookies(res);
      sendServerError(res, error);
    }
  });

  // Get current user
  app.get('/api/auth/me', authMiddleware, async (req, res) => {
    const user = await usersRepo.findById(req.user.id);
    const { password, ...safeUser } = user;
    res.json(safeUser);
  });

  // Update current user's public profile
  app.patch('/api/users/me', authMiddleware, writeLimiter, validateRequest({ body: userProfileUpdateBodySchema }), async (req, res) => {
    try {
      const user = await usersRepo.findById(req.user.id);
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
        website: 120,
        avatarUrl: 500
      };

      Object.entries(updatableFields).forEach(([field, maxLength]) => {
        if (Object.prototype.hasOwnProperty.call(req.validated.body, field)) {
          const sanitized = sanitizeField(req.validated.body[field], maxLength);
          if (sanitized !== null) {
            user[field] = sanitized;
          }
        }
      });

      await user.save();
      const profile = await buildUserProfileResponse(user);
      res.json(profile);
    } catch (error) {
      sendServerError(res, error);
    }
  });

  // Public user profile for user portal pages
  app.get('/api/users/:id', async (req, res) => {
    try {
      const user = await usersRepo.findById(req.params.id);
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
      const publicDecklists = await decklistsRepo.findRecentPublic(10);
      const decklists = await Promise.all(publicDecklists.map(async (decklist) => {
        const owner = await usersRepo.findById(decklist.owner);
        return { ...decklist, owner: owner ? { _id: owner._id, username: owner.username } : null };
      }));

      res.json(decklists);
    } catch (error) {
      sendServerError(res, error);
    }
  });

  // Get single decklist (public or owner)
  app.get('/api/decklists/:id', async (req, res) => {
    try {
      const decklist = await decklistsRepo.findById(req.params.id);

      if (!decklist) return res.status(404).json({ error: 'Decklist not found' });

      const requesterId = getOptionalUserIdFromAuthHeader(req);
      const ownerId = toIdString(decklist.owner);
      const isOwner = requesterId && requesterId === ownerId;
      const isPublic = decklist.isPublic !== false;

      if (!isPublic && !isOwner) {
        return res.status(403).json({ error: 'This decklist is private' });
      }

      const owner = await usersRepo.findById(decklist.owner);
      res.json({ ...decklist, owner: owner ? { _id: owner._id, username: owner.username } : null });
    } catch (error) {
      res.status(404).json({ error: 'Decklist not found' });
    }
  });

  // Get authenticated user's decklists
  app.get('/api/decklists', authMiddleware, async (req, res) => {
    try {
      const decklists = await decklistsRepo.findByOwner(req.user.id);
      res.json(decklists);
    } catch (error) {
      sendServerError(res, error);
    }
  });

  // Create decklist
  app.post('/api/decklists', authMiddleware, writeLimiter, validateRequest({ body: createDecklistBodySchema }), async (req, res) => {
    try {
      const {
        name,
        game,
        mainDeck = '',
        extraDeck = '',
        sideDeck = '',
        isPublic = true,
        archetype = '',
        notes = ''
      } = req.validated.body;

      const decklist = await decklistsRepo.create({
        owner: req.user.id,
        name: name.trim(),
        game,
        mainDeck: mainDeck.trim(),
        extraDeck: typeof extraDeck === 'string' ? extraDeck.trim() : '',
        sideDeck: typeof sideDeck === 'string' ? sideDeck.trim() : '',
        isPublic: typeof isPublic === 'boolean' ? isPublic : true,
        archetype: typeof archetype === 'string' ? archetype.trim().slice(0, 80) : '',
        notes: typeof notes === 'string' ? notes.trim() : ''
      });

      emitDecklistUpdate('created', decklist);
      res.status(201).json(decklist);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Update decklist
  app.patch('/api/decklists/:id', authMiddleware, writeLimiter, validateRequest({ params: tournamentIdParamsSchema, body: updateDecklistBodySchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const decklist = await decklistsRepo.findByIdForOwner(id, req.user.id);
      if (!decklist) return res.status(404).json({ error: 'Decklist not found' });

      const updatableFields = ['name', 'game', 'mainDeck', 'extraDeck', 'sideDeck', 'archetype', 'notes'];

      if (Object.prototype.hasOwnProperty.call(req.validated.body, 'isPublic') && typeof req.validated.body.isPublic === 'boolean') {
        decklist.isPublic = req.validated.body.isPublic;
      }

      updatableFields.forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(req.validated.body, field)) return;
        if (typeof req.validated.body[field] !== 'string') return;

        if (field === 'game') {
          if (gameEnum.includes(req.validated.body[field])) {
            decklist.game = req.validated.body[field];
          }
          return;
        }

        decklist[field] = req.validated.body[field].trim();
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
  app.delete('/api/decklists/:id', authMiddleware, writeLimiter, validateRequest({ params: tournamentIdParamsSchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const decklist = await decklistsRepo.deleteByIdForOwner(id, req.user.id);
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
      const tournaments = await tournamentsRepo.listSummaries();
      res.json(tournaments);
    } catch (error) {
      sendServerError(res, error);
    }
  });

  // Create tournament
  app.post('/api/tournaments', authMiddleware, writeLimiter, validateRequest({ body: createTournamentBodySchema }), async (req, res) => {
    try {
      const tournament = await tournamentsRepo.create({
        ...req.validated.body,
        createdBy: req.user.id
      });

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
      sendServerError(res, error);
    }
  });

  // Delete tournament (only creator)
  app.delete('/api/tournaments/:id', authMiddleware, writeLimiter, validateRequest({ params: tournamentIdParamsSchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
      if (tournament.createdBy.toString() !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      await tournamentsRepo.deleteById(id);
      emitTournamentUpdate('deleted', tournament);
      res.json({ message: 'Tournament deleted' });
    } catch (error) {
      sendServerError(res, error);
    }
  });

  // Join tournament
  app.patch('/api/tournaments/:id/join', authMiddleware, writeLimiter, validateRequest({ params: tournamentIdParamsSchema, body: joinTournamentBodySchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);
      const { decklistId } = req.validated.body;

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

      const decklist = await decklistsRepo.findByIdForOwner(decklistId, req.user.id);
      if (!decklist) {
        return res.status(400).json({ error: 'Selected decklist was not found' });
      }

      if (decklist.game !== tournament.game) {
        return res.status(400).json({ error: 'Selected decklist does not match this tournament game format' });
      }

      tournament.players.push(req.user.id);
      tournament.registrations.push({
        _id: generateId(),
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
      sendServerError(res, error);
    }
  });

  // Leave tournament
  app.patch('/api/tournaments/:id/leave', authMiddleware, writeLimiter, validateRequest({ params: tournamentIdParamsSchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

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
      sendServerError(res, error);
    }
  });

  // Start tournament and create Round 1 pairings
  app.patch('/api/tournaments/:id/start', authMiddleware, matchActionLimiter, validateRequest({ params: tournamentIdParamsSchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

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
      sendServerError(res, error);
    }
  });

  // Report a match result in the active tournament
  app.patch('/api/tournaments/:id/matches/:matchId/report', authMiddleware, matchActionLimiter, validateRequest({ params: matchIdParamsSchema, body: matchReportBodySchema }), async (req, res) => {
    try {
      const { id, matchId } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      const { result } = req.validated.body;
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
      const { targetRound, targetMatch } = getMatchLocation(tournament, matchId);

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
      sendServerError(res, error);
    }
  });

  // Confirm a reported match result
  app.patch('/api/tournaments/:id/matches/:matchId/confirm', authMiddleware, matchActionLimiter, validateRequest({ params: matchIdParamsSchema }), async (req, res) => {
    try {
      const { id, matchId } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      if (tournament.status !== 'active') {
        return res.status(400).json({ error: 'Tournament is not active' });
      }

      const creatorId = toIdString(tournament.createdBy);
      const { targetRound, targetMatch } = getMatchLocation(tournament, matchId);

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
      sendServerError(res, error);
    }
  });

  // Dispute a reported result
  app.patch('/api/tournaments/:id/matches/:matchId/dispute', authMiddleware, matchActionLimiter, validateRequest({ params: matchIdParamsSchema, body: matchDisputeBodySchema }), async (req, res) => {
    try {
      const { id, matchId } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      if (tournament.status !== 'active') {
        return res.status(400).json({ error: 'Tournament is not active' });
      }

      const creatorId = toIdString(tournament.createdBy);
      const { targetRound, targetMatch } = getMatchLocation(tournament, matchId);

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

      const { reason } = req.validated.body;
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
        _id: generateId(),
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
      sendServerError(res, error);
    }
  });

  // Organizer resolves a disputed or unconfirmed result
  app.patch('/api/tournaments/:id/matches/:matchId/resolve', authMiddleware, matchActionLimiter, validateRequest({ params: matchIdParamsSchema, body: matchResolveBodySchema }), async (req, res) => {
    try {
      const { id, matchId } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      if (toIdString(tournament.createdBy) !== req.user.id) {
        return res.status(403).json({ error: 'Only the organizer can resolve disputed results' });
      }

      if (tournament.status !== 'active') {
        return res.status(400).json({ error: 'Tournament is not active' });
      }

      const { targetRound, targetMatch } = getMatchLocation(tournament, matchId);

      if (!targetRound || !targetMatch) {
        return res.status(404).json({ error: 'Match not found' });
      }

      if (!isRoundActive(targetRound)) {
        return res.status(400).json({ error: 'This round is not active for organizer resolution' });
      }

      if (!targetMatch.player2 || targetMatch.result === 'bye') {
        return res.status(400).json({ error: 'Cannot resolve a bye match' });
      }

      const { result, note } = req.validated.body;
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
      sendServerError(res, error);
    }
  });

  // Organizer reopens a match for correction
  app.patch('/api/tournaments/:id/matches/:matchId/reopen', authMiddleware, matchActionLimiter, validateRequest({ params: matchIdParamsSchema, body: matchReopenBodySchema }), async (req, res) => {
    try {
      const { id, matchId } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      if (toIdString(tournament.createdBy) !== req.user.id) {
        return res.status(403).json({ error: 'Only the organizer can reopen a match result' });
      }

      if (!['active', 'completed'].includes(tournament.status)) {
        return res.status(400).json({ error: 'Tournament must be active or completed to reopen results' });
      }

      const { targetRound, targetMatch } = getMatchLocation(tournament, matchId);

      if (!targetRound || !targetMatch) {
        return res.status(404).json({ error: 'Match not found' });
      }

      if (!targetMatch.player2 || targetMatch.result === 'bye') {
        return res.status(400).json({ error: 'Cannot reopen a bye match' });
      }

      const { note } = req.validated.body;
      const reopenNote = note ? String(note).trim().slice(0, 500) : 'Organizer reopened the match for correction';

      const openDisputeEntry = getOpenDisputeHistoryEntry(targetMatch);
      if (openDisputeEntry) {
        closeDisputeHistoryEntry(openDisputeEntry, 'reopened', req.user.id, reopenNote, null);
      } else {
        targetMatch.disputeHistory = targetMatch.disputeHistory || [];
        targetMatch.disputeHistory.push({
          _id: generateId(),
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
      sendServerError(res, error);
    }
  });

  // Start a generated round
  app.patch('/api/tournaments/:id/rounds/:roundId/start', authMiddleware, matchActionLimiter, validateRequest({ params: roundIdParamsSchema }), async (req, res) => {
    try {
      const { id, roundId } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      if (toIdString(tournament.createdBy) !== req.user.id) {
        return res.status(403).json({ error: 'Only the organizer can start rounds' });
      }

      if (tournament.status !== 'active') {
        return res.status(400).json({ error: 'Tournament must be active to start rounds' });
      }

      const targetRound = tournament.rounds.find((round) => round._id === roundId);
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
      if ((tournament.roundTimerMinutes || 0) > 0) {
        targetRound.timerStartedAt = new Date();
      }

      await tournament.save();

      const populated = await getTournamentByIdWithDetails(tournament._id);
      emitTournamentUpdate('round-started', populated);
      res.json(buildTournamentResponse(populated));
    } catch (error) {
      sendServerError(res, error);
    }
  });

  // Lock an active round when all results are confirmed
  app.patch('/api/tournaments/:id/rounds/:roundId/lock', authMiddleware, matchActionLimiter, validateRequest({ params: roundIdParamsSchema }), async (req, res) => {
    try {
      const { id, roundId } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      if (toIdString(tournament.createdBy) !== req.user.id) {
        return res.status(403).json({ error: 'Only the organizer can lock rounds' });
      }

      if (tournament.status !== 'active') {
        return res.status(400).json({ error: 'Tournament must be active to lock rounds' });
      }

      const targetRound = tournament.rounds.find((round) => round._id === roundId);
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
      sendServerError(res, error);
    }
  });

  // Generate next Swiss round once current round is complete
  app.post('/api/tournaments/:id/rounds/next', authMiddleware, matchActionLimiter, validateRequest({ params: tournamentIdParamsSchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

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
      sendServerError(res, error);
    }
  });

  // Complete tournament
  app.patch('/api/tournaments/:id/complete', authMiddleware, matchActionLimiter, validateRequest({ params: tournamentIdParamsSchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);

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
      sendServerError(res, error);
    }
  });

  // Check in to a tournament
  app.post('/api/tournaments/:id/checkin', authMiddleware, writeLimiter, validateRequest({ params: tournamentIdParamsSchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);
      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      const hasJoined = tournament.players.some((p) => toIdString(p) === req.user.id);
      if (!hasJoined) {
        return res.status(400).json({ error: 'You are not registered for this tournament' });
      }

      if (!['registration', 'active'].includes(tournament.status)) {
        return res.status(400).json({ error: 'Check-in is not available for this tournament' });
      }

      const alreadyCheckedIn = (tournament.checkedInPlayers || []).some(
        (id) => toIdString(id) === req.user.id
      );
      if (alreadyCheckedIn) {
        return res.status(400).json({ error: 'You are already checked in' });
      }

      tournament.checkedInPlayers = tournament.checkedInPlayers || [];
      tournament.checkedInPlayers.push(req.user.id);
      await tournament.save();

      const populated = await getTournamentByIdWithDetails(tournament._id);
      emitTournamentUpdate('player-checkedin', populated);
      res.json(buildTournamentResponse(populated));
    } catch (error) {
      sendServerError(res, error);
    }
  });

  // Start top cut from Swiss standings
  app.post('/api/tournaments/:id/start-top-cut', authMiddleware, matchActionLimiter, validateRequest({ params: tournamentIdParamsSchema }), async (req, res) => {
    try {
      const { id } = req.validated.params;
      const tournament = await tournamentsRepo.findById(id);
      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

      if (toIdString(tournament.createdBy) !== req.user.id) {
        return res.status(403).json({ error: 'Only the organizer can start the top cut' });
      }

      if (tournament.status !== 'active') {
        return res.status(400).json({ error: 'Tournament must be active' });
      }

      if (tournament.format !== 'swiss') {
        return res.status(400).json({ error: 'Top cut is only available for Swiss tournaments' });
      }

      if (!tournament.topCutSize || tournament.topCutSize <= 0) {
        return res.status(400).json({ error: 'This tournament does not have a top cut configured' });
      }

      if (tournament.isTopCutPhase) {
        return res.status(400).json({ error: 'Top cut has already started' });
      }

      if (tournament.rounds.length === 0) {
        return res.status(400).json({ error: 'No rounds played yet' });
      }

      const hasActiveRound = tournament.rounds.some((r) => isRoundActive(r));
      if (hasActiveRound) {
        return res.status(400).json({ error: 'Lock the active round before starting top cut' });
      }

      const hasPendingRound = tournament.rounds.some((r) => r.status === 'not_started');
      if (hasPendingRound) {
        return res.status(400).json({ error: 'Start the pending round before starting top cut' });
      }

      const latestRound = tournament.rounds[tournament.rounds.length - 1];
      if (!isRoundLocked(latestRound)) {
        return res.status(400).json({ error: 'Lock the latest round before starting top cut' });
      }

      const recommendedRounds = calculateRecommendedSwissRounds(tournament.players.length);
      if (tournament.rounds.length < recommendedRounds) {
        return res.status(400).json({
          error: `Play at least ${recommendedRounds} Swiss rounds before starting the top cut (played: ${tournament.rounds.length})`
        });
      }

      const populatedForStandings = await getTournamentByIdWithDetails(tournament._id);
      const standings = calculateStandings(populatedForStandings);

      const cutSize = Math.min(tournament.topCutSize, tournament.players.length);
      const topPlayerIds = standings.slice(0, cutSize).map((s) => s.playerId);

      // Seed bracket: 1 vs last, 2 vs second-last, etc.
      const seededOrder = [];
      let lo = 0;
      let hi = topPlayerIds.length - 1;
      while (lo <= hi) {
        seededOrder.push(topPlayerIds[lo]);
        if (lo !== hi) seededOrder.push(topPlayerIds[hi]);
        lo += 1;
        hi -= 1;
      }

      const { matches } = buildSequentialPairings(seededOrder, 1, 'single');
      const topCutRoundNumber = tournament.rounds.length + 1;
      const firstTopCutRound = {
        _id: generateId(),
        number: topCutRoundNumber,
        status: 'not_started',
        matches,
        createdAt: new Date(),
        completedAt: null
      };

      tournament.isTopCutPhase = true;
      tournament.topCutPlayers = topPlayerIds;
      tournament.topCutStartRound = topCutRoundNumber;
      tournament.rounds.push(firstTopCutRound);

      await tournament.save();

      const populated = await getTournamentByIdWithDetails(tournament._id);
      emitTournamentUpdate('top-cut-started', populated);
      res.json(buildTournamentResponse(populated));
    } catch (error) {
      sendServerError(res, error);
    }
  });

}

module.exports = { registerApi };
