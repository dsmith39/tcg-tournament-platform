# TCG Tournament Platform — CLAUDE.md

## Project Overview

A web application for Yu-Gi-Oh! players and tournament organizers (primarily Yu-Gi-Oh! TCG,
Master Duel, Duel Links). Two halves in one app:

- **Tournament platform**: user accounts, decklist management, full tournament lifecycle
  (registration, Swiss/elimination pairings, match reporting with dispute resolution,
  standings, top cut).
- **Player tools**: Card Lookup, an LP (Life Points) Calculator, and a Meta Tracker
  (win/loss duel log) — ported in from a standalone companion app (`ygo-tools`) that used
  to live in a separate folder in this workspace. These three tools don't require login.

Card data (search, images) is served from a local SQLite mirror of the YGOPRODeck catalog
(`card-database/`, absorbed from a former standalone `ygo-database` project) rather than
calling the public YGOPRODeck API on every request — see "Card Database" below.

The stack is intentionally minimal: vanilla JavaScript SPA on the frontend, Express +
SQLite + Socket.IO on the backend, no build tools.

---

## Commands

```bash
# Start development server (with auto-restart)
npm run dev

# Start production server
npm start

# Run API integration tests (Node built-in test runner)
npm run test:api

# Run E2E tests headlessly (requires server running or uses webServer config)
npm run test:e2e

# Run E2E tests with browser visible
npm run test:e2e:headed

# Run E2E tests locally (handles server startup/teardown)
npm run test:e2e:local

# Install Playwright browser
npm run test:e2e:install

# Card database maintenance (see "Card Database" below)
npm run cards:init-db
npm run cards:import
npm run cards:search -- "Blue-Eyes"
npm run cards:download-images
```

**Default port:** `5000` (set via `PORT` env var). Playwright E2E tests expect port `3200` — set `PORT=3200` when running the server for E2E.

---

## Architecture

### Backend

Single Express app served from `server.js`. All API logic lives in `server/api-server.js` and is registered via `registerApi(app, io)`. Socket.IO shares the same HTTP server for real-time updates. The card-database router (`card-database/src/api_router.js`) is mounted at `/api/v7` inside `registerApi`.

```
server.js                     # Entry point — HTTP server, Socket.IO, static routes
server/
  api-server.js               # Route handlers, tournament/match business logic (~2,600 lines)
  db.js                       # SQLite connection + schema (server/data/app.db)
  models/
    id.js                     # generateId() — 24-char hex ids, shaped like Mongo ObjectIds
    users.js                  # User repository
    decklists.js              # Decklist repository
    tournaments.js            # Tournament repository + populate()-equivalent hydration
  security.js                 # Rate limiting policies (auth, write, match actions)
  validation.js                # Zod schemas + validateRequest middleware
card-database/
  src/
    db.js                     # SQLite connection + schema (card-database/data/cards.db)
    models/cards.js           # Card repository
    api_router.js             # Mountable Express router: /cardinfo.php, /card-image/:id
    import_cards.js           # Bulk-imports the catalog from the live YGOPRODeck API
    search_cards.js           # CLI card search
    download_card_images.js   # Downloads card images locally
    init_db.js                # Schema-only init
  card-images/                # Downloaded card art (gitignored, ~4.6GB)
  data/cards.db                # SQLite card catalog (gitignored)
```

**Route prefix:** All API routes are under `/api/`. The frontend SPA shell is served for every other route.

**Auth:** Cookie-based JWTs. Access tokens (15-min TTL) and refresh tokens (7-day TTL, hashed, rotated on use) are set as `httpOnly` cookies. The `sessionVersion` field on User invalidates all tokens on logout-all.

**Real-time:** Socket.IO emits `tournament:updated` and `decklist:updated` events after mutations so connected clients refresh without polling.

### Frontend

A single-file vanilla JS SPA:
```
tcg-frontend-updated.html     # HTML shell (loads CSS + JS)
tcg-frontend.css              # Styles with CSS custom properties for dark/light theming
tcg-frontend.js               # ~4,400 lines — all routing, rendering, API calls, Socket.IO client
```

