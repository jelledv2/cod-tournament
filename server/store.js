'use strict';

// Loads and saves the tournament state as a single JSON file.
// Writes are atomic: write to <file>.tmp, then rename over the real file.

const fs = require('node:fs');
const path = require('node:path');

function emptyState() {
  return {
    phase: 'regular',
    matchCounter: 0,
    players: [],
    currentMatch: null,
    nextMatch: null,
    matchSize: 2,
    lastMatchPlayers: null,
    history: [],
    champion: null,
  };
}

function looksLikeState(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray(value.players) &&
    Array.isArray(value.history)
  );
}

// Files saved before matches could have more than 2 players stored playerA/playerB,
// outcome "A"/"B" and lastMatchPair. Newer files pass through unchanged.
function migrateMatch(match) {
  if (!match || match.players) return match;
  const { playerA, playerB, ...rest } = match;
  const out = { ...rest, players: [playerA, playerB] };
  if (match.outcome === 'A') out.outcome = playerA;
  if (match.outcome === 'B') out.outcome = playerB;
  return out;
}

function migrate(saved) {
  const { lastMatchPair, ...rest } = saved;
  return {
    ...emptyState(),
    lastMatchPlayers: lastMatchPair || null,
    ...rest,
    currentMatch: migrateMatch(saved.currentMatch),
    nextMatch: migrateMatch(saved.nextMatch),
    history: saved.history.map(migrateMatch),
  };
}

function createStore(filePath) {
  const tmpPath = `${filePath}.tmp`;

  function backupCorruptFile(reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(path.dirname(filePath), `tournament.corrupt-${stamp}.json`);
    console.warn(`WARNING: ${filePath} is corrupt (${reason}).`);
    try {
      fs.renameSync(filePath, backupPath);
      console.warn(`Backed it up as ${backupPath} and starting with empty state.`);
    } catch (err) {
      console.warn(`Could not back it up (${err.message}). Starting with empty state.`);
    }
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return emptyState();
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!looksLikeState(parsed)) throw new Error('unexpected shape');
      return migrate(parsed);
    } catch (err) {
      backupCorruptFile(err.message);
      return emptyState();
    }
  }

  function save(state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  return { load, save };
}

module.exports = { createStore, emptyState, migrate };
