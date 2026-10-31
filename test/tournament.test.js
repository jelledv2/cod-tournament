'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTournament, ActionError } = require('../server/tournament');
const { isSameGroup } = require('../server/matchmaking');
const { emptyState, migrate } = require('../server/store');

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(names = [], seed = 1) {
  const t = createTournament({ random: seededRandom(seed) });
  for (const name of names) t.addPlayer(name);
  return t;
}

const snapshot = (t) => structuredClone(t.getState());
const byName = (t, name) => t.getState().players.find((p) => p.name === name);
const byId = (t, id) => t.getState().players.find((p) => p.id === id);
const stats = (p) => ({ points: p.points, played: p.played, wins: p.wins, draws: p.draws, losses: p.losses });
const currentPair = (t) => [...t.getState().currentMatch.players];

// The player in the given seat of the current match, to use as the winner.
const seat = (t, i) => t.getState().currentMatch.players[i];
const randomOutcome = (t, random) => {
  const options = [...currentPair(t), 'draw'];
  return options[Math.floor(random() * options.length)];
};

test('points/played/W/D/L are correct after wins, draws and skips', () => {
  const t = setup(['Sam', 'Alex']); // 2 players: always the same matchup
  const [playerA, playerB] = currentPair(t);

  t.recordResult(seat(t, 0));
  assert.deepEqual(stats(byId(t, playerA)), { points: 1, played: 1, wins: 1, draws: 0, losses: 0 });
  assert.deepEqual(stats(byId(t, playerB)), { points: 0, played: 1, wins: 0, draws: 0, losses: 1 });

  const second = t.getState().currentMatch;
  t.recordResult('draw');
  t.recordResult(playerB);
  assert.ok(isSameGroup(second.players, [playerA, playerB]));
  assert.deepEqual(stats(byId(t, playerA)), { points: 1, played: 3, wins: 1, draws: 1, losses: 1 });
  assert.deepEqual(stats(byId(t, playerB)), { points: 1, played: 3, wins: 1, draws: 1, losses: 1 });

  const before = t.getState().players.map(stats);
  t.skip();
  t.skip();
  assert.deepEqual(t.getState().players.map(stats), before, 'skips change nothing');
  assert.equal(t.getState().history.length, 5);
  assert.equal(t.getState().history[4].outcome, 'skipped');
  assert.equal(t.getState().matchCounter, 5);
});

test('stored stats always match the public leaderboard', () => {
  const random = seededRandom(7);
  const t = setup(['A', 'B', 'C', 'D', 'E'], 7);
  for (let i = 0; i < 25; i++) {
    const r = random();
    if (r < 0.2) t.skip();
    else t.recordResult(randomOutcome(t, random));
  }
  const rows = t.getPublicState().leaderboard;
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.deepEqual(stats(row), stats(byId(t, row.id)));
    assert.equal(row.played, row.wins + row.draws + row.losses);
    assert.equal(row.points, row.wins);
  }
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].points >= rows[i].points, 'sorted by points');
  }
});

test('undo restores the exact previous state for every action type', () => {
  const t = setup(['Sam', 'Alex', 'Bo', 'Kim']);
  t.recordResult(seat(t, 0));
  t.recordResult('draw');

  const actions = [
    () => t.recordResult(seat(t, 1)),
    () => t.skip(),
    () => t.addPlayer('Late'),
    () => t.removePlayer(seat(t, 0)),
    () => t.startBoss([byName(t, 'Sam').id, byName(t, 'Alex').id]),
    () => t.resetScores(),
    () => t.resetAll(),
  ];
  for (const action of actions) {
    const before = snapshot(t);
    action();
    assert.notDeepEqual(t.getState(), before);
    const result = t.undo();
    assert.deepEqual(t.getState(), before);
    assert.equal(typeof result.undone, 'string');
  }

  // boss cancel and boss result
  t.startBoss([byName(t, 'Sam').id, byName(t, 'Alex').id]);
  const inBoss = snapshot(t);
  t.cancelBoss();
  t.undo();
  assert.deepEqual(t.getState(), inBoss);
  t.recordResult(seat(t, 0));
  assert.equal(t.getState().phase, 'finished');
  t.undo();
  assert.deepEqual(t.getState(), inBoss);
});

