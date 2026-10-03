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
  stage.replaceChildren(
    el('p', 'stage-label', match.isBoss ? 'Boss battle: winner takes the title' : 'Now playing'),
    el(
      'div',
      'versus',
      el('div', nameClass('versus-name', match.playerA.name), match.playerA.name),
      el('div', 'versus-vs display-type', 'VS'),
      el('div', nameClass('versus-name', match.playerB.name), match.playerB.name)
    )
  );
}

function renderNext(state) {
  const next = state.nextMatch;
  $('next').hidden = !next;
  if (!next) return;
  $('next-match').replaceChildren(next.playerA.name, el('span', 'vs', 'vs'), next.playerB.name);
}

const wideScreen = window.matchMedia('(min-width: 40rem)');

function renderBoard(state) {
  $('board-title').textContent = state.phase === 'finished' ? 'Final leaderboard' : 'Leaderboard';
  const rows = state.leaderboard;
  if (rows.length === 0) {
    $('board').replaceChildren(el('p', 'board-empty', 'No players yet.'));
    return;
  }

  const playing = state.currentMatch
    ? [state.currentMatch.playerA.id, state.currentMatch.playerB.id]
    : [];
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

function resultLine(match) {
  const a = match.playerA.name;
  const b = match.playerB.name;
  if (match.outcome === 'skipped') return el('li', 'is-skipped', `${a} vs ${b} skipped`);

  const prefix = match.isBoss ? 'Boss battle: ' : '';
  if (match.outcome === 'draw') {
    return el('li', match.isBoss ? 'is-boss' : '', `${prefix}${a} and ${b} drew`);
  }
  const [winner, loser] = match.outcome === 'A' ? [a, b] : [b, a];
  return el('li', match.isBoss ? 'is-boss' : '', prefix, el('span', 'winner', winner), ` beat ${loser}`);
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