No framework, no bundler, no build step. DOM is manipulated directly. Global state is stored in module-level variables (`currentUser`, `currentTournamentDetailId`, `deckBuilder`, `lpState`, `metaTrackerHistory`, etc.).

**Sections:** hand-rolled router — `<section id="...">` elements toggled by `activateSection()`/`switchSection()`, with URL sync via `getRouteFromLocation()`/`getPathForSection()`/`renderRouteFromLocation()`. `card-lookup`, `meta-tracker`, and `lp-calc` are the three player-tool sections; unlike `dashboard`/`create`/`decklists`, they are **not** auth-gated in `switchSection()`.

### Card Database

`card-database/` is a local SQLite mirror of the YGOPRODeck card catalog. The app's own `/api/v7/cardinfo.php` and `/api/v7/card-image/:id` endpoints are served entirely from this local data — **the running app never calls the live YGOPRODeck API**. The only code that ever talks to `db.ygoprodeck.com` is `card-database/src/import_cards.js` and `download_card_images.js`, run manually by the operator:

```bash
npm run cards:init-db          # create the schema (idempotent)
npm run cards:import           # bulk-refresh the catalog from YGOPRODeck (~14k cards)
npm run cards:download-images  # download card art locally (~4.6GB for all variants)
```

There is **no automatic live-API fallback** on a cache miss — a card missing locally just isn't found until the operator reruns `cards:import`. This is deliberate: YGOPRODeck doesn't want the app hammering their API on every user search.

### Database

Two separate SQLite files (via Node's built-in `node:sqlite`, not the `better-sqlite3` npm package — this workspace doesn't have a C++ build toolchain installed, and `node:sqlite` needs no native compilation):

- **`server/data/app.db`** — `users`, `decklists`, `tournaments` tables. Tournaments store their nested rounds/matches/registrations as a JSON column (`tournaments.data`) rather than fully normalized child tables: every route handler already loads a tournament whole, mutates the in-memory tree, and saves it back whole, so there's no per-row concurrent-update pattern that would benefit from normalization.
- **`card-database/data/cards.db`** — `cards` table, one row per Yu-Gi-Oh card, `images`/`sets`/`prices`/`banlistInfo` stored as JSON columns.

Both are `:memory:` databases when `NODE_ENV=test` (see `server/db.js`/`card-database/src/db.js` `resetDb()`), so the test suite never touches the real `.db` files.

Model shapes (fields on objects returned by `server/models/*.js`):
- **User** — auth, profile, `refreshTokens` (JSON array on the row), `sessionVersion`
- **Decklist** — card lists stored as newline-separated strings
- **Tournament** — status machine: `registration → active → completed`
- **Round** (in `tournament.rounds`) — `not_started → active → locked → completed`
- **Match** (in `round.matches`) — `pending → awaiting-confirmation → confirmed | disputed`
- **Registration** (in `tournament.registrations`) — player + decklist snapshot at join time

---

## Key Patterns

### Input Validation

All write endpoints use `validateRequest({ body: schema, params: schema })` middleware from `server/validation.js`. Handlers receive clean data on `req.validated.body` and `req.validated.params` and can trust the shape without re-checking. `objectIdSchema` validates the 24-char hex id format `server/models/id.js`'s `generateId()` produces (chosen specifically to keep this regex unchanged from the Mongo-ObjectId era).

### Rate Limiting

Three policies from `server/security.js`:
- `authLimiter` — 10 req/15 min per IP on auth endpoints
- `writeLimiter` — 60 req/5 min per user+IP on all write routes
- `matchLimiter` — 30 req/2 min per user+IP on match actions

In tests, `NODE_ENV=test` enables rate limiting but the test suite calls `flushRateLimitStores()` in `beforeEach` to reset between tests.

### Admin Panel

Site-operator access is an email allowlist, not a stored role: `ADMIN_EMAILS` (comma-separated) is checked against the logged-in user's email in `authMiddleware`, which sets `req.user.isAdmin`. `GET /api/auth/me` returns `isAdmin` so the frontend can show/hide the `#admin` section; `requireAdmin` gates every `/api/admin/*` route server-side regardless of what the client shows. `isOrganizer(tournament, req)` lets an admin act as the organizer on *any* tournament — the existing resolve/reopen/start/lock/complete/delete routes all use it, so there's no separate admin copy of that logic. `/api/admin/*` adds what those per-owner routes can't: `stats` (site-wide counts), `tournaments` (cross-tournament list/filter, backed by `tournamentsRepo.listAllFull()`), `disputes` (every open dispute across every tournament, not just one TO's), and `tournaments/:id/status` + `tournaments/:id/organizer` (emergency status override / organizer reassignment when a TO goes unresponsive).

