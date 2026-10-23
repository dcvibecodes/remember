# Done!

A self-hosted, single-user task app in the spirit of Apple Reminders. Lists, due dates, urgent flags, recurring reminders, natural-language quick add, smart lists, floating time zones, a token API for external agents, completed history, dark mode, and web push. No frontend framework and no build step.

## What's New in v1.8.12

- **Narrower desktop column** — the centered app column is now 54vw (max 990px), 10% slimmer than before. Mobile unchanged.

## What's New in v1.8.11

- **One search bar** — Home and list-view search boxes now share a single identical spec (icon, padding, font, height), so the search bar no longer changes shape between screens.

## What's New in v1.8.10

- **Aligned Home columns** — wordmark, search box, and section text share one left edge; smart-view icons and list dots share an icon column; labels and list names share a text column.

## What's New in v1.8.9

- **Unified list title** — the list-view title is now the same 22px Fraunces cut as the Home wordmark, and the detail action icons are pinned to the top edge like Home's, so nothing shifts between screens.

## What's New in v1.8.8

- **Divider-free headers** — removed the divider under the list-view header (and the matching Home one), so the search bar sits directly beneath the header row with the same 10px rhythm on both screens.

## What's New in v1.8.7

- **Matching headers** — Home now has the same divider under the header row as the list view, and both screens share one background. Header, icons, and search stay frozen on every screen.

## What's New in v1.8.6

- **Single-scroll Home** — on mobile only the header and search bar stay frozen; smart views, My Lists, and all list rows scroll as one continuous page (no more nested list scroller).

## What's New in v1.8.5

- **Fixed header icons** — the refresh button now sits at the exact same coordinates on Home and inside a list, and the gaps between the list-options (⋯), refresh, and hamburger icons are a uniform 12px on every screen.

## What's New in v1.8.4

- **Renamed to Done!** — the app is now called Done! everywhere: tab title, Home wordmark, auth screen, manifest/PWA name, and notification titles. Old `remember`-marked backup files still import.
- **New Done! icon** — Fraunces “Done!” wordmark on the dark tile, matching the Spend Less / Invest More icon style (`generate-icons.py`, `icon-fonts/`).

## What's New in v1.8.3

- **Unlisted list** — a pinned gray system list that always sits first. It uses a lock instead of a drag handle and cannot be renamed, deleted, or reordered. New reminders added from Home or any smart view default to Unlisted; reminders added while inside a list default to that list.
- **Unified Home** — one full-width Home panel on web and mobile, with a centered 60vw desktop column (max 1100px), plain-text Sort/Order controls, visible drag grips, and a New List text button. The old sidebar/card-grid layout is gone.
- **Fixed menu position** — the hamburger now stays at the exact same top-right position on Home and inside a list; it no longer jumps to the left.
- **Self-hosted fonts** — Fraunces and Outfit are served from `/fonts` and precached by the service worker. No Google Fonts requests, so the display typography is identical on web/mobile and works offline.
- **Service worker** — cache bumped to `remember-v1.8.12`.

## Features

- Lists with a 15-color palette (new lists auto-pick the first unused color, then rotate), drag-to-reorder handles (pointer, touch, and keyboard), and a pinned Unlisted list that stays first.
- Reminders with title, notes, date, optional time, and an urgent flag. Notes render as a text row plus a separate row of compact link chips; bare domains like example.com work, and joining commas are not shown between chips.
- Recurring reminders (daily/weekly/monthly/yearly/custom) with per-occurrence completion history, skip, a **Next occurrence** row action for due series, and this-occurrence-vs-series editing.
- Natural-language quick add: "call mom tomorrow 6pm" pre-fills the editor with a removable preview.
- Smart lists: Today (overdue pinned), Scheduled (grouped by date), All, Flagged (urgent), Completed.
- Time models: fixed instant, floating wall-clock (default; follows the device's last-synced zone), or zone-anchored (with a styled Time zone picker in the editor). Settings has a default model and default zone; changing them affects new reminders only, never existing ones.
- Snooze (in-app button + notification actions where supported). Due rows group their actions under a clear **Snooze until** label: 1 hour, Today/Tomorrow, or Next occurrence for repeating reminders. Opt-in re-push with quiet hours.
- Token API so external agents can list, add, and complete reminders without a browser.
- Completed reminders remain visible for 30 days; older records stay in SQLite but are not returned by the API. Per-list Show/Hide-completed choice is remembered.
- Deleting is inline (no browser dialogs): on touch, swipe any row left — including completed rows — to reveal the red Delete action (centered label), tap it once for “Confirm?”, tap again to delete; swipe right closes the reveal. On the web there is no swipe; hover the row and click the ×, then “Confirm?”. The card slides away when deleted.
- Search across active reminders.
- Desktop uses a centered 60vw column (max 1100px) with one Home panel; reminders fill the column with a fixed FAB. There is no permanent sidebar.
- Mobile home is a full-screen panel: search, Today/Scheduled/All/Flagged/Completed, My Lists, then the lists with drag/long-press reordering. The hamburger holds only Notifications, Settings, and Log out and stays at the same top-right position on Home and inside a list; back returns to the lists. Default time model on a phone is floating.
- Installable PWA with web push notifications. iOS requires 16.4+ and the app installed to the Home Screen.
- Single-user password auth, CSRF protection, rate-limited login, and secure session cookies behind HTTPS.
- Auto, light, and dark themes, plus comfortable/compact density.
- JSON backup download + merge-safe import in Settings.
- One SQLite database; easy to back up and move.

Urgent is a visual flag only: it marks the reminder in red but does not change notification timing or add an alarm.

### Time model differences

- **Fixed** — stores one absolute instant. It fires at the same moment everywhere; the clock time shown changes with the device zone.
- **Floating** — stores a wall-clock time in the device's last-synced zone (“6pm wherever I am”). It re-syncs when the app opens in a new zone; the server cannot detect travel while the app is closed.
- **Anchored** — stores a wall-clock time in a named zone (“6pm Asia/Kolkata”) and keeps that zone's schedule regardless of the device.

The card shows “Floating” without a zone (the editor discloses the last synced zone) and “Anchored · zone” when a specific zone is the rule. Changing the default model/zone in Settings only affects new reminders; the Settings sheet states this in a prominent notice and confirms it again after saving. Existing reminders are never migrated.

## Stack

- Node.js 20+ and Express 4
- SQLite via `sqlite3` (WAL mode, foreign keys on)
- Vanilla JavaScript PWA with a small hash router
- Self-hosted Outfit + Fraunces fonts (no external font CDN)
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
| `CONTACT_EMAIL` | `your@email.com` | VAPID contact email; set your own |

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

1.8.2

## License

UNLICENSED
