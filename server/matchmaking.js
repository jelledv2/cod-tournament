'use strict';

// Pure matchmaking functions: state in, result out. No I/O.
// Randomness is injected (a function returning [0, 1)) so tests can seed it.

// Above this many waiting players the look-ahead gets slow on a Raspberry Pi,
// so we skip it. It kicks in again once fewer players are left waiting.
const LOOKAHEAD_LIMIT = 8;

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Pairs are [idA, idB] arrays; order doesn't matter.
function isSamePair(p, q) {
  return Boolean(p && q) && pairKey(p[0], p[1]) === pairKey(q[0], q[1]);
}

// Skipped matches and the boss battle don't count for stats or head-to-head.
function countsForStats(match) {
  return !match.isBoss && match.outcome !== 'skipped';
}

// Map of pairKey -> number of counted matches between those two players.
function headToHead(history) {
  const counts = new Map();
  for (const m of history) {
    if (!countsForStats(m)) continue;
    const key = pairKey(m.playerA, m.playerB);
    counts.set(key, (counts.get(key) || 0) + 1);
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
//   players:   [{ id, active, played, ... }]
//   history:   [{ playerA, playerB, outcome, isBoss }]
//   avoidPair: [idA, idB] of the previous match, or null
// Returns { playerA, playerB } or null when fewer than 2 players are active.
function pickMatch(players, history, avoidPair, random = Math.random) {
  const active = players.filter((p) => p.active);
  if (active.length < 2) return null;

  const met = headToHead(history);
  const faced = (a, b) => met.get(pairKey(a, b)) || 0;
  const previous = new Set(avoidPair || []);
  const inPrevious = (p) => (previous.has(p.id) ? 1 : 0);

  // Shuffle first; the sorts below are stable, so remaining ties are random.
  const pool = shuffle(active, random);

  // Player A: lowest played, preferably not in the previous match.
  const a = pool
    .slice()
    .sort((x, y) => x.played - y.played || inPrevious(x) - inPrevious(y))[0];

  // Hard rule: never the same matchup twice in a row (unless only 2 players).
  let candidates = pool.filter((p) => p.id !== a.id);
  if (candidates.length > 1) {
    candidates = candidates.filter((p) => !isSamePair([a.id, p.id], avoidPair));
  }

  // Player B: lowest played first (keeps match counts even), then fewest
  // meetings with A. The look-ahead adds the rematches we'd force on the other
  // players still waiting for their turn, so we don't paint them into a corner.
  const lowest = Math.min(...pool.map((p) => p.played));
  const waiting = pool.filter((p) => p.played === lowest && p.id !== a.id);
  const scored = candidates.map((b) => {
    const rest = waiting.filter((p) => p.id !== b.id).map((p) => p.id);
    const lookahead = rest.length <= LOOKAHEAD_LIMIT ? minRematches(rest, faced) : 0;
    const meetings = faced(a.id, b.id);
    return { b, meetings, cost: meetings + lookahead };
  });
  scored.sort(
    (x, y) =>
      x.b.played - y.b.played ||
      x.cost - y.cost ||
      x.meetings - y.meetings ||
      inPrevious(x.b) - inPrevious(y.b)
  );

  return { playerA: a.id, playerB: scored[0].b.id };
}

// "Up next": run the matchmaker as if `current` was already played.
function pickNextMatch(players, history, current, random = Math.random) {
  if (!current) return null;
  const pair = [current.playerA, current.playerB];
  const projectedPlayers = players.map((p) =>
    pair.includes(p.id) ? { ...p, played: p.played + 1 } : p
  );
  const projectedHistory = history.concat({
    playerA: current.playerA,
    playerB: current.playerB,
    outcome: 'projected',
    isBoss: false,
  });
  return pickMatch(projectedPlayers, projectedHistory, pair, random);
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
  isSamePair,
  countsForStats,
  headToHead,
  pickMatch,
  pickNextMatch,
  roundRobinProgress,
};