### Tournament Logic

- **Swiss pairings:** avoids rematches, recommended rounds = `ceil(log2(playerCount))`
- **Standings:** 3 pts for win, 1 for draw; tiebreaker = opponent match-win percentage
- **Top cut:** supported after Swiss rounds complete; creates a new elimination bracket phase
- **Match confirmation flow:** reporter sets result → opponent confirms or disputes → TO can resolve or reopen

This logic (in `server/api-server.js`) is pure JS operating on an in-memory tournament object tree — it's identical regardless of storage engine, and was left untouched by the MongoDB → SQLite migration.

### Deck Builder

The decklist form (`#decklists` section) already enforces per-format size limits (TCG/Master Duel 40–60 main, Duel Links 20–30 main), a flat 3-copy cap for all games, and TCG banlist enforcement (`validateDecklistLegality`, `getMaxAllowedCopiesByBanStatus`) by resolving each card through the local card database. `.ydk` import/export (`exportCurrentDeckAsYdk`, `exportDecklistByIdAsYdk`, `importDeckFromTextPrompt`) and a Monster/Spell/Trap/Total stat line (`renderDeckStats`) round it out.

---

## Testing

```
tests/
  api.integration.test.js     # Supertest + in-memory SQLite (:memory:), Node built-in runner
  e2e/
    auth.spec.js
    decklists.spec.js
    tournaments.spec.js
    tournament-detail.spec.js
    rate-limit.spec.js
    navigation-back-url.spec.js
    helpers/mock-api.js
```

- Integration tests use an in-memory SQLite database (`NODE_ENV=test` → `server/db.js` opens `:memory:`), reset fresh in `beforeEach` via `resetDb()`.
- E2E tests run against the live server; `playwright.config.js` starts it automatically via `webServer`.
- The CI pipeline runs both suites; E2E uses 1 worker (`--workers=1`) to avoid port conflicts.

---

## Environment Variables

```
PORT=5000                     # HTTP server port
HOST=127.0.0.1                # Bind address
JWT_SECRET=<strong-random-secret>  # generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
NODE_ENV=development          # Set to "test" in test scripts (also switches both DBs to :memory:)
CARD_IMAGE_DIR=               # Optional override for card-database/src/api_router.js's image directory
ADMIN_EMAILS=                 # Comma-separated allowlist granting access to the /admin panel
```

**No database URL needed** — both SQLite databases are just files, created automatically on first run (`server/data/app.db`, `card-database/data/cards.db`).

**Never commit real secrets.** `.env` is listed in `.gitignore` and is never tracked by git. Copy `.env.example` to `.env` and fill in real values before running the server. `.env.example` contains only placeholder values and is safe to commit.

---

## Legacy Directories

- `tcg-backend/` — original monolithic prototype, kept for reference but not active
- `tcg-frontend/` — empty, leftover from scaffolding

These can be deleted once no longer needed for reference. (Unrelated to the ygo-tools/ygo-database merge — those two folders, plus two loose root-level HTML prototypes, were deleted outright since their functionality was fully absorbed into this project.)

---

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on push to main and all PRs:
1. `npm ci`
2. Install Playwright (Chromium)
3. `npm run test:api`
4. `npm run test:e2e`
5. Upload Playwright report and test-results artifacts

Node 24 is pinned in CI (bumped from 20 during the MongoDB → SQLite migration). `node:sqlite` exists from Node 22.5.0, but requires the `--experimental-sqlite` CLI flag on every 22.x release before 22.13.0 — an early attempt to pin CI to `'22.11'` hit exactly that gap (`ERR_UNKNOWN_BUILTIN_MODULE`) since `require('node:sqlite')` fails outright without the flag on those versions. Pinning to Node 24 sidesteps the flag question entirely. `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` is set for GitHub-hosted runner action compatibility.