test('undo steps back through several actions and then runs out', () => {
  const t = setup(['Sam', 'Alex', 'Bo']);
  const start = snapshot(t);
  t.recordResult(seat(t, 0));
  const afterOne = snapshot(t);
  t.resetScores();
  t.recordResult(seat(t, 1));

  t.undo();
  t.undo();
  assert.deepEqual(t.getState(), afterOne);
  t.undo();
  assert.deepEqual(t.getState(), start);

  t.undo(); // Bo added
  t.undo(); // Alex added
  t.undo(); // Sam added
  assert.equal(t.getState().players.length, 0);
  assert.throws(() => t.undo(), ActionError);
});

test('undo history is capped at 30', () => {
  const t = setup(['Sam', 'Alex', 'Bo']);
  for (let i = 0; i < 40; i++) t.recordResult(seat(t, 0));
  for (let i = 0; i < 30; i++) t.undo();
  assert.equal(t.getState().history.length, 10);
  assert.throws(() => t.undo(), ActionError);
});

test('reset scores keeps players and clears stats/history', () => {
  const t = setup(['Sam', 'Alex', 'Bo', 'Kim']);
  for (let i = 0; i < 6; i++) t.recordResult(seat(t, 0));
  t.skip();
  t.removePlayer(byName(t, 'Kim').id);
  t.startBoss([byName(t, 'Sam').id, byName(t, 'Alex').id]);
  t.recordResult(seat(t, 0));
  assert.equal(t.getState().phase, 'finished');

  t.resetScores();
  const s = t.getState();
  assert.deepEqual(s.players.map((p) => p.name).sort(), ['Alex', 'Bo', 'Sam']);
  for (const p of s.players) {
    assert.deepEqual(stats(p), { points: 0, played: 0, wins: 0, draws: 0, losses: 0 });
    assert.equal(p.active, true);
  }
  assert.deepEqual(s.history, []);
  assert.equal(s.champion, null);
  assert.equal(s.phase, 'regular');
  assert.equal(s.matchCounter, 0);
  assert.ok(s.currentMatch, 'matches are regenerated');
  assert.ok(s.nextMatch);
});

test('reset all wipes everything', () => {
  const t = setup(['Sam', 'Alex', 'Bo']);
  t.recordResult(seat(t, 0));
  t.resetAll();
  const s = t.getState();
  assert.deepEqual(s.players, []);
  assert.deepEqual(s.history, []);
  assert.equal(s.currentMatch, null);
  assert.equal(s.nextMatch, null);
});

test('removing a player who is in the current match replaces the match', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const t = setup(['Sam', 'Alex', 'Bo', 'Kim', 'Lee'], seed);
    t.recordResult(seat(t, 0));
    const removed = seat(t, 0);

    t.removePlayer(removed);
    const s = t.getState();
    assert.equal(byId(t, removed).active, false, 'soft delete');
    assert.equal(s.history.length, 1, 'history stays');
    for (const match of [s.currentMatch, s.nextMatch]) {
      assert.ok(match);
      assert.ok(!currentPair(t).includes(removed));
      assert.ok(!match.players.includes(removed));
    }
    assert.ok(!isSameGroup(currentPair(t), s.lastMatchPlayers), 'not the previous matchup again');
  }
});

test('removing a player from "up next" recomputes it and keeps the current match', () => {
  const t = setup(['Sam', 'Alex', 'Bo', 'Kim', 'Lee']);
  const current = t.getState().currentMatch;
  const removed = t.getState().nextMatch.players[0];
  t.removePlayer(removed);
  assert.deepEqual(t.getState().currentMatch, current);
  const next = t.getState().nextMatch;
  assert.ok(!next.players.includes(removed));
});

