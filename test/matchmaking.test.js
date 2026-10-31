'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pairKey,
  isSameGroup,
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
function simulate({ players, count, random, size = 2, skipChance = 0, onMatch }) {
  const history = [];
  let last = null;
  for (let i = 0; i < count; i++) {
    const match = pickMatch(players, history, last, size, random);
    if (!match) break;
    const skipped = random() < skipChance;
    const options = [...match.players, 'draw'];
    const outcome = skipped ? 'skipped' : options[Math.floor(random() * options.length)];
    history.push({ ...match, outcome, isBoss: false });
    if (!skipped) {
      for (const p of players) {
        if (match.players.includes(p.id)) p.played++;
      }
    }
    if (onMatch) onMatch(match, i, history, last);
    last = match.players;
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
    const pairs = new Set(history.map((m) => pairKey(...m.players)));
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
          assert.notEqual(match.players[0], match.players[1]);
          assert.ok(
            !isSameGroup(match.players, last),
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
          match.players.includes(p.id) ? { ...p, played: p.played - 1 } : p
        );
        const next = pickNextMatch(playersBefore, before, match, 2, random);
        assert.ok(!isSameGroup(next.players, match.players));
      },
    });
  }
});

test('exactly 2 players keep getting matched', () => {
  const players = makePlayers(2);
  const history = simulate({ players, count: 10, random: seededRandom(1), skipChance: 0.3 });
  assert.equal(history.length, 10);
  for (const m of history) {
    assert.equal(pairKey(...m.players), 'p1|p2');
  }
  const next = pickNextMatch(players, history, history[9], 2, seededRandom(2));
  assert.equal(pairKey(...next.players), 'p1|p2');
});

test('a late joiner with 0 played is picked before players with more matches', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const random = seededRandom(seed);
    const players = makePlayers(5);
    const history = simulate({ players, count: 12, random });
    const last = history[history.length - 1];
    players.push({ id: 'late', active: true, played: 0 });

    const match = pickMatch(players, history, last.players, 2, random);
    assert.equal(match.players[0], 'late', `seed ${seed}`);
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
        for (const id of match.players) {
          assert.ok(id !== 'p2' && id !== 'p5', `seed ${seed}: picked removed player ${id}`);
        }
      },
    });
  }
});

test('fewer than 2 active players: no match', () => {
  assert.equal(pickMatch([], [], null, 2, seededRandom(1)), null);
  assert.equal(pickMatch(makePlayers(1), [], null, 4, seededRandom(1)), null);

  const players = makePlayers(3);
  players[0].active = false;
  players[1].active = false;
  assert.equal(pickMatch(players, [], null, 2, seededRandom(1)), null);
  assert.equal(pickNextMatch(players, [], null, 2, seededRandom(1)), null);
});

test('round-robin progress ignores skips, boss matches and removed players', () => {
  const players = makePlayers(4);
  const history = [
    { players: ['p1', 'p2'], outcome: 'p1', isBoss: false },
    { players: ['p2', 'p1'], outcome: 'draw', isBoss: false },
    { players: ['p3', 'p4'], outcome: 'skipped', isBoss: false },
    { players: ['p1', 'p3'], outcome: 'p1', isBoss: true },
    { players: ['p2', 'p4'], outcome: 'p4', isBoss: false },
  ];
  assert.deepEqual(roundRobinProgress(players, history), { done: 2, total: 6 });

  players[3].active = false;
  assert.deepEqual(roundRobinProgress(players, history), { done: 1, total: 3 });
});

test('matches have the configured size, with distinct players', () => {
  for (const [size, n] of [[3, 6], [4, 8], [4, 5], [8, 9]]) {
    for (let seed = 1; seed <= 30; seed++) {
      simulate({
        players: makePlayers(n),
        count: 20,
        size,
        random: seededRandom(seed),
        onMatch: (match) => {
          assert.equal(match.players.length, size);
          assert.equal(new Set(match.players).size, size);
        },
      });
    }
  }
});

test('more spots than active players: everyone plays', () => {
  const players = makePlayers(3);
  const match = pickMatch(players, [], ['p1', 'p2', 'p3'], 4, seededRandom(1));
  assert.deepEqual(match.players.slice().sort(), ['p1', 'p2', 'p3']);
});

test('larger matches: played stays even, no group twice in a row, removed players stay out', () => {
  for (const [size, n] of [[3, 6], [3, 4], [4, 8], [4, 5], [4, 7], [5, 6], [8, 9]]) {
    for (let seed = 1; seed <= 50; seed++) {
      const players = makePlayers(n + 1);
      players[n].active = false;
      simulate({
        players,
        count: 30,
        size,
        random: seededRandom(seed),
        onMatch: (match, i, _history, last) => {
          const label = `size ${size}, ${n} players, seed ${seed}, match ${i + 1}`;
          assert.ok(!isSameGroup(match.players, last), `${label}: repeated group`);
          assert.ok(!match.players.includes(`p${n + 1}`), `${label}: removed player`);
          const played = players.filter((p) => p.active).map((p) => p.played);
          assert.ok(Math.max(...played) - Math.min(...played) <= 1, `${label}: uneven`);
        },
      });
    }
  }
});

test('larger matches: no repeated group after skips either', () => {
  for (const [size, n] of [[3, 4], [4, 5], [4, 8]]) {
    for (let seed = 1; seed <= 50; seed++) {
      simulate({
        players: makePlayers(n),
        count: 30,
        size,
        skipChance: 0.3,
        random: seededRandom(seed),
        onMatch: (match, _i, _history, last) => {
          assert.ok(!isSameGroup(match.players, last), `size ${size}, ${n} players, seed ${seed}`);
        },
      });
    }
  }
});

test('larger matches: everyone meets everyone quickly', () => {
  for (const [size, n, within] of [[3, 6, 14], [4, 8, 8], [3, 9, 24]]) {
    for (let seed = 1; seed <= 50; seed++) {
      const players = makePlayers(n);
      const history = simulate({ players, count: within, size, random: seededRandom(seed) });
      const { done, total } = roundRobinProgress(players, history);
      assert.equal(done, total, `size ${size}, ${n} players, seed ${seed}: ${done}/${total}`);
    }
  }
});

test('"up next" has the configured size and differs from the current group', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const random = seededRandom(seed);
    const players = makePlayers(5);
    const current = pickMatch(players, [], null, 4, random);
    const next = pickNextMatch(players, [], current, 4, random);
    assert.equal(next.players.length, 4);
    assert.ok(!isSameGroup(next.players, current.players));
  }
});
