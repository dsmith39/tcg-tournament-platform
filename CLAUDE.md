# TCG Tournament Platform — CLAUDE.md

## Project Overview

A web application for Yu-Gi-Oh! players and tournament organizers (primarily Yu-Gi-Oh! TCG,
Master Duel, Duel Links). Deployed live as **The Duel Club** at **theduelclub.com**. Two
halves in one app:

- **Tournament platform**: user accounts, decklist management, full tournament lifecycle
  (registration, Swiss/elimination pairings, match reporting with dispute resolution,
  standings, top cut).
- **Player tools**: Card Lookup, an LP (Life Points) Calculator, and a Meta Tracker
  (win/loss duel log) — ported in from a standalone companion app (`ygo-tools`) that used
  to live in a separate folder in this workspace. These three tools don't require login.

Card data (search, images) is served from a local SQLite mirror of the YGOPRODeck catalog
(`card-database/`, absorbed from a former standalone `ygo-database` project) rather than
calling the public YGOPRODeck API on every request — see "Card Database" below.

The stack is intentionally minimal: vanilla JavaScript SPA on the frontend, Express on the
backend, no build tools. App data (users/decklists/tournaments) lives in **DynamoDB**; the
card catalog stays in local **SQLite**. Live updates use Socket.IO locally and API Gateway
WebSocket once deployed — see "Real-time" below.

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

# Manual/one-off deploy to AWS (theduelclub.com) — normally deploys happen
# automatically on merge to main instead; see "Deployment" below
.\deploy\aws\deploy.ps1
```

**Default port:** `3001` (set via `PORT` env var). Playwright E2E tests expect port `3200` — set `PORT=3200` when running the server for E2E.

---

## Architecture

### Backend

Single Express app served from `server.js`. All API logic lives in `server/api-server.js` and is registered via `registerApi(app)`. The card-database router (`card-database/src/api_router.js`) is mounted at `/api/v7` inside `registerApi`.

```
server.js                     # Entry point — HTTP server, Socket.IO (local dev), static routes
server/
  api-server.js               # Route handlers, tournament/match business logic (~2,600 lines)
  dynamo.js                   # DynamoDB client (getClient, test-only resetTables())
  dynamo-schema.js             # Table names + CreateTable definitions (source of truth for tests)
  realtime.js                  # Transport-agnostic broadcast: Socket.IO locally, API Gateway
                               # PostToConnection when deployed (see "Real-time" below)
  ws-handler/
    index.js                  # Separate Lambda: API Gateway WebSocket $connect/$disconnect
  models/
    id.js                     # generateId() — 24-char hex ids, shaped like Mongo ObjectIds
    users.js                  # User repository (DynamoDB)
    decklists.js              # Decklist repository (DynamoDB)
    tournaments.js            # Tournament repository (DynamoDB) + populate()-equivalent hydration
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
    flatten_for_deploy.js     # Switches a staged cards.db copy out of WAL mode before zipping
  card-images/                # Downloaded card art (gitignored, ~4.6GB)
  data/cards.db                # SQLite card catalog (gitignored)