test('dropping below 2 active players clears the matches', () => {
  const t = setup(['Sam', 'Alex']);
  t.removePlayer(byName(t, 'Sam').id);
  assert.equal(t.getState().currentMatch, null);
  assert.equal(t.getState().nextMatch, null);
  assert.throws(() => t.recordResult('draw'), ActionError);
  assert.throws(() => t.skip(), ActionError);
});

test('adding players: first match appears at 2, current match is kept afterwards', () => {
  const t = setup(['Sam']);
  assert.equal(t.getState().currentMatch, null);
  t.addPlayer('Alex');
  const current = t.getState().currentMatch;
  assert.ok(current);
  assert.equal(current.id, 'm_1');

  t.addPlayer('Bo');
  assert.deepEqual(t.getState().currentMatch, current);
  const next = t.getState().nextMatch;
  assert.equal(next.id, 'm_2');
  assert.ok(next.players.includes(byName(t, 'Bo').id), 'newcomer is up next');
});

test('player names are validated; re-adding reactivates with stats intact', () => {
  const t = setup(['Sam', 'Alex']);
  assert.throws(() => t.addPlayer('   '), ActionError);
  assert.throws(() => t.addPlayer('x'.repeat(21)), ActionError);
  assert.throws(() => t.addPlayer(undefined), ActionError);
  assert.throws(() => t.addPlayer(' sAM '), ActionError);
  assert.throws(() => t.removePlayer('p_nope'), ActionError);
  assert.equal(t.getState().players.length, 2);

  t.addPlayer('  Bo  ');
  assert.ok(byName(t, 'Bo'), 'name is trimmed');

  t.recordResult(seat(t, 0));
  const winner = t.getState().history[0].players[0];
  const name = byId(t, winner).name;
  t.removePlayer(winner);
  assert.throws(() => t.removePlayer(winner), ActionError);
  t.addPlayer(name.toUpperCase());
  assert.equal(t.getState().players.length, 3, 'no duplicate created');
  assert.equal(byId(t, winner).active, true);
  assert.equal(byId(t, winner).points, 1);
});

test('invalid actions are rejected and leave the state untouched', () => {
  const t = setup(['Sam', 'Alex', 'Bo']);
  const before = snapshot(t);
  const sam = byName(t, 'Sam').id;
  assert.throws(() => t.recordResult('C'), ActionError);
  assert.throws(() => t.cancelBoss(), ActionError);
  assert.throws(() => t.startBoss([sam, sam]), ActionError);
  assert.throws(() => t.startBoss([sam, 'p_nope']), ActionError);
  assert.deepEqual(t.getState(), before);
  assert.equal(t.getPublicState().canUndo, true); // the 3 adds
  t.undo();
  t.undo();
  t.undo();
  assert.equal(t.getPublicState().canUndo, false, 'failed actions are not on the undo stack');
});

test('boss flow: start -> draw -> win sets the champion without touching the leaderboard', () => {
  const t = setup(['Sam', 'Alex', 'Bo', 'Kim']);
  for (let i = 0; i < 8; i++) t.recordResult(i % 3 === 0 ? 'draw' : seat(t, 0));
  const statsBefore = t.getState().players.map(stats);
  const leaderboardBefore = t.getPublicState().leaderboard;
  const [first, second] = leaderboardBefore;

  t.startBoss([first.id, second.id]);
  let s = t.getState();
  assert.equal(s.phase, 'boss');
  assert.equal(s.currentMatch.isBoss, true);
  assert.deepEqual(s.currentMatch.players, [first.id, second.id]);
  assert.equal(s.nextMatch, null);
  assert.throws(() => t.skip(), ActionError, 'no skipping the boss battle');

  t.recordResult('draw');
  s = t.getState();
  assert.equal(s.phase, 'boss', 'draw means rematch');
  assert.equal(s.champion, null);
  assert.deepEqual(s.currentMatch.players, [first.id, second.id]);

  t.recordResult(seat(t, 1));
  s = t.getState();
  assert.equal(s.phase, 'finished');
  assert.equal(s.champion, second.id);
  assert.equal(s.currentMatch, null);
  assert.deepEqual(t.getPublicState().champion, { id: second.id, name: second.name });

  assert.deepEqual(s.players.map(stats), statsBefore);
  assert.deepEqual(t.getPublicState().leaderboard, leaderboardBefore);
  assert.deepEqual(t.getPublicState().roundRobin, { done: 6, total: 6 });
});

