'use strict';

const $ = (id) => document.getElementById(id);

// Tiny DOM helper. Text is always set via textContent, so names are safe.
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

const LONG_NAME = 10;
const RECENT_SHOWN = 6;
const nameClass = (base, name) => `${base} display-type${name.length > LONG_NAME ? ' is-long' : ''}`;

function renderStage(state) {
  const stage = $('stage');
  const match = state.currentMatch;
  stage.className = 'panel stage';

  if (state.phase === 'finished' && state.champion) {
    stage.classList.add('is-champion');
    stage.replaceChildren(
      el('p', 'stage-label', 'Champion'),
      el('p', nameClass('champion-name', state.champion.name), state.champion.name),
      el('p', 'stage-hint', 'Won the boss battle. Final standings are on the leaderboard.')
    );
    return;
  }

  if (!match) {
    stage.replaceChildren(
      el('p', 'stage-message display-type', 'Waiting for players'),
      el('p', 'stage-hint', 'The first match starts as soon as two players are in.')
    );
    return;
  }

  if (match.isBoss) stage.classList.add('is-boss');
  const names = match.players.map((p) => el('div', nameClass('versus-name', p.name), p.name));
  stage.replaceChildren(
    el('p', 'stage-label', match.isBoss ? 'Boss battle: winner takes the title' : 'Now playing'),
    names.length === 2
      ? el('div', 'versus', names[0], el('div', 'versus-vs display-type', 'VS'), names[1])
      : el('div', 'versus is-many', ...names)
  );
}

function renderNext(state) {
  const next = state.nextMatch;
  $('next').hidden = !next;
  if (!next) return;
  $('next-match').replaceChildren(
    ...next.players.flatMap((p, i) => (i === 0 ? [p.name] : [el('span', 'vs', 'vs'), p.name]))
  );
}

const wideScreen = window.matchMedia('(min-width: 40rem)');

function renderBoard(state) {
  $('board-title').textContent = state.phase === 'finished' ? 'Final leaderboard' : 'Leaderboard';
  const rows = state.leaderboard;
  if (rows.length === 0) {
    $('board').replaceChildren(el('p', 'board-empty', 'No players yet.'));
    return;
  }

  const playing = state.currentMatch ? state.currentMatch.players.map((p) => p.id) : [];
  const wide = wideScreen.matches; // phones get short column titles
  const columns = [
    ['#', 'col-rank', (r) => r.rank],
    ['Name', 'col-name', (r) => r.name],
    [wide ? 'Points' : 'Pts', 'col-points', (r) => r.points],
    [wide ? 'Played' : 'Pl', '', (r) => r.played],
    ['W', '', (r) => r.wins],
    ['D', '', (r) => r.draws],
    ['L', '', (r) => r.losses],
    [wide ? 'Pts/match' : 'Avg', '', (r) => (r.pointsPerMatch === null ? '–' : r.pointsPerMatch.toFixed(2))],
  ];

  const head = el('tr', '', ...columns.map(([label, cls]) => el('th', cls, label)));
  const body = rows.map((row) =>
    el(
      'tr',
      playing.includes(row.id) ? 'is-playing' : '',
      ...columns.map(([, cls, value]) => el('td', cls, String(value(row))))
    )
  );
  $('board').replaceChildren(el('table', 'board', el('thead', '', head), el('tbody', '', ...body)));
}

function renderProgress(state) {
  const { done, total } = state.roundRobin;
  $('progress').hidden = total === 0;
  $('progress-text').textContent = `${done}/${total} pairs`;
  $('progress-fill').style.width = total ? `${(done / total) * 100}%` : '0';
}

// "A", "A and B", "A, B and C"
function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function resultLine(match) {
  const names = match.players.map((p) => p.name);
  if (match.outcome === 'skipped') return el('li', 'is-skipped', `${names.join(' vs ')} skipped`);

  const prefix = match.isBoss ? 'Boss battle: ' : '';
  if (match.outcome === 'draw') {
    return el('li', match.isBoss ? 'is-boss' : '', `${prefix}${listNames(names)} drew`);
  }
  const winner = match.players.find((p) => p.id === match.outcome);
  const losers = match.players.filter((p) => p.id !== match.outcome).map((p) => p.name);
  return el(
    'li',
    match.isBoss ? 'is-boss' : '',
    prefix,
    el('span', 'winner', winner.name),
    ` beat ${listNames(losers)}`
  );
}

function renderRecent(state) {
  $('recent-panel').hidden = state.recentMatches.length === 0;
  $('recent').replaceChildren(...state.recentMatches.slice(0, RECENT_SHOWN).map(resultLine));
}

let lastState = null;
function render(state) {
  lastState = state;
  renderStage(state);
  renderNext(state);
  renderBoard(state);
  renderProgress(state);
  renderRecent(state);
}

wideScreen.addEventListener('change', () => lastState && renderBoard(lastState));

// EventSource reconnects by itself; we only show that it's happening.
const source = new EventSource('/api/events');
source.onopen = () => ($('offline').hidden = true);
source.onerror = () => ($('offline').hidden = false);
source.onmessage = (event) => render(JSON.parse(event.data));
