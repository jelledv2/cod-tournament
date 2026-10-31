'use strict';

// Pure matchmaking functions: state in, result out. No I/O.
// Randomness is injected (a function returning [0, 1)) so tests can seed it.

// Above this many waiting players the look-ahead gets slow on a Raspberry Pi,
// so we skip it. It kicks in again once fewer players are left waiting.
const LOOKAHEAD_LIMIT = 8;

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Groups are arrays of player ids; order doesn't matter.
function isSameGroup(p, q) {
  return Boolean(p && q) && p.length === q.length && p.every((id) => q.includes(id));
}

// Skipped matches and the boss battle don't count for stats or head-to-head.
function countsForStats(match) {
  return !match.isBoss && match.outcome !== 'skipped';
}

// Map of pairKey -> number of counted matches that had both players in them.
function headToHead(history) {
  const counts = new Map();
  for (const m of history) {
    if (!countsForStats(m)) continue;
    for (let i = 0; i < m.players.length; i++) {
      for (let j = i + 1; j < m.players.length; j++) {
        const key = pairKey(m.players[i], m.players[j]);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
}

function shuffle(items, random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Fewest total previous meetings if we pair up `ids` among themselves
// (with an odd count, one player is left over).
function minRematches(ids, faced) {
  if (ids.length < 2) return 0;
  const [first, ...rest] = ids;
  let best = ids.length % 2 === 1 ? minRematches(rest, faced) : Infinity;
  for (let i = 0; i < rest.length; i++) {
    const others = rest.filter((_, j) => j !== i);
    best = Math.min(best, faced(first, rest[i]) + minRematches(others, faced));
  }
  return best;
}

// Pick the next match.
//   players: [{ id, active, played, ... }]
//   history: [{ players: [ids], outcome, isBoss }]
//   avoid:   [ids] of the previous match, or null
//   size:    how many players a match should have
// Returns { players: [ids] } or null when fewer than 2 players are active.
// With fewer active players than `size`, everyone plays.
function pickMatch(players, history, avoid, size, random = Math.random) {
  const active = players.filter((p) => p.active);
  if (active.length < 2) return null;

  const met = headToHead(history);
  const faced = (a, b) => met.get(pairKey(a, b)) || 0;
  const previous = new Set(avoid || []);
  const inPrevious = (p) => (previous.has(p.id) ? 1 : 0);

  // Shuffle first; the sorts below are stable, so remaining ties are random.
  const pool = shuffle(active, random);
  const target = Math.min(size, pool.length);

  // First player: lowest played, preferably not in the previous match.
  const first = pool
    .slice()
    .sort((x, y) => x.played - y.played || inPrevious(x) - inPrevious(y))[0];
  const group = [first.id];

  const lowest = Math.min(...pool.map((p) => p.played));
  const waiting = pool.filter((p) => p.played === lowest && p.id !== first.id);

  // The rest, one by one: lowest played first (keeps match counts even), then
  // fewest meetings with the players already in the match.
  while (group.length < target) {
    let candidates = pool.filter((p) => !group.includes(p.id));

    // Hard rule: never the same matchup twice in a row (unless there's no alternative).
    if (group.length === target - 1 && candidates.length > 1) {
      candidates = candidates.filter((p) => !isSameGroup([...group, p.id], avoid));
    }

    // In a 1v1 the look-ahead adds the rematches we'd force on the other players
    // still waiting for their turn, so we don't paint them into a corner.
    const scored = candidates.map((c) => {
      const rest = waiting.filter((p) => p.id !== c.id).map((p) => p.id);
      const lookahead = target === 2 && rest.length <= LOOKAHEAD_LIMIT ? minRematches(rest, faced) : 0;
      const meetings = group.reduce((sum, id) => sum + faced(id, c.id), 0);
      return { c, meetings, cost: meetings + lookahead };
    });
    scored.sort(
      (x, y) =>
        x.c.played - y.c.played ||
        x.cost - y.cost ||
        x.meetings - y.meetings ||
        inPrevious(x.c) - inPrevious(y.c)
    );
    group.push(scored[0].c.id);
  }

  return { players: group };
}

// "Up next": run the matchmaker as if `current` was already played.
function pickNextMatch(players, history, current, size, random = Math.random) {
  if (!current) return null;
  const projectedPlayers = players.map((p) =>
    current.players.includes(p.id) ? { ...p, played: p.played + 1 } : p
  );
  const projectedHistory = history.concat({
    players: current.players,
    outcome: 'projected',
    isBoss: false,
  });
  return pickMatch(projectedPlayers, projectedHistory, current.players, size, random);
}

// How many unique pairs of active players have played at least once.
function roundRobinProgress(players, history) {
  const ids = players.filter((p) => p.active).map((p) => p.id);
  const met = headToHead(history);
  let done = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (met.has(pairKey(ids[i], ids[j]))) done++;
    }
  }
  return { done, total: (ids.length * (ids.length - 1)) / 2 };
}

module.exports = {
  pairKey,
  isSameGroup,
  countsForStats,
  headToHead,
  pickMatch,
  pickNextMatch,
  roundRobinProgress,
};