```

**Route prefix:** All API routes are under `/api/`. Locally, `server.js` also serves the frontend SPA shell for every other route; deployed, the frontend is static (S3 + CloudFront) and the Lambda only ever answers `/api/*` — see "Deployment".

**Auth:** Cookie-based JWTs. Access tokens (15-min TTL) and refresh tokens (7-day TTL, hashed, rotated on use) are set as `httpOnly` cookies. The `sessionVersion` field on User invalidates all tokens on logout-all. Deployed, the frontend and API are different origins (theduelclub.com / api.theduelclub.com), so `CORS_ALLOWED_ORIGINS` (server/api-server.js) allowlists specific origins and echoes credentials instead of using `*`.

**Real-time:** `server/realtime.js` broadcasts `tournaments:updated` and `decklist:updated` after mutations, transport chosen by `REALTIME_TRANSPORT`:
- **Local dev (default, `socketio`):** `server.js` attaches Socket.IO to the shared HTTP server; `realtime.js` calls `io.emit(...)` directly. No AWS-native local emulator exists for API Gateway WebSocket, so this stays the local path.
- **Deployed (`apigw-ws`):** a separate WebSocket API + minimal Lambda (`server/ws-handler/`) tracks connections in the `Connections` DynamoDB table on `$connect`/`$disconnect`; `realtime.js` broadcasts by scanning that table and calling `PostToConnection` on each. Unauthenticated global broadcast — no rooms, no per-user targeting, matching the Socket.IO behavior it replaces.

### Frontend

A single-file vanilla JS SPA:
```
tcg-frontend-updated.html     # HTML shell (loads CSS + JS)
tcg-frontend.css              # Styles with CSS custom properties for dark/light theming
tcg-frontend.js               # ~4,400 lines — all routing, rendering, API calls, live-update client
```

No framework, no bundler, no build step. DOM is manipulated directly. Global state is stored in module-level variables (`currentUser`, `currentTournamentDetailId`, `deckBuilder`, `lpState`, `metaTrackerHistory`, etc.).

`initializeRealtimeSocket()` picks its transport at runtime: if `window.TCG_CONFIG.wsUrl` is set it opens a raw `WebSocket` against it (deployed), otherwise it falls back to the Socket.IO client (local dev). `window.TCG_CONFIG` only exists in deployed builds — it's written to a `config.js` by `deploy/aws/deploy.ps1` (`apiBaseUrl`, `wsUrl`, `cardImageBaseUrl`); locally the frontend calls same-origin `/api/...` and connects Socket.IO with no config needed. A `/config.js` 404 locally and a `/socket.io/socket.io.js` 404 once deployed are both expected — see the comment in `tcg-frontend-updated.html`.

**Sections:** hand-rolled router — `<section id="...">` elements toggled by `activateSection()`/`switchSection()`, with URL sync via `getRouteFromLocation()`/`getPathForSection()`/`renderRouteFromLocation()`. `card-lookup`, `meta-tracker`, and `lp-calc` are the three player-tool sections; unlike `dashboard`/`create`/`decklists`, they are **not** auth-gated in `switchSection()`.

### Card Database

`card-database/` is a local SQLite mirror of the YGOPRODeck card catalog. The app's own `/api/v7/cardinfo.php` and `/api/v7/card-image/:id` endpoints are served entirely from this local data — **the running app never calls the live YGOPRODeck API**. The only code that ever talks to `db.ygoprodeck.com` is `card-database/src/import_cards.js` and `download_card_images.js`, run manually by the operator:

```bash
npm run cards:init-db          # create the schema (idempotent)
npm run cards:import           # bulk-refresh the catalog from YGOPRODeck (~14k cards)
npm run cards:download-images  # download card art locally (~4.6GB for all variants)
```

There is **no automatic live-API fallback** on a cache miss — a card missing locally just isn't found until the operator reruns `cards:import`. This is deliberate: YGOPRODeck doesn't want the app hammering their API on every user search.

Deployed, `cards.db` ships read-only inside the Lambda zip. `CARD_DB_READONLY=true` (set only in that Lambda's env) skips the WAL pragma/schema bootstrap in `card-database/src/db.js`, which would otherwise throw `EROFS` on Lambda's read-only filesystem; `deploy/aws/deploy.ps1` runs `flatten_for_deploy.js` on a staged copy first since WAL mode needs to create a `-shm` file even for read-only connections. Card images are served from a CloudFront CDN (`cdn.theduelclub.com`) instead of this app once `CARD_IMAGE_BASE_URL` is set — `card-database/src/api_router.js` builds URLs against it instead of its own `/card-image/:id` route.

### Database

Two storage engines, split by write pattern:

- **DynamoDB** — app data (`users`, `decklists`, `tournaments`, plus a `connections` table for WebSocket fan-out). Table names/schemas are defined once in `server/dynamo-schema.js` and mirrored by hand in `template.yaml`'s `AWS::DynamoDB::Table` resources (only 4 tables, so drift risk is low). Tournaments store their nested rounds/matches/registrations as a single JSON-shaped item attribute rather than normalized child items: every route handler already loads a tournament whole, mutates the in-memory tree, and saves it back whole, so there's no per-item concurrent-update pattern that would benefit from normalization. `users` enforces username/email uniqueness with a lock-item pattern (extra items at `pk="USERNAME#<u>"`/`pk="EMAIL#<e>"`) since DynamoDB has no native unique-attribute constraint. `server/dynamo.js` is the shared client; tests point it at a local `dynalite` instance via `DYNAMODB_ENDPOINT` and call `resetTables()` for a clean slate per run.
  - **Reserved keywords in expressions:** attribute names used directly in a `KeyConditionExpression`/`FilterExpression`/`UpdateExpression` (e.g. `owner`, `name`, `status`, `game`) must be aliased via `ExpressionAttributeNames` (`'#owner': 'owner'` → `#owner = :owner`) if they collide with a [DynamoDB reserved word](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html). `dynalite` (the local test emulator) does **not** enforce this the way real DynamoDB does, so a query built against a reserved word passes `npm run test:api` locally/in CI but throws `ValidationException: Attribute name is a reserved keyword` in production — this is exactly what broke `GET /api/decklists` (`owner-index` query in `server/models/decklists.js` used bare `owner`, fixed by aliasing to `#owner`). When adding a new Query/Scan/Update expression, alias the attribute name defensively rather than trusting a green test run.
- **SQLite** (`card-database/data/cards.db`, via Node's built-in `node:sqlite`, not the `better-sqlite3` npm package — no C++ build toolchain in this workspace, and `node:sqlite` needs no native compilation) — bulk-overwritten catalog data only, never written to by live user traffic. One `cards` table, `images`/`sets`/`prices`/`banlistInfo` stored as JSON columns. `:memory:` when `NODE_ENV=test`.

Model shapes (fields on objects returned by `server/models/*.js`):
- **User** — auth, profile, `refreshTokens` (JSON array), `sessionVersion`
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

This logic (in `server/api-server.js`) is pure JS operating on an in-memory tournament object tree — it's identical regardless of storage engine, and was left untouched across the MongoDB → SQLite → DynamoDB migrations.

### Deck Builder

The decklist form (`#decklists` section) already enforces per-format size limits (TCG/Master Duel 40–60 main, Duel Links 20–30 main), a flat 3-copy cap for all games, and TCG banlist enforcement (`validateDecklistLegality`, `getMaxAllowedCopiesByBanStatus`) by resolving each card through the local card database. `.ydk` import/export (`exportCurrentDeckAsYdk`, `exportDecklistByIdAsYdk`, `importDeckFromTextPrompt`) and a Monster/Spell/Trap/Total stat line (`renderDeckStats`) round it out.

---

## Testing

```
tests/
  api.integration.test.js     # Supertest + a local dynalite instance standing in for DynamoDB
  e2e/
    auth.spec.js
    decklists.spec.js
    tournaments.spec.js
    tournament-detail.spec.js
    rate-limit.spec.js
    navigation-back-url.spec.js
    helpers/mock-api.js
```

- Integration tests spin up `dynalite` (an in-process DynamoDB emulator) and point `server/dynamo.js` at it via `DYNAMODB_ENDPOINT`, reset fresh via `resetTables()`. The card catalog still uses in-memory SQLite (`NODE_ENV=test` → `card-database/src/db.js` opens `:memory:`).
- E2E tests run against the live server; `playwright.config.js` starts it automatically via `webServer`.
- The CI pipeline runs both suites; E2E uses 1 worker (`--workers=1`) to avoid port conflicts.

---

## Environment Variables

```
PORT=3001                     # HTTP server port (server.js default; E2E overrides to 3200)
HOST=127.0.0.1                # Bind address
JWT_SECRET=<strong-random-secret>  # generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
NODE_ENV=development          # Set to "test" in test scripts (dynalite + in-memory card SQLite)
CARD_IMAGE_DIR=               # Optional override for card-database/src/api_router.js's local image directory
ADMIN_EMAILS=                 # Comma-separated allowlist granting access to the /admin panel

# DynamoDB (all optional locally — default to the real theduelclub-* AWS tables
# under your own credentials; set only for tests or to target a different stack)
USERS_TABLE=, DECKLISTS_TABLE=, TOURNAMENTS_TABLE=, CONNECTIONS_TABLE=
DYNAMODB_ENDPOINT=            # Set by tests to point at a local dynalite instance

# Deployment-only (set by template.yaml in the Lambda's environment, not used locally)
REALTIME_TRANSPORT=socketio   # "socketio" (local default) or "apigw-ws" (deployed)
WS_API_ENDPOINT=              # API Gateway Management API endpoint, apigw-ws mode only
CARD_DB_READONLY=             # "true" on the deployed Lambda — skips WAL/schema writes to cards.db
CARD_IMAGE_BASE_URL=          # CDN origin for card art once deployed (cdn.theduelclub.com)
CORS_ALLOWED_ORIGINS=         # Comma-separated allowlist; unset = reflect any origin (local/same-origin)
```

**No database URL needed for local dev** — the card catalog is a SQLite file created automatically on first run (`card-database/data/cards.db`); app data talks to real AWS DynamoDB via your own credentials unless `DYNAMODB_ENDPOINT` is set.

**Never commit real secrets.** `.env` is listed in `.gitignore` and is never tracked by git. Copy `.env.example` to `.env` and fill in real values before running the server. `.env.example` contains only placeholder values and is safe to commit.

---

## Deployment

Live at **theduelclub.com**, deployed as a single AWS SAM/CloudFormation stack (`template.yaml`, stack name `theduelclub`, `us-east-1`). Two ways to trigger a deploy:

- **Automatic (normal path):** `.github/workflows/deploy.yml` runs after every `CI` workflow run on `main` that concludes successfully — i.e. merging a PR to `main` deploys to production once CI is green, with no manual step required. It rebuilds the Lambda zip, packages/deploys `template.yaml` via `aws cloudformation deploy`, syncs the frontend to S3, and invalidates CloudFront. It downloads `card-database/data/cards.db` from `s3://theduelclub-deploy-<account-id>/card-database/cards.db` rather than rebuilding the catalog (upload a new one manually when the catalog changes — see the workflow's comments) and does **not** sync card images (`-SyncCardImages`-equivalent is a manual `aws s3 sync`, same rationale as `deploy.ps1` below). Requires the `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`JWT_SECRET`/`ADMIN_EMAILS` repository secrets under the `production` environment.
- **Manual (local/one-off):** `.\deploy\aws\deploy.ps1`, same underlying stack — see below.

The stack itself:

- **Frontend** — static (`tcg-frontend-updated.html`/`.css`/`.js`) on S3 + CloudFront, not served by the Lambda. `CustomErrorResponses` fall back 403/404 to `index.html` so the SPA's own router still handles client-side paths.
- **API** — the same Express app as local dev, on Lambda behind an API Gateway HTTP API (`api.theduelclub.com`), via the Lambda Web Adapter (`run.sh`, `AWS_LAMBDA_EXEC_WRAPPER`).
- **Live updates** — a separate WebSocket API (`ws.theduelclub.com`) + `server/ws-handler/` Lambda; see "Real-time" above.
- **App data** — DynamoDB (`theduelclub-Users/Decklists/Tournaments/Connections`), `PAY_PER_REQUEST`, retained on stack deletion.
- **Card images** — a second S3 + CloudFront pair (`cdn.theduelclub.com`), kept separate from the frontend distribution since a cache-forever 4.6GB immutable image set has different invalidation needs than the frequently-redeployed SPA bundle.
- **Certificate/DNS** — one ACM cert (must be `us-east-1` for CloudFront) covers apex/`www`/`api`/`ws`/`cdn`; Route 53 records point at each.

`deploy.ps1` requires the AWS CLI (authenticated), Docker Desktop running (zips the Lambda package with Unix file-mode bits intact — Windows zip tools strip them, breaking the Web Adapter's cold start), and `card-database/data/cards.db` already built (`npm run cards:init-db && npm run cards:import`). Pass `-SyncCardImages` to also sync the ~4.6GB image set (slow, so it's opt-in per deploy). The JWT secret is read from `.env` by default so re-deploys keep existing sessions valid; override with `-JwtSecret`.

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

`.github/workflows/deploy.yml` is a separate workflow, triggered via `workflow_run` once `CI` completes successfully on `main` — so a merge to `main` deploys to production automatically as long as CI is green. See "Deployment" below for what it does. It never runs directly off a PR branch, and a failing CI run on `main` blocks it from firing at all.