test('cancelling the boss battle returns to regular play', () => {
  const t = setup(['Sam', 'Alex', 'Bo', 'Kim']);
  t.recordResult(seat(t, 0));
  t.startBoss([byName(t, 'Sam').id, byName(t, 'Alex').id]);
  t.addPlayer('Late'); // allowed, doesn't touch the boss match
  assert.equal(t.getState().currentMatch.isBoss, true);

  t.cancelBoss();
  const s = t.getState();
  assert.equal(s.phase, 'regular');
  assert.equal(s.currentMatch.isBoss, false);
  assert.ok(s.nextMatch);
  assert.ok(!isSameGroup(currentPair(t), s.lastMatchPlayers));
});

test('removing a boss player cancels the boss battle; removing someone else does not', () => {
  const t = setup(['Sam', 'Alex', 'Bo', 'Kim']);
  t.startBoss([byName(t, 'Sam').id, byName(t, 'Alex').id]);

  t.removePlayer(byName(t, 'Kim').id);
  assert.equal(t.getState().phase, 'boss');

  t.removePlayer(byName(t, 'Sam').id);
  const s = t.getState();
  assert.equal(s.phase, 'regular');
  assert.equal(s.currentMatch.isBoss, false);
  assert.deepEqual(currentPair(t).sort(), [byName(t, 'Alex').id, byName(t, 'Bo').id].sort());
});

test('a whole evening: no repeated matchup in a row, match counts stay even', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const random = seededRandom(seed * 13);
    const t = setup(['A', 'B', 'C', 'D', 'E', 'F'], seed);
    let skipped = false;
    for (let i = 0; i < 40; i++) {
      const before = currentPair(t);
      if (random() < 0.25) {
        t.skip();
        skipped = true;
      } else {
        t.recordResult(randomOutcome(t, random));
      }
      const s = t.getState();
      assert.ok(!isSameGroup(currentPair(t), before), `seed ${seed}: repeated matchup`);
      assert.ok(!isSameGroup(s.nextMatch.players, currentPair(t)));
      assert.deepEqual(s.lastMatchPlayers, before);
      if (!skipped) {
        const played = s.players.map((p) => p.played);
        assert.ok(Math.max(...played) - Math.min(...played) <= 1, `seed ${seed}: uneven`);
      }
    }
  }
});

test('every action saves and broadcasts the public state', () => {
  const saved = [];
  const broadcast = [];
  const t = createTournament({
    random: seededRandom(1),
    save: (state) => saved.push(structuredClone(state)),
    onChange: (pub) => broadcast.push(pub),
    getJoinUrl: () => 'http://192.168.1.42:3000',
  });
  t.addPlayer('Sam');
  t.addPlayer('Alex');
  const winner = seat(t, 0);
  const pub = t.recordResult(winner);
  t.undo();
  assert.throws(() => t.recordResult('nope'), ActionError);

  assert.equal(saved.length, 4);
  assert.equal(broadcast.length, 4);
  assert.equal(saved[2].history.length, 1);
  assert.equal(saved[3].history.length, 0);
  assert.deepEqual(broadcast[2], pub);

  assert.equal(pub.joinUrl, 'http://192.168.1.42:3000');
  assert.equal(pub.recentMatches.length, 1);
  assert.equal(pub.recentMatches[0].outcome, winner);
  assert.equal(typeof pub.currentMatch.players[0].name, 'string');
  assert.deepEqual(pub.roundRobin, { done: 1, total: 1 });
});

test('a failing save does not break the action', () => {
  const t = createTournament({
    random: seededRandom(1),
    save: () => {
      throw new Error('disk full');
    },
  });
  const realError = console.error;
  console.error = () => {};
  try {
    t.addPlayer('Sam');
  } finally {
    console.error = realError;
  }
  assert.equal(t.getState().players.length, 1);
});

