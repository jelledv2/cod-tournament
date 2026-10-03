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
    lastMatchPair: null,
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
      return { ...emptyState(), ...parsed };
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

module.exports = { createStore, emptyState };
