'use strict';

const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const express = require('express');
const QRCode = require('qrcode');
const { basicAuth } = require('./auth');
const { createStore } = require('./store');
const { createTournament, ActionError } = require('./tournament');
const events = require('./events');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Copy .env.example to .env and set a password.');
  process.exit(1);
}

// The URL guests open: PUBLIC_URL, or the first non-internal IPv4 address.
// Looked up on every use, so it's right even if the network came up late.
function getJoinUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses) {
      if (address.family === 'IPv4' && !address.internal) {
        return `http://${address.address}:${PORT}`;
      }
    }
  }
  return `http://localhost:${PORT}`;
}

const store = createStore(path.join(ROOT, 'data', 'tournament.json'));
const tournament = createTournament({
  initialState: store.load(),
  save: store.save,
  onChange: events.broadcast,
  getJoinUrl,
});

const app = express();
app.use(express.json());

// ---- public ----------------------------------------------------------------

app.get('/api/state', (req, res) => {
  res.json(tournament.getPublicState());
});

app.get('/api/events', (req, res) => {
  events.addClient(req, res, tournament.getPublicState());
});

app.get('/api/qr.svg', async (req, res, next) => {
  try {
    const svg = await QRCode.toString(getJoinUrl(), { type: 'svg', margin: 1 });
    res.set('Cache-Control', 'no-store').type('image/svg+xml').send(svg);
  } catch (err) {
    next(err);
  }
});

// ---- admin (basic auth) ----------------------------------------------------

const requireAdmin = basicAuth(ADMIN_PASSWORD);

// Runs a tournament action; invalid actions become HTTP 400 { error }.
const action = (fn) => (req, res) => {
  try {
    res.json(fn(req.body || {}, req.params));
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    res.status(400).json({ error: err.message });
  }
};

const admin = express.Router();
admin.post('/players', action((body) => tournament.addPlayer(body.name)));
admin.delete('/players/:id', action((body, params) => tournament.removePlayer(params.id)));
admin.post('/result', action((body) => tournament.recordResult(body.outcome)));
admin.post('/skip', action(() => tournament.skip()));
admin.post('/boss', action((body) => tournament.startBoss(body.players)));
admin.post('/boss/cancel', action(() => tournament.cancelBoss()));
admin.post('/match-size', action((body) => tournament.setMatchSize(body.size)));
admin.post('/undo', action(() => tournament.undo()));
admin.post('/reset-scores', action(() => tournament.resetScores()));
admin.post('/reset-all', action(() => tournament.resetAll()));

app.use('/api/admin', requireAdmin, admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- pages -----------------------------------------------------------------

app.use('/admin', requireAdmin, express.static(path.join(ROOT, 'admin')));
app.use(express.static(path.join(ROOT, 'public')));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---- startup ---------------------------------------------------------------

events.startHeartbeat();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`CoD tournament running on port ${PORT}`);
  console.log(`  Display: ${getJoinUrl()}`);
  console.log(`  Admin:   ${getJoinUrl()}/admin`);
});
server.on('error', (err) => {
  console.error(`Could not start the server: ${err.message}`);
  process.exit(1);
});
