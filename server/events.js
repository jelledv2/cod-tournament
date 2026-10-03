'use strict';

// Server-Sent Events: client registry + broadcast().

const HEARTBEAT_MS = 25000;

const clients = new Set();

const frame = (state) => `data: ${JSON.stringify(state)}\n\n`;

// Turns the response into an SSE stream and immediately sends `state`.
function addClient(req, res, state) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(frame(state));
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function broadcast(state) {
  const payload = frame(state);
  for (const res of clients) res.write(payload);
}

// Comment lines keep idle connections from timing out.
function startHeartbeat() {
  const timer = setInterval(() => {
    for (const res of clients) res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
  timer.unref();
  return timer;
}

module.exports = { addClient, broadcast, startHeartbeat };
