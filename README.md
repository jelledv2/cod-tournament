# CoD Tournament Manager

A small local web app for running a Call of Duty tournament at a house party
with only 2 controllers. It decides who plays next, keeps a live leaderboard and
gives the host an admin panel. No database, no build step.

- **Display page** (`/`): now playing, up next, leaderboard and recent results.
  Put it on a laptop next to the TV.
- **Admin panel** (`/admin`): record results, skip, undo, add/remove players,
  start the boss battle, reset. Password protected.

## Quick start

Requires **Node.js 20 or newer** (`node --version`).

```sh
npm install
cp .env.example .env      # then set ADMIN_PASSWORD in .env
npm start
```

Open `http://localhost:3000` for the display and `http://localhost:3000/admin`
for the admin panel. The browser asks for a username and password: the username
can be anything (e.g. `admin`), the password is `ADMIN_PASSWORD`.

| Script | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart on file changes |
| `npm test` | Run the tests |

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | none, required | Password for the admin panel. The server refuses to start without it. |
| `PORT` | `3000` | Port to listen on (all network interfaces). |
| `PUBLIC_URL` | LAN address | Join URL returned by the API and encoded in `/api/qr.svg`. The display page currently doesn't show either. |

## Running the evening

1. Open `/admin` on your phone and add the players. The first match appears as
   soon as there are two.
2. After each match tap **[name] wins** or **Draw**. Tap **Skip match** if
   someone is away; a skip counts for nobody.
3. Made a mistake? **Undo** reverts the last action, up to 30 steps back
   (results, skips, added/removed players, boss battle, resets).
4. Late arrivals can be added at any time and will play catch-up. Removing a
   player keeps their results; adding the same name again brings them back.
5. When the round-robin counter is full (or it's getting late), tap
   **Start boss battle**. It is prefilled with the top 2. The winner is the
   champion; a draw means a rematch. The boss battle doesn't change the points.
6. **Reset scores** starts a fresh tournament with the same players.

Scoring: a win is 1 point, a draw or a loss is 0. The leaderboard sorts by
points, then points per match, then fewest matches played, then name.

## Data

State is kept in `data/tournament.json` and rewritten after every action, so a
restart or power cut loses nothing except the undo history. To start completely
fresh, use **Reset everything** in the admin panel or delete the file while the
server is stopped. A corrupt file is moved aside as
`data/tournament.corrupt-<timestamp>.json` and the server starts empty.

## Raspberry Pi deployment

1. **Install Node.js 20 LTS** on Raspberry Pi OS, via NodeSource:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   node --version
   ```

   (or use [nvm](https://github.com/nvm-sh/nvm); then adjust the `node` path in
   the service file to the output of `which node`.)

2. **Get the app and configure it:**

   ```sh
   cd ~
   git clone <your-repo-url> cod-tournament
   cd cod-tournament
   npm install --omit=dev
   cp .env.example .env
   nano .env                 # set ADMIN_PASSWORD
   ```

   No git remote? Copy the folder over instead (without `node_modules`), e.g.
   `scp -r cod-tournament pi@raspberrypi.local:~/`, then run the `npm install`.

3. **Check the service file** `deploy/cod-tournament.service`. It assumes the
   user `pi` and the path `/home/pi/cod-tournament`. Adjust `User`,
   `WorkingDirectory` and `EnvironmentFile` if yours differ.

4. **Install and start the service:**

   ```sh
   sudo cp deploy/cod-tournament.service /etc/systemd/system/
   sudo systemctl enable --now cod-tournament
   ```

   It now starts on boot and restarts if it crashes.

5. **Find the address:** run `hostname -I` on the Pi. Guests open
   `http://<ip>:3000`. `http://raspberrypi.local:3000` often works too, but some
   Android phones don't resolve `.local` names. Give the Pi a fixed IP in your
   router (DHCP reservation) so the address doesn't change mid-party.

6. **Logs:** `journalctl -u cod-tournament -f`

After changing `.env` or updating the code: `sudo systemctl restart cod-tournament`.

## Project layout

```
server/index.js        Express setup, routes, startup
server/auth.js         basic-auth middleware
server/store.js        load/save data/tournament.json (atomic write)
server/tournament.js   all state-changing actions + undo
server/matchmaking.js  pure functions: pick the next matches
server/leaderboard.js  pure functions: stats and leaderboard rows
server/events.js       Server-Sent Events broadcast
public/                display page (no auth)
admin/                 admin panel (behind basic auth)
test/                  node --test
deploy/                systemd unit
```
