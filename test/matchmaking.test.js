'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pairKey,
  isSamePair,
  pickMatch,
  pickNextMatch,
  roundRobinProgress,
} = require('../server/matchmaking');

const SEEDS = 200;

// Small seeded PRNG (mulberry32) so every run is reproducible.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, active: true, played: 0 }));
}

// Plays `count` matches the way the tournament does: the current match is
// picked (or promoted from "up next"), then played or skipped.
function simulate({ players, count, random, skipChance = 0, onMatch }) {
  const history = [];
  let last = null;
  for (let i = 0; i < count; i++) {
    const match = pickMatch(players, history, last, random);
    if (!match) break;
    const skipped = random() < skipChance;
    const outcome = skipped ? 'skipped' : ['A', 'B', 'draw'][Math.floor(random() * 3)];
    history.push({ ...match, outcome, isBoss: false });
    if (!skipped) {
      for (const p of players) {
        if (p.id === match.playerA || p.id === match.playerB) p.played++;
      }
    }
    if (onMatch) onMatch(match, i, history, last);
    last = [match.playerA, match.playerB];
  }
  return history;
}

test('6 players, 30 matches: played never differs by more than 1', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const players = makePlayers(6);
    simulate({
      players,
      count: 30,
      random: seededRandom(seed),
      onMatch: (_match, i) => {
        const played = players.map((p) => p.played);
        const spread = Math.max(...played) - Math.min(...played);
        assert.ok(spread <= 1, `seed ${seed}, match ${i + 1}: spread ${spread}`);
      },
    });
  }
});

test('6 players: all 15 pairs have met within 20 matches', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const players = makePlayers(6);
    const history = simulate({ players, count: 20, random: seededRandom(seed) });
    const pairs = new Set(history.map((m) => pairKey(m.playerA, m.playerB)));
    assert.equal(pairs.size, 15, `seed ${seed}: only ${pairs.size} pairs`);
    assert.deepEqual(roundRobinProgress(players, history), { done: 15, total: 15 });
  }
});

test('same matchup never appears twice in a row, including after skips', () => {
  for (const n of [3, 4, 5, 6, 9]) {
    for (let seed = 1; seed <= 50; seed++) {
      simulate({
        players: makePlayers(n),
        count: 40,
        random: seededRandom(seed),
        skipChance: 0.3,
        onMatch: (match, i, _history, last) => {
          assert.notEqual(match.playerA, match.playerB);
          assert.ok(
            !isSamePair([match.playerA, match.playerB], last),
            `${n} players, seed ${seed}, match ${i + 1}: repeated matchup`
          );
        },
      });
    }
  }
});

test('"up next" is never the same matchup as the current match', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const random = seededRandom(seed);
    const players = makePlayers(4);
    simulate({
      players,
      count: 20,
      random,
      onMatch: (match, _i, history) => {
        // history already contains `match`; "up next" is computed before it is played
        const before = history.slice(0, -1);
        const playersBefore = players.map((p) =>
          p.id === match.playerA || p.id === match.playerB ? { ...p, played: p.played - 1 } : p
        );
        const next = pickNextMatch(playersBefore, before, match, random);
        assert.ok(!isSamePair([next.playerA, next.playerB], [match.playerA, match.playerB]));
      },
    });
  }
});

test('exactly 2 players keep getting matched', () => {
  const players = makePlayers(2);
  const history = simulate({ players, count: 10, random: seededRandom(1), skipChance: 0.3 });
  assert.equal(history.length, 10);
  for (const m of history) {
    assert.equal(pairKey(m.playerA, m.playerB), 'p1|p2');
  }
  const next = pickNextMatch(players, history, history[9], seededRandom(2));
  assert.equal(pairKey(next.playerA, next.playerB), 'p1|p2');
});

test('a late joiner with 0 played is picked before players with more matches', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const random = seededRandom(seed);
    const players = makePlayers(5);
    const history = simulate({ players, count: 12, random });
    const last = history[history.length - 1];
    players.push({ id: 'late', active: true, played: 0 });

    const match = pickMatch(players, history, [last.playerA, last.playerB], random);
    assert.equal(match.playerA, 'late', `seed ${seed}`);
  }
});

test('removed players are never picked', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const players = makePlayers(6);
    players[1].active = false;
    players[4].active = false;
    simulate({
      players,
      count: 20,
      random: seededRandom(seed),
      skipChance: 0.2,
      onMatch: (match) => {
        for (const id of [match.playerA, match.playerB]) {
          assert.ok(id !== 'p2' && id !== 'p5', `seed ${seed}: picked removed player ${id}`);
        }
      },
    });
  }
});

test('fewer than 2 active players: no match', () => {
  assert.equal(pickMatch([], [], null, seededRandom(1)), null);
  assert.equal(pickMatch(makePlayers(1), [], null, seededRandom(1)), null);

  const players = makePlayers(3);
  players[0].active = false;
  players[1].active = false;
  assert.equal(pickMatch(players, [], null, seededRandom(1)), null);
  assert.equal(pickNextMatch(players, [], null, seededRandom(1)), null);
});

test('round-robin progress ignores skips, boss matches and removed players', () => {
  const players = makePlayers(4);
  const history = [
    { playerA: 'p1', playerB: 'p2', outcome: 'A', isBoss: false },
    { playerA: 'p2', playerB: 'p1', outcome: 'draw', isBoss: false },
    { playerA: 'p3', playerB: 'p4', outcome: 'skipped', isBoss: false },
    { playerA: 'p1', playerB: 'p3', outcome: 'A', isBoss: true },
    { playerA: 'p2', playerB: 'p4', outcome: 'B', isBoss: false },
  ];
  assert.deepEqual(roundRobinProgress(players, history), { done: 2, total: 6 });

  players[3].active = false;
  assert.deepEqual(roundRobinProgress(players, history), { done: 1, total: 3 });
});
