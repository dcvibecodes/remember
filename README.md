# Remember

A self-hosted, single-user task app in the spirit of Apple Reminders. Lists, due dates, urgent flags, completed history, dark mode, and web push. No frontend framework and no build step.

Live: https://re.example.com

## Features

- Lists with a 15-color palette and drag-to-reorder handles.
- Reminders with title, notes, date, optional time, and an urgent flag.
- Completed reminders remain visible for 30 days; older records stay in SQLite but are not returned by the API.
- Search across active reminders.
- Installable PWA with web push notifications. iOS requires 16.4+ and the app installed to the Home Screen.
- Single-user password auth, CSRF protection, rate-limited login, and secure session cookies behind HTTPS.
- Auto, light, and dark themes.
- One SQLite database; easy to back up and move.

Urgent is a visual flag only: it marks the reminder in red but does not change notification timing or add an alarm.

## Stack

- Node.js 20+ and Express 4
- SQLite via `sqlite3` (WAL mode, foreign keys on)
- Vanilla JavaScript PWA with a small hash router
- `bcryptjs` + `express-session` for single-user auth
- `web-push` with VAPID keys generated on first boot

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

- `GET /api/state`
- `POST` / `PATCH` / `DELETE /api/lists[/:id]`
- `PUT /api/lists/order`
- `POST /api/reminders`, `PATCH` / `DELETE /api/reminders/:id`
- `POST /api/push/subscribe`, `/unsubscribe`, `/test`
- `POST /api/password`
- `POST /api/logout`

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

Sessions are stored in memory, so restarting the process logs you out. The session secret and VAPID keys persist in the `settings` table.

## Version

1.1.1

## License

UNLICENSED
