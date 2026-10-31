'use strict';

const $ = (id) => document.getElementById(id);

const MIN_MATCH_SIZE = 2;
const MAX_MATCH_SIZE = 8;

// Tiny DOM helper. Text is always set via textContent, so names are safe.
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function button(label, className, onClick) {
  const node = el('button', `btn ${className}`, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

let state = null;
let busy = false; // a request is in flight: all buttons are disabled

// ---- toast -------------------------------------------------------------------

let toastTimer;
function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 3500);
}

// ---- API ---------------------------------------------------------------------

function setBusy(value) {
  busy = value;
  if (state) render();
}

// Returns the new state, or null if the request failed (a toast explains why).
async function api(method, path, body) {
  if (busy) return null;
  setBusy(true);
  try {
    // location.origin: also works if the page was opened as http://user:pass@host/admin
    const res = await fetch(`${location.origin}/api/admin${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || `Request failed (${res.status})`, true);
      return null;
    }
    state = data;
    return data;
  } catch (err) {
    toast('Cannot reach the server. Check the Wi-Fi.', true);
    return null;
  } finally {
    setBusy(false);
  }
}

// ---- dialogs -----------------------------------------------------------------

// Resolves to true when the dialog is closed with its confirm button.
function openDialog(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function confirmAction(title, text, okLabel) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  return openDialog($('confirm-dialog'));
}

async function startBossBattle() {
  const rows = state.leaderboard;
  const count = Math.min(state.matchSize, rows.length);
  const selects = Array.from({ length: count }, (_, preselected) =>
    el(
      'select',
      '',
      ...rows.map((row, i) => {
        const option = el('option', '', `${row.rank}. ${row.name} (${row.points} pts)`);
        option.value = row.id;
        option.selected = i === preselected;
        return option;
      })
    )
  );
  $('boss-hint').textContent = `Prefilled with the top ${count}. Change them to settle a tie.`;
  $('boss-fields').replaceChildren(
    ...selects.map((select, i) => el('label', 'field', `Player ${i + 1} `, select))
  );
  if (!(await openDialog($('boss-dialog')))) return;
  await api('POST', '/boss', { players: selects.map((select) => select.value) });
}

// ---- rendering ---------------------------------------------------------------

// "A vs B vs C" as DOM nodes.
function withVs(players) {
  return players.flatMap((p, i) => (i === 0 ? [p.name] : [el('span', 'vs', 'vs'), p.name]));
}

function matchNames(match) {
  return el('p', 'match-names display-type', ...withVs(match.players));
}

function renderCurrent() {
  const match = state.currentMatch;
  const isBoss = Boolean(match && match.isBoss);
  $('current').classList.toggle('is-boss', isBoss);
  $('current-title').textContent = isBoss ? 'Boss battle' : 'Now playing';

  if (!match) {
    const text =
      state.phase === 'finished'
        ? `${state.champion.name} is the champion. Undo to correct the result, or reset scores to play new rounds.`
        : 'Waiting for players. Add at least two to start.';
    $('current-body').replaceChildren(el('p', 'note', text));
    return;
  }

  const result = (outcome) => () => api('POST', '/result', { outcome });
  const body = [
    matchNames(match),
    el(
      'div',
      `result-buttons${match.players.length >= 4 ? ' is-many' : ''}`,
      ...match.players.map((p) => button(`${p.name} wins`, 'btn-primary', result(p.id))),
      button(isBoss ? 'Draw (rematch)' : 'Draw', 'btn-draw', result('draw'))
    ),
  ];
  if (!isBoss) {
    const skip = button('Skip match', 'btn-block', () => api('POST', '/skip'));
    skip.style.marginTop = '1rem';
    body.push(skip);
  }
  $('current-body').replaceChildren(...body);
}

function renderNext() {
  const next = state.nextMatch;
  $('next').hidden = !next;
  if (next) $('next-match').textContent = next.players.map((p) => p.name).join(' vs ');
}

function renderMatchSize() {
  $('size-value').textContent = state.matchSize;
  $('size-note').textContent =
    state.phase === 'regular'
      ? 'Changing this picks a new current match. With fewer players than this, everyone plays.'
      : 'Applies to new matches. A boss battle keeps its players.';
}

function renderPlayers() {
  const players = state.leaderboard.slice().sort((a, b) => a.name.localeCompare(b.name));
  $('players-title').textContent = `Players (${players.length})`;
  $('players').replaceChildren(
    ...players.map((p) => {
      const remove = button('×', '', () => api('DELETE', `/players/${encodeURIComponent(p.id)}`));
      remove.setAttribute('aria-label', `Remove ${p.name}`);
      return el(
        'li',
        '',
        el('span', 'name', p.name),
        el('span', 'stats', `${p.points} pts, ${p.played} played`),
        remove
      );
    })
  );
}

function renderBoss() {
  const body = $('boss-body');
  if (state.phase === 'boss') {
    body.replaceChildren(button('Cancel boss battle', 'btn-danger btn-block', () => api('POST', '/boss/cancel')));
  } else if (state.phase === 'finished') {
    body.replaceChildren(el('p', 'note', 'The boss battle is over. Reset scores to play again.'));
  } else if (state.leaderboard.length < 2) {
    body.replaceChildren(el('p', 'note', 'Needs at least two players.'));
  } else {
    body.replaceChildren(
      el('p', 'note', 'The final between the top players. It decides the champion and does not change points.'),
      button('Start boss battle', 'btn-block', startBossBattle)
    );
  }
}

function renderBoard() {
  const rows = state.leaderboard;
  const { done, total } = state.roundRobin;
  $('progress').textContent = total ? `Round robin: ${done}/${total} pairs` : '';
  if (rows.length === 0) {
    $('board').replaceChildren(el('p', 'board-empty', 'No players yet.'));
    return;
  }
  const columns = [
    ['#', 'col-rank', (r) => r.rank],
    ['Name', 'col-name', (r) => r.name],
    ['Pts', 'col-points', (r) => r.points],
    ['Pl', '', (r) => r.played],
    ['W', '', (r) => r.wins],
    ['D', '', (r) => r.draws],
    ['L', '', (r) => r.losses],
    ['Avg', '', (r) => (r.pointsPerMatch === null ? '–' : r.pointsPerMatch.toFixed(2))],
  ];
  const head = el('tr', '', ...columns.map(([label, cls]) => el('th', cls, label)));
  const body = rows.map((row) =>
    el('tr', '', ...columns.map(([, cls, value]) => el('td', cls, String(value(row)))))
  );
  $('board').replaceChildren(el('table', 'board', el('thead', '', head), el('tbody', '', ...body)));
}

function render() {
  renderCurrent();
  renderNext();
  renderMatchSize();
  renderPlayers();
  renderBoss();
  renderBoard();

  // Dialog buttons stay usable; everything else locks while a request runs.
  for (const node of document.querySelectorAll('.admin button')) node.disabled = busy;
  $('undo').disabled = busy || !state.canUndo;
  $('size-down').disabled = busy || state.matchSize <= MIN_MATCH_SIZE;
  $('size-up').disabled = busy || state.matchSize >= MAX_MATCH_SIZE;
}

// ---- static controls ---------------------------------------------------------

$('undo').addEventListener('click', async () => {
  const data = await api('POST', '/undo');
  if (data) toast(`Undone: ${data.undone}`);
});

$('size-down').addEventListener('click', () => api('POST', '/match-size', { size: state.matchSize - 1 }));
$('size-up').addEventListener('click', () => api('POST', '/match-size', { size: state.matchSize + 1 }));

$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('add-name');
  const name = input.value.trim();
  if (!name) return;
  if (await api('POST', '/players', { name })) input.value = '';
  input.focus();
});

$('reset-scores').addEventListener('click', async () => {
  const ok = await confirmAction(
    'Reset scores?',
    'All results, points and the champion are cleared. Players stay.',
    'Reset scores'
  );
  if (ok) await api('POST', '/reset-scores');
});

$('reset-all').addEventListener('click', async () => {
  const ok = await confirmAction(
    'Reset everything?',
    'All players and all results are removed.',
    'Reset everything'
  );
  if (ok) await api('POST', '/reset-all');
});

// ---- live updates ------------------------------------------------------------

// Keeps this page in sync when the admin panel is open on two devices.
const source = new EventSource(`${location.origin}/api/events`);
source.onopen = () => ($('offline').hidden = true);
source.onerror = () => ($('offline').hidden = false);
source.onmessage = (event) => {
  state = JSON.parse(event.data);
  render();
};