function setupWithSize(size, names, seed = 1) {
  const t = setup([], seed);
  t.setMatchSize(size);
  for (const name of names) t.addPlayer(name);
  return t;
}

test('a free-for-all: one winner gets the point, everyone else a loss', () => {
  const t = setupWithSize(4, ['A', 'B', 'C', 'D', 'E', 'F']);
  const [w, x, y, z] = currentPair(t);
  assert.equal(currentPair(t).length, 4);

  t.recordResult(w);
  assert.deepEqual(stats(byId(t, w)), { points: 1, played: 1, wins: 1, draws: 0, losses: 0 });
  for (const id of [x, y, z]) {
    assert.deepEqual(stats(byId(t, id)), { points: 0, played: 1, wins: 0, draws: 0, losses: 1 });
  }
  const last = t.getState().history[0];
  assert.deepEqual(last.players, [w, x, y, z]);
  assert.equal(last.outcome, w);
  assert.deepEqual(t.getPublicState().roundRobin, { done: 6, total: 15 }, 'a match of 4 covers 6 pairs');

  const group = currentPair(t);
  const drawsBefore = group.map((id) => byId(t, id).draws);
  t.recordResult('draw');
  group.forEach((id, i) => assert.equal(byId(t, id).draws, drawsBefore[i] + 1));
});

test('only a player in the match can win it', () => {
  const t = setupWithSize(3, ['A', 'B', 'C', 'D']);
  const outsider = t.getState().players.find((p) => !currentPair(t).includes(p.id));
  assert.throws(() => t.recordResult(outsider.id), ActionError);
  assert.throws(() => t.recordResult('A'), ActionError);
  assert.equal(t.getState().history.length, 0);
});

test('adding players fills up the current match until it has the configured size', () => {
  const t = setupWithSize(4, ['A', 'B']);
  assert.equal(currentPair(t).length, 2);
  t.addPlayer('C');
  assert.equal(currentPair(t).length, 3);
  t.addPlayer('D');
  assert.equal(currentPair(t).length, 4);

  const full = currentPair(t);
  t.addPlayer('E');
  assert.deepEqual(currentPair(t), full, 'a full match is kept');
  assert.equal(t.getState().nextMatch.players.length, 4);
  assert.ok(t.getState().nextMatch.players.includes(byName(t, 'E').id), 'newcomer is up next');
});

test('changing the match size re-picks the matches and can be undone', () => {
  const t = setup(['A', 'B', 'C', 'D', 'E', 'F']);
  t.recordResult(seat(t, 0));
  const before = snapshot(t);

  t.setMatchSize(3);
  const s = t.getState();
  assert.equal(s.matchSize, 3);
  assert.equal(s.currentMatch.players.length, 3);
  assert.equal(s.nextMatch.players.length, 3);
  assert.equal(s.history.length, 1, 'results are kept');
  assert.equal(t.getPublicState().matchSize, 3);

  assert.match(t.undo().undone, /3/);
  assert.deepEqual(t.getState(), before);

  for (const bad of [1, 9, 2.5, '3', undefined]) {
    assert.throws(() => t.setMatchSize(bad), ActionError);
  }
  assert.throws(() => t.setMatchSize(2), ActionError, 'already 2');
  assert.deepEqual(t.getState(), before);
});

test('removing a player from a match with an open spot leaves everyone else playing', () => {
  const t = setupWithSize(4, ['A', 'B', 'C']);
  t.removePlayer(byName(t, 'C').id);
  assert.deepEqual(currentPair(t).sort(), [byName(t, 'A').id, byName(t, 'B').id].sort());
  t.removePlayer(byName(t, 'B').id);
  assert.equal(t.getState().currentMatch, null);
});

test('reset scores keeps the match size, reset all goes back to 2', () => {
  const t = setupWithSize(3, ['A', 'B', 'C', 'D']);
  t.resetScores();
  assert.equal(t.getState().matchSize, 3);
  assert.equal(currentPair(t).length, 3);
  t.resetAll();
  assert.equal(t.getState().matchSize, 2);
});

