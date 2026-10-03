# CoD Tournament Manager

A small local web app for running a Call of Duty tournament at a house party with only 2 controllers. It decides who plays next, keeps a live leaderboard, and gives the host an admin panel. It runs on a Raspberry Pi on the home Wi-Fi. Guests open the display page on their phones or on a laptop next to the TV.

**This has to work tonight.** Favor simple, robust solutions over clever ones. No database, no build step, minimal dependencies.

---

## Tech stack

- **Runtime:** Node.js 20+ (CommonJS or ESM, pick one and be consistent)
- **Server:** Express. Only other allowed runtime dependencies: `qrcode` (QR code for the display page) and `dotenv`.
- **Frontend:** Plain HTML + CSS + vanilla JS. No frameworks, no bundler, no build step.
- **Live updates:** Server-Sent Events (SSE). The server pushes the full public state to all clients on every change.
- **Storage:** A single JSON file at `data/tournament.json`. State lives in memory, and the whole file is written after every mutation using an atomic write: write to `tournament.json.tmp`, then `fs.rename` over the real file. Load the file on startup. If it's missing, start with empty state. If it's corrupt, log a warning, back it up as `tournament.corrupt-<timestamp>.json`, and start empty.
- **Auth:** HTTP Basic Auth on the admin page and all admin API routes. The password comes from the `ADMIN_PASSWORD` env var (username can be anything, e.g. `admin`). Refuse to start if `ADMIN_PASSWORD` is not set.
- **Tests:** Node's built-in test runner (`node --test`). No test framework dependency.
- **Config:** `.env` file with `ADMIN_PASSWORD` and `PORT` (default 3000). Bind to `0.0.0.0` so other devices on the LAN can connect.

---

## Repo structure

```
cod-tournament/
├── package.json              # scripts: start, dev (node --watch), test
├── README.md                 # setup + Raspberry Pi deployment steps
├── CLAUDE.md                 # this file
├── .env.example              # ADMIN_PASSWORD=change-me  PORT=3000
├── .gitignore                # node_modules, .env, data/*.json, data/*.tmp
├── server/
│   ├── index.js              # Express setup, routes, static files, startup
│   ├── auth.js               # basic-auth middleware
│   ├── store.js              # load/save JSON (atomic), holds in-memory state
│   ├── tournament.js         # all state-changing actions (see "Actions")
│   ├── matchmaking.js        # PURE functions: pick next matches. No I/O.
│   ├── leaderboard.js        # PURE function: state -> sorted leaderboard rows
│   └── events.js             # SSE client registry + broadcast()
├── public/                   # served without auth
│   ├── index.html            # display page
│   ├── display.js
│   └── styles.css            # shared styles
├── admin/                    # served ONLY behind basic auth
│   ├── index.html            # admin panel
│   └── admin.js
├── data/
│   └── .gitkeep
├── test/
│   ├── matchmaking.test.js
│   └── tournament.test.js
└── deploy/
    └── cod-tournament.service   # systemd unit
```

`matchmaking.js` and `leaderboard.js` must be pure functions (state in, result out, randomness injectable for tests). They are the parts most likely to have subtle bugs, so they must be easy to test in isolation.

---

## Data model (`data/tournament.json`)

```json
{
  "phase": "regular",
  "matchCounter": 12,
  "players": [
    {
      "id": "p_abc123",
      "name": "Sam",
      "active": true,
      "points": 3,
      "played": 5,
      "wins": 3,
      "draws": 1,
      "losses": 1,
      "joinedAt": "2026-10-03T19:02:11Z"
    }
  ],
  "currentMatch": { "id": "m_13", "playerA": "p_abc123", "playerB": "p_def456", "isBoss": false },
  "nextMatch":    { "id": "m_14", "playerA": "p_ghi789", "playerB": "p_jkl012", "isBoss": false },
  "lastMatchPair": ["p_xxx", "p_yyy"],
  "history": [
    { "id": "m_12", "playerA": "p_xxx", "playerB": "p_yyy", "outcome": "A", "isBoss": false, "at": "..." }
  ],
  "champion": null
}
```

- `phase`: `"regular"` | `"boss"` | `"finished"`
- `outcome`: `"A"` | `"B"` | `"draw"` | `"skipped"`
- `lastMatchPair`: the pair of the most recent match that was shown as current, whether completed or skipped. Used for the "never the same matchup twice in a row" rule.
- Player stats (`points`, `played`, etc.) are stored for simplicity but must always be consistent with `history`. Optionally recompute them from history after every action. That's the safest approach.
- Removing a player is a **soft delete** (`active: false`). Their history stays. Re-adding the same name (case-insensitive) reactivates the existing player with their stats intact instead of creating a duplicate.
- Player names: trimmed, 1–20 chars, unique among active players (case-insensitive).

---

## Scoring rules

- A wins vs B → A gets +1 point. B gets 0.
- Draw → nobody gets a point.
- `played` goes up by 1 for both players on a win/loss/draw.
- **Skipped** matches count for nobody: no points, no `played` increment, no W/D/L. They are recorded in history as `"skipped"` (for undo and display) and ignored for stats.
- The **boss battle** does not change leaderboard points or `played`. It only decides the champion.

