'use strict';

// Pure leaderboard functions: state in, result out. No I/O.

const { countsForStats } = require('./matchmaking');

// Returns a copy of `players` with points/played/wins/draws/losses recomputed
// from `history`. Skipped matches and the boss battle are ignored.
function withStats(players, history) {
  const stats = new Map(
    players.map((p) => [p.id, { points: 0, played: 0, wins: 0, draws: 0, losses: 0 }])
  );
  for (const m of history) {
    if (!countsForStats(m)) continue;
    if (!m.players.every((id) => stats.has(id))) continue;
    for (const id of m.players) {
      const row = stats.get(id);
      row.played++;
      if (m.outcome === 'draw') {
        row.draws++;
      } else if (m.outcome === id) {
        row.points++;
        row.wins++;
      } else {
        row.losses++;
      }
    }
  }
  return players.map((p) => ({ ...p, ...stats.get(p.id) }));
}

// One row per active player, sorted by points, points per match, played, name.
function buildLeaderboard(players, history) {
  const rows = withStats(players, history)
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id,
      name: p.name,
      points: p.points,
      played: p.played,
      wins: p.wins,
      draws: p.draws,
      losses: p.losses,
      pointsPerMatch: p.played > 0 ? p.points / p.played : null,
    }));

  // Players without a match sort as 0 points per match.
  const ppm = (row) => row.pointsPerMatch || 0;
  rows.sort(
    (x, y) =>
      y.points - x.points ||
      ppm(y) - ppm(x) ||
      x.played - y.played ||
      x.name.localeCompare(y.name, undefined, { sensitivity: 'base' })
  );
  return rows.map((row, i) => ({ rank: i + 1, ...row }));
}

module.exports = { withStats, buildLeaderboard };