test('boss battle with more than 2 players; the size only changes after it', () => {
  const t = setupWithSize(3, ['A', 'B', 'C', 'D']);
  t.recordResult(seat(t, 0));
  const statsBefore = t.getState().players.map(stats);
  const trio = ['A', 'B', 'C'].map((n) => byName(t, n).id);

  t.startBoss(trio);
  t.setMatchSize(2);
  assert.deepEqual(currentPair(t), trio, 'boss match untouched');
  t.recordResult('draw');
  assert.equal(t.getState().phase, 'boss');
  t.recordResult(trio[2]);

  const s = t.getState();
  assert.equal(s.phase, 'finished');
  assert.equal(s.champion, trio[2]);
  assert.deepEqual(s.players.map(stats), statsBefore);

  t.undo(); // the win
  t.undo(); // the draw
  t.cancelBoss();
  assert.equal(t.getState().currentMatch.players.length, 2, 'new size applies after the boss battle');
  assert.throws(() => t.startBoss([trio[0]]), ActionError, 'needs at least two');
});

test('a whole evening of free-for-alls stays even and never repeats a group', () => {
  for (const [size, count] of [[3, 7], [4, 9], [4, 5], [5, 11]]) {
    for (let seed = 1; seed <= 20; seed++) {
      const random = seededRandom(seed * 7);
      const names = Array.from({ length: count }, (_, i) => `P${i}`);
      const t = setupWithSize(size, names, seed);
      for (let i = 0; i < 40; i++) {
        const before = currentPair(t);
        assert.equal(before.length, size);
        assert.equal(new Set(before).size, size);
        t.recordResult(randomOutcome(t, random));
        const s = t.getState();
        assert.ok(!isSameGroup(currentPair(t), before), `${size}/${count} seed ${seed}: repeated group`);
        const played = s.players.map((p) => p.played);
        assert.ok(Math.max(...played) - Math.min(...played) <= 1, `${size}/${count} seed ${seed}: uneven`);
      }
    }
  }
});

test('a save file from before configurable match sizes still loads', () => {
  const saved = {
    phase: 'regular',
    matchCounter: 2,
    players: [
      { id: 'p1', name: 'Sam', active: true, points: 1, played: 2, wins: 1, draws: 1, losses: 0 },
      { id: 'p2', name: 'Alex', active: true, points: 0, played: 2, wins: 0, draws: 1, losses: 1 },
      { id: 'p3', name: 'Bo', active: true, points: 0, played: 0, wins: 0, draws: 0, losses: 0 },
    ],
    currentMatch: { id: 'm_3', playerA: 'p3', playerB: 'p1', isBoss: false },
    nextMatch: { id: 'm_4', playerA: 'p3', playerB: 'p2', isBoss: false },
    lastMatchPair: ['p2', 'p1'],
    history: [
      { id: 'm_1', playerA: 'p1', playerB: 'p2', outcome: 'draw', isBoss: false, at: 'x' },
      { id: 'm_2', playerA: 'p2', playerB: 'p1', outcome: 'B', isBoss: false, at: 'y' },
    ],
    champion: null,
  };
  const state = migrate(saved);
  assert.equal(state.matchSize, 2);
  assert.deepEqual(state.lastMatchPlayers, ['p2', 'p1']);
  assert.ok(!('lastMatchPair' in state));
  assert.deepEqual(state.currentMatch, { id: 'm_3', players: ['p3', 'p1'], isBoss: false });
  assert.equal(state.history[1].outcome, 'p1');
  assert.equal(state.history[0].outcome, 'draw');
  assert.deepEqual(migrate(state), state, 'migrating twice changes nothing');
  assert.deepEqual(migrate(emptyState()), emptyState());

  const t = createTournament({ initialState: state, random: seededRandom(1) });
  t.addPlayer('Kim');
  assert.equal(byName(t, 'Sam').points, 1);
  assert.equal(byName(t, 'Alex').losses, 1);
  t.recordResult('p3');
  assert.equal(byName(t, 'Bo').points, 1);
});