---

## Matchmaking rules (the core logic)

Goal: everyone plays about the same number of matches, spread out over the evening, and everyone faces everyone at least once.

Only **active** players are eligible. At least 2 active players are needed for a match. With fewer, `currentMatch` and `nextMatch` are `null` and the display shows "Waiting for players".

### Picking a match

Inputs: active players with their `played` counts, the history of completed matches (to count how often two players have faced each other), and the pair to avoid (`lastMatchPair`, or the projected current match when computing "up next").

1. **Pick player A:** the active player with the lowest `played`. Prefer players who were **not** in the previous match. Break remaining ties randomly.
2. **Pick player B** from the remaining active players. Rank them by, in order:
   1. fewest previous (non-skipped) matches against A. This makes sure everyone eventually meets everyone.
   2. lowest `played`
   3. not in the previous match
   4. random tie-break
3. **Hard rule:** the resulting pair must never be identical to the previous matchup (same two players, in any order). At least one player must differ. Only exception: there are exactly 2 active players, so there is no alternative.

The "not in the previous match" preference is soft. If a late joiner has far fewer matches, they may play often, sometimes back-to-back. That's fine. The host can skip manually if it's too much. Don't add extra rate-limiting rules.

### Current match and "up next"

The state always holds `currentMatch` and `nextMatch` (when possible).

