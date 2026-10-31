'use strict';

// All state-changing actions. Every action: validates input -> mutates state
// -> persists -> broadcasts -> returns the new public state.

const crypto = require('node:crypto');
const { pickMatch, pickNextMatch, isSameGroup, roundRobinProgress } = require('./matchmaking');
const { withStats, buildLeaderboard } = require('./leaderboard');
const { emptyState } = require('./store');

const MAX_UNDO = 30;
const RECENT_MATCHES = 10;
const MAX_NAME_LENGTH = 20;
const MIN_MATCH_SIZE = 2;
const MAX_MATCH_SIZE = 8;

// Thrown for invalid actions; the API turns these into HTTP 400.
class ActionError extends Error {}

function createTournament({
  initialState,
  save = () => {},
  onChange = () => {},
  random = Math.random,
  now = () => new Date(),
  getJoinUrl = () => null,
} = {}) {
  let state = initialState || emptyState();
  const undoStack = []; // { snapshot, label }, in memory only

  // ---- helpers -------------------------------------------------------------

  const findPlayer = (id) => state.players.find((p) => p.id === id);
  const isActive = (id) => Boolean(findPlayer(id) && findPlayer(id).active);
  const nameOf = (id) => (findPlayer(id) ? findPlayer(id).name : '?');
  const namesOf = (ids) => ids.map(nameOf);
  const isInMatch = (match, id) => Boolean(match) && match.players.includes(id);
  const isPlayable = (match) => Boolean(match) && match.players.every(isActive);
  const matchId = (offset) => `m_${state.matchCounter + offset}`;

  // Fills in currentMatch/nextMatch for the regular phase. A current match
  // that is still playable is kept; "up next" is always recomputed.
  function refreshMatches() {
    if (state.phase !== 'regular') return;

    // The matchmaker reads `played`, so bring the stats up to date first.
    state.players = withStats(state.players, state.history);

    let current = state.currentMatch;
    if (!isPlayable(current)) {
      const next = state.nextMatch;
      const canPromote = isPlayable(next) && !isSameGroup(next.players, state.lastMatchPlayers);
      current = canPromote
        ? next
        : pickMatch(state.players, state.history, state.lastMatchPlayers, state.matchSize, random);
    }
    const next = pickNextMatch(state.players, state.history, current, state.matchSize, random);

    const stamp = (match, offset) =>
      match && { id: matchId(offset), players: match.players, isBoss: false };
    state.currentMatch = stamp(current, 1);
    state.nextMatch = stamp(next, 2);
  }

  function concludeCurrentMatch(outcome) {
    const match = state.currentMatch;
    state.history.push({
      id: match.id,
      players: match.players,
      outcome,
      isBoss: match.isBoss,
      at: now().toISOString(),
    });
    state.matchCounter++;
  }

  function persistAndBroadcast() {
    try {
      save(state);
    } catch (err) {
      // Keep the party going from memory; the next successful save catches up.
      console.error(`Could not save tournament state: ${err.message}`);
    }
    const pub = getPublicState();
    onChange(pub);
    return pub;
  }

  // Runs one action. `fn` validates (throwing ActionError), mutates `state`
  // and returns a short description used by the undo toast.
  function act(fn) {
    const snapshot = structuredClone(state);
    let label;
    try {
      label = fn();
      state.players = withStats(state.players, state.history);
    } catch (err) {
      state = snapshot;
      throw err;
    }
    undoStack.push({ snapshot, label });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    return persistAndBroadcast();
  }

  // ---- public state --------------------------------------------------------

  function getPublicState() {
    const ref = (id) => ({ id, name: nameOf(id) });
    const showMatch = (m) => m && { id: m.id, isBoss: m.isBoss, players: m.players.map(ref) };

    return {
      phase: state.phase,
      matchSize: state.matchSize,
      currentMatch: showMatch(state.currentMatch),
      nextMatch: showMatch(state.nextMatch),
      leaderboard: buildLeaderboard(state.players, state.history),
      roundRobin: roundRobinProgress(state.players, state.history),
      champion: state.champion ? ref(state.champion) : null,
      recentMatches: state.history
        .slice(-RECENT_MATCHES)
        .reverse()
        .map((m) => ({ ...showMatch(m), outcome: m.outcome, at: m.at })),
      canUndo: undoStack.length > 0,
      joinUrl: getJoinUrl(),
    };
  }

  // ---- actions -------------------------------------------------------------

  function addPlayer(rawName) {
    return act(() => {
      if (typeof rawName !== 'string') throw new ActionError('Name is required');
      const name = rawName.trim();
      if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
        throw new ActionError(`Name must be 1-${MAX_NAME_LENGTH} characters`);
      }

      const existing = state.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
      let id = existing && existing.id;
      if (existing && existing.active) {
        throw new ActionError(`${existing.name} is already in the tournament`);
      }
      if (existing) {
        existing.active = true; // back with their old stats
      } else {
        do {
          id = `p_${crypto.randomBytes(4).toString('hex')}`;
        } while (findPlayer(id));
        state.players.push({
          id,
          name,
          active: true,
          points: 0,
          played: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          joinedAt: now().toISOString(),
        });
      }

      // A match with an open spot already has everyone in it: the newcomer joins.
      const current = state.currentMatch;
      if (state.phase === 'regular' && current && current.players.length < state.matchSize) {
        current.players.push(id);
      }

      refreshMatches();
      return existing ? `${existing.name} re-added` : `${name} added`;
    });
  }

  function removePlayer(id) {
    return act(() => {
      const player = findPlayer(id);
      if (!player || !player.active) throw new ActionError('Player not found');
      player.active = false;

      if (state.phase === 'boss' && isInMatch(state.currentMatch, id)) {
        // A boss player left: the boss battle is off.
        state.phase = 'regular';
        state.currentMatch = null;
        state.nextMatch = null;
        refreshMatches();
      } else if (isInMatch(state.currentMatch, id) || isInMatch(state.nextMatch, id)) {
        refreshMatches();
      }
      return `${player.name} removed`;
    });
  }

  function recordResult(outcome) {
    return act(() => {
      const match = state.currentMatch;
      if (!match) throw new ActionError('There is no current match');
      if (outcome !== 'draw' && !match.players.includes(outcome)) {
        throw new ActionError('Outcome must be a player in the match or "draw"');
      }

      const others = match.players.filter((id) => id !== outcome);
      const label =
        outcome === 'draw'
          ? `draw ${namesOf(match.players).join(' vs ')}`
          : `${nameOf(outcome)} beat ${namesOf(others).join(', ')}`;

      concludeCurrentMatch(outcome);

      if (match.isBoss) {
        if (outcome === 'draw') {
          // Rematch: the boss match stays current.
          state.currentMatch = { ...match, id: matchId(1) };
        } else {
          state.champion = outcome;
          state.phase = 'finished';
          state.currentMatch = null;
          state.nextMatch = null;
        }
        return `boss battle: ${label}`;
      }

      state.lastMatchPlayers = match.players;
      state.currentMatch = null;
      refreshMatches();
      return label;
    });
  }

  function skip() {
    return act(() => {
      if (state.phase !== 'regular') throw new ActionError('Skipping is only possible in the regular phase');
      const match = state.currentMatch;
      if (!match) throw new ActionError('There is no current match');

      concludeCurrentMatch('skipped');
      state.lastMatchPlayers = match.players;
      state.currentMatch = null;
      refreshMatches();
      return `skip ${namesOf(match.players).join(' vs ')}`;
    });
  }

  function startBoss(players) {
    return act(() => {
      if (state.phase !== 'regular') throw new ActionError('The boss battle can only start from the regular phase');
      if (!Array.isArray(players) || players.length < 2 || !players.every(isActive)) {
        throw new ActionError('Pick at least two active players');
      }
      if (new Set(players).size !== players.length) throw new ActionError('Pick different players');

      state.phase = 'boss';
      state.currentMatch = { id: matchId(1), players, isBoss: true };
      state.nextMatch = null;
      return 'boss battle start';
    });
  }

  function cancelBoss() {
    return act(() => {
      if (state.phase !== 'boss') throw new ActionError('There is no boss battle to cancel');
      state.phase = 'regular';
      state.currentMatch = null;
      state.nextMatch = null;
      refreshMatches();
      return 'boss battle cancel';
    });
  }

  function setMatchSize(size) {
    return act(() => {
      if (!Number.isInteger(size) || size < MIN_MATCH_SIZE || size > MAX_MATCH_SIZE) {
        throw new ActionError(`Players per match must be ${MIN_MATCH_SIZE}-${MAX_MATCH_SIZE}`);
      }
      if (size === state.matchSize) throw new ActionError(`Matches already have ${size} players`);
      state.matchSize = size;

      // The current match has no result yet, so it can simply be picked again.
      // A running boss battle is left alone; the new size applies after it.
      if (state.phase === 'regular') {
        state.currentMatch = null;
        state.nextMatch = null;
        refreshMatches();
      }
      return `players per match set to ${size}`;
    });
  }

  function resetScores() {
    return act(() => {
      state = {
        ...emptyState(),
        matchSize: state.matchSize,
        players: state.players.filter((p) => p.active),
      };
      refreshMatches();
      return 'reset scores';
    });
  }

  function resetAll() {
    return act(() => {
      state = emptyState();
      return 'reset everything';
    });
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) throw new ActionError('Nothing to undo');
    state = entry.snapshot;
    return { ...persistAndBroadcast(), undone: entry.label };
  }

  return {
    addPlayer,
    removePlayer,
    recordResult,
    skip,
    startBoss,
    cancelBoss,
    setMatchSize,
    undo,
    resetScores,
    resetAll,
    getPublicState,
    getState: () => state,
  };
}

module.exports = { createTournament, ActionError };
