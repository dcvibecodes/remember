# Remember

A self-hosted, single-user task app in the spirit of Apple Reminders. Lists, due dates, urgent flags, recurring reminders, natural-language quick add, smart lists, floating time zones, a token API for external agents, completed history, dark mode, and web push. No frontend framework and no build step.

Live: https://re.example.com

## Features

- Lists with a 15-color palette and drag-to-reorder handles (pointer, touch, and keyboard).
- Reminders with title, notes, date, optional time, and an urgent flag.
- Recurring reminders (daily/weekly/monthly/yearly/custom) with per-occurrence completion history, skip, and this-occurrence-vs-series editing.
- Natural-language quick add: "call mom tomorrow 6pm" pre-fills the editor with a removable preview.
- Smart lists: Today (overdue pinned), Scheduled (grouped by date), All, Flagged (urgent), Completed.
- Time models: fixed instant (default), floating wall-clock that follows the device time zone, or zone-anchored.
- Snooze (in-app button + notification actions where supported), opt-in re-push with quiet hours.
- Token API so external agents can list, add, and complete reminders without a browser.
- Completed reminders remain visible for 30 days; older records stay in SQLite but are not returned by the API.
- Search across active reminders.
- Installable PWA with web push notifications. iOS requires 16.4+ and the app installed to the Home Screen.
- Single-user password auth, CSRF protection, rate-limited login, and secure session cookies behind HTTPS.
- Auto, light, and dark themes, plus comfortable/compact density.
- JSON backup download + merge-safe import in Settings.
- One SQLite database; easy to back up and move.

Urgent is a visual flag only: it marks the reminder in red but does not change notification timing or add an alarm.

## Stack

- Node.js 20+ and Express 4
- SQLite via `sqlite3` (WAL mode, foreign keys on)
- Vanilla JavaScript PWA with a small hash router
- `bcryptjs` + `express-session` for single-user auth
- `web-push` with VAPID keys generated on first boot
- `chrono-node` for natural-language date parsing (server-side)

## Run locally

```bash
npm install
npm start
```

Open http://127.0.0.1:3006. The first visit asks you to create a password (minimum 8 characters). There is no registration and no password recovery.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3006` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATA_DIR` | `./data` | SQLite directory |
| `CONTACT_EMAIL` | `noreply@example.com` | VAPID contact email |

Your data lives in `data/remember.db`. It is gitignored because it contains the password hash, VAPID private key, and all reminders.

## Project layout

```text
server.js                 Express app, auth, REST API, scheduler
db.js                     SQLite connection and migrations
session-store.js          SQLite-backed express-session store
recurrence.js             Repeat rules, time-zone math, occurrence scheduling
push.js                   Web Push / VAPID setup
public/index.html         App shell and SVG icons
public/app.js             Hash router, rendering, editor, drag reorder
public/styles.css         Theme tokens and responsive layout
public/sw.js              Service worker / offline shell / push handlers
public/manifest.webmanifest
scripts/generate-icons.js Regenerates the PNG icons (`npm run icons`)
data/                     Local SQLite files (gitignored)
```

## API outline

Public: `GET /api/health`, `GET /api/session`, `POST /api/setup`, `POST /api/login`.

Authenticated routes require the `remember.sid` session cookie. State-changing requests also require the `X-CSRF-Token` header returned by `GET /api/session`.

- `GET /api/state` (lists, reminders, non-secret settings)
- `GET /api/settings`, `POST /api/settings` (allowlisted keys only)
- `POST` / `PATCH` / `DELETE /api/lists[/:id]`
- `PUT /api/lists/order`
- `POST /api/reminders`, `PATCH` / `DELETE /api/reminders/:id`
- `POST /api/reminders/:id/skip|snooze|reschedule`, `GET /api/reminders/:id/occurrences`
- `POST /api/parse` (natural-language title parsing)
- `GET /api/lists`, `GET /api/reminders` (also usable with a token)
- `GET /api/tokens`, `POST /api/tokens`, `POST /api/tokens/:id/revoke`
- `GET /api/export`, `POST /api/import`
- `POST /api/push/subscribe`, `/unsubscribe`, `/test`, `/action` (signed notification actions)
- `POST /api/password`
- `POST /api/logout`

Personal access tokens (`Authorization: Bearer …`, created in Settings) may read lists/reminders/state, create reminders idempotently, and complete them — nothing else.

## Deployment

Run the app behind an HTTPS reverse proxy (nginx or Caddy) and keep it alive with PM2 or systemd. Web push requires HTTPS.

```bash
npm install
npm start
```

- Proxy to `127.0.0.1:3006` and pass `X-Forwarded-Proto`.
- Set `trust proxy` (already enabled in `server.js`) so secure cookies work behind the proxy.
- Back up `data/remember.db` regularly.
- Never commit `data/` or replace the database with a fresh copy during an update.

Sessions are stored in SQLite, so refreshing the page or restarting the process keeps you signed in. The session secret and VAPID keys persist in the `settings` table.

## Version

1.4.0

## License

UNLICENSED