- `nextMatch` is computed by running the matchmaker on a **projected** state, as if `currentMatch` was already played (both players' `played` +1, and the pair to avoid = the current pair).
- After a result is recorded: promote `nextMatch` to `currentMatch` if both its players are still active. Otherwise generate a fresh one. Then compute a new `nextMatch`.
- After a **skip**: promote `nextMatch` to `currentMatch` if both players are still active and it is not identical to the skipped pair. Otherwise generate fresh (avoiding the skipped pair). Then compute a new `nextMatch`.
- After a **player is added**: keep `currentMatch` as is (people may already be playing) and recompute `nextMatch`. If there was no current match (fewer than 2 players before), generate one.
- After a **player is removed**: if they're in `currentMatch`, replace it (promote `nextMatch` if valid, else generate). If they're in `nextMatch`, recompute it.
- The display shows a small note under "Up next": *"May change if players are added or a match is skipped."*

### Round-robin progress

Compute how many unique pairs of active players have played at least one non-skipped match, out of `n*(n-1)/2`. Show it on both pages ("Round robin: 9/15 pairs"). It helps the host decide when to start the boss battle.

---

## Leaderboard

One row per **active** player (optionally show removed players greyed out at the bottom; not required). Columns:

`#`, Name, Points, Played, W, D, L, Points per match (2 decimals, `–` if played = 0)

Sort by:
1. points (desc)
2. points per match (desc)
3. played (asc)
4. name (asc)

---

## Boss battle

- The admin clicks **"Start boss battle"**. A small dialog shows two dropdowns prefilled with the top 2 from the leaderboard. The host can change them (e.g. to settle a tie for 2nd place). Confirm → `phase = "boss"`, `currentMatch` = the boss match with `isBoss: true`, `nextMatch = null`.
- During the boss phase, the admin result buttons work the same. A win sets `champion` and `phase = "finished"`. A **draw** means a rematch: the boss match stays current.
- Skip during the boss phase is disabled.
- **"Cancel boss battle"** returns to `phase = "regular"` and regenerates the current/next matches.
- In `finished`, the display shows a big champion screen with the final leaderboard beneath it. The admin can still undo, or start new rounds by resetting.
- Adding/removing players is still allowed in the boss/finished phases but doesn't affect the boss match (unless a boss player is removed, in which case cancel the boss battle).

---

## Actions (`server/tournament.js`)

Every action: validates input → mutates state → persists to disk → broadcasts via SSE → returns the new public state. Invalid actions return HTTP 400 with `{ error: "message" }`.

| Action | Notes |
|---|---|
| `addPlayer(name)` | New player starts at 0 everything, included immediately in matchmaking. Reactivates a soft-deleted player with the same name. |
| `removePlayer(id)` | Soft delete; fix current/next match as described. |
| `recordResult(outcome)` | `outcome` ∈ `A`, `B`, `draw`. Only valid if there is a current match. |
| `skip()` | Only in the regular phase with a current match. |
| `startBoss(playerAId, playerBId)` | Two different active players. |
| `cancelBoss()` | Only in the boss phase. |
| `undo()` | Reverts the last action of any type (result, skip, add, remove, boss start/cancel, reset scores). Implement by pushing a deep-cloned snapshot of state before every action onto an in-memory stack (max 30). Not persisted; it's fine that undo history is lost on restart. |
| `resetScores()` | Keeps all active players but clears all history, points, played, W/D/L, the champion, and sets the phase back to regular. Then regenerates matches. |
| `resetAll()` | Wipes everything, including players. |

---

## HTTP API

Pages:
- `GET /`: display page (public)
- `GET /admin`: admin panel (basic auth). Serve the `admin/` folder only behind auth.

Public:
- `GET /api/state`: full public state: phase, current match, next match (with player names resolved), leaderboard rows, round-robin progress, champion, the last ~10 completed matches, and the join URL.
- `GET /api/events`: SSE stream. On connect, immediately send the current state as an event. Send the full state on every change. Send a heartbeat comment every 25s so connections don't time out.
- `GET /api/qr.svg`: QR code (SVG) for the display page URL.

Admin (basic auth, JSON bodies):
- `POST /api/admin/players` `{ name }`
- `DELETE /api/admin/players/:id`
- `POST /api/admin/result` `{ outcome: "A" | "B" | "draw" }`
- `POST /api/admin/skip`
- `POST /api/admin/boss` `{ playerA, playerB }`
- `POST /api/admin/boss/cancel`
- `POST /api/admin/undo`
- `POST /api/admin/reset-scores`
- `POST /api/admin/reset-all`

**Join URL:** use the LAN IPv4 address (from `os.networkInterfaces()`, first non-internal IPv4) plus the port, e.g. `http://192.168.1.42:3000`. Allow overriding it with a `PUBLIC_URL` env var.

---

## Display page (`public/`)

Will be shown on a laptop/tablet next to the TV and on guests' phones. Must look good on both (responsive) and be readable from a few meters away on a big screen.

- Dark, gamer-ish theme (dark background, one bold accent color, big type). No external fonts or CDNs; system fonts only.
- **Now playing:** big "Player A vs Player B" card.
- **Up next:** smaller card with the note about possible changes.
- **Leaderboard** table as specified.
- **Round-robin progress** indicator.
- Recent results (last 5–10, including skips shown subtly).
- **Waiting for players** state when fewer than 2 active players.
- **Boss battle** state: dramatic banner/styling for the boss match.
- **Champion** state: big winner announcement.
- QR code + join URL in a corner so guests can open the page on their phones.
- Connects via `EventSource('/api/events')`. Show a small "reconnecting…" indicator if the connection drops (EventSource reconnects automatically).

## Admin page (`admin/`)

Used by the host on their phone, so it's mobile-first with big tap targets.

- **Current match** with three big buttons: **[Player A] wins**, **Draw**, **[Player B] wins**. Use the actual player names on the buttons.
- **Skip match** button.
- **Undo** button (always visible, at the top). Shows a short toast describing what was undone.
- **Up next** preview.
- **Players section:** text input + "Add" button (Enter key submits), and a list of active players with a remove (×) button each and their points/played.
- **Boss battle:** "Start boss battle" button → dialog with two prefilled dropdowns → confirm. While in boss phase, show "Cancel boss battle".
- **Danger zone** at the bottom: "Reset scores (keep players)" and "Reset everything". Both require a confirm dialog.
- Compact leaderboard.
- Also subscribes to SSE so it stays in sync if opened on two devices.
- Disable buttons while a request is in flight to prevent double taps from recording a result twice.

---

## Tests (must pass before considering the work done)

`test/matchmaking.test.js` (use a seeded/injected random function):
- With 6 players and 30 simulated matches (random outcomes): the max difference in `played` between any two players is never more than 1 after each match.
- With 6 players: all 15 pairs have played at least once within the first ~20 matches.
- The same matchup never appears twice in a row (with ≥ 3 active players), including after skips.
- With exactly 2 players, they keep getting matched.
- A player added mid-tournament with 0 played is picked before players with more matches.
- Removed players are never picked.
- Fewer than 2 active players → no match.

`test/tournament.test.js`:
- Points/played/W/D/L are correct after wins, draws, and skips (skips change nothing).
- Undo restores the exact previous state, including after reset scores.
- Reset scores keeps players and clears stats/history.
- Removing a player who is in the current match replaces the match.
- Boss flow: start → draw (still boss) → win → champion set, phase finished; leaderboard points unchanged by the boss match.

---

## Raspberry Pi deployment (document in README)

1. Install Node.js 20 LTS on Raspberry Pi OS (NodeSource or nvm).
2. `git clone`, `npm install --omit=dev`, `cp .env.example .env`, set `ADMIN_PASSWORD`.
3. `deploy/cod-tournament.service`: systemd unit with `WorkingDirectory` set to the repo, `EnvironmentFile` pointing at `.env`, `ExecStart=/usr/bin/node server/index.js`, `Restart=always`, `User=pi` (note to adjust the user/paths).
4. `sudo cp deploy/cod-tournament.service /etc/systemd/system/ && sudo systemctl enable --now cod-tournament`
5. Find the IP with `hostname -I`. Guests open `http://<ip>:3000` (also try `http://raspberrypi.local:3000`; some Android phones don't resolve `.local`). Recommend giving the Pi a fixed IP in the router.
6. Logs: `journalctl -u cod-tournament -f`.

---

## Working agreements for Claude Code

- Build in this order: `matchmaking.js` + tests → `leaderboard.js` → `store.js` → `tournament.js` + tests → server/API/SSE → admin page → display page → README + systemd file.
- Run `npm test` after each step and keep it green.
- Keep dependencies to Express, `qrcode` and `dotenv`. Ask before adding anything else.
- Keep code simple and readable. This is a one-evening party tool, not a product.
