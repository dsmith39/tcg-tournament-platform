# TCG Tournament Platform — CLAUDE.md

## Project Overview

A web application for managing trading card game tournaments (primarily Yu-Gi-Oh! TCG, Master Duel, Duel Links). Features include user accounts, decklist management (with live card search via YGO ProDeck), and full tournament lifecycle management: registration, Swiss/elimination pairings, match reporting with dispute resolution, standings, and top cut.

The stack is intentionally minimal: vanilla JavaScript SPA on the frontend, Express + MongoDB + Socket.IO on the backend, no build tools.

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
```

**Default port:** `5000` (set via `PORT` env var). Playwright E2E tests expect port `3200` — set `PORT=3200` when running the server for E2E.

---

## Architecture

### Backend

Single Express app served from `server.js`. All API logic lives in `server/api-server.js` and is registered via `registerApi(app, io)`. Socket.IO shares the same HTTP server for real-time updates.

```
server.js                     # Entry point — HTTP server, Socket.IO, static routes
server/
  api-server.js               # All Mongoose models, middleware, and route handlers (~2,650 lines)
  security.js                 # Rate limiting policies (auth, write, match actions)
  validation.js               # Zod schemas + validateRequest middleware
```

**Route prefix:** All API routes are under `/api/`. The frontend SPA shell is served for every other route.

**Auth:** Cookie-based JWTs. Access tokens (15-min TTL) and refresh tokens (7-day TTL, hashed in DB, rotated on use) are set as `httpOnly` cookies. The `sessionVersion` field on User invalidates all tokens on logout-all.

**Real-time:** Socket.IO emits `tournament:updated` and `decklist:updated` events after mutations so connected clients refresh without polling.

### Frontend

A single-file vanilla JS SPA:
```
tcg-frontend-updated.html     # HTML shell (loads CSS + JS)
tcg-frontend.css              # Styles with CSS custom properties for dark/light theming
tcg-frontend.js               # ~164KB — all routing, rendering, API calls, Socket.IO client
```

No framework, no bundler, no build step. DOM is manipulated directly. Global state is stored in module-level variables (`currentUser`, `currentTournamentDetailId`, etc.).

### Database

MongoDB via Mongoose. All models are defined inline in `server/api-server.js`:
- **User** — auth, profile, refresh tokens, sessionVersion
- **Decklist** — card lists stored as newline-separated strings
- **Tournament** — status machine: `open → in-progress → completed`
- **Round** (subdocument of Tournament) — `pending → active → locked`
- **Match** (subdocument of Round) — `pending → awaiting-confirmation → confirmed | disputed`
- **Registration** (subdocument of Tournament) — player + decklist snapshot at join time

---

## Key Patterns

### Input Validation

All write endpoints use `validateRequest({ body: schema, params: schema })` middleware from `server/validation.js`. Handlers receive clean data on `req.validated.body` and `req.validated.params` and can trust the shape without re-checking.

### Rate Limiting

Three policies from `server/security.js`:
- `authLimiter` — 10 req/15 min per IP on auth endpoints
- `writeLimiter` — 60 req/5 min per user+IP on all write routes
- `matchLimiter` — 30 req/2 min per user+IP on match actions

In tests, `NODE_ENV=test` enables rate limiting but the test suite calls `flushRateLimitStores()` in `beforeEach` to reset between tests.

### Tournament Logic

- **Swiss pairings:** avoids rematches, recommended rounds = `ceil(log2(playerCount))`
- **Standings:** 3 pts for win, 1 for draw; tiebreaker = opponent match-win percentage
- **Top cut:** supported after Swiss rounds complete; creates a new elimination bracket phase
- **Match confirmation flow:** reporter sets result → opponent confirms or disputes → TO can resolve or reopen

---

## Testing

```
tests/
  api.integration.test.js     # Supertest + mongodb-memory-server, Node built-in runner
  e2e/
    auth.spec.js
    decklists.spec.js
    tournaments.spec.js
    tournament-detail.spec.js
    rate-limit.spec.js
    navigation-back-url.spec.js
    helpers/mock-api.js
```

- Integration tests use an in-memory MongoDB instance (no real DB needed).
- E2E tests run against the live server; `playwright.config.js` starts it automatically via `webServer`.
- The CI pipeline runs both suites; E2E uses 1 worker (`--workers=1`) to avoid port conflicts.

---

## Environment Variables

```
PORT=5000                     # HTTP server port
HOST=127.0.0.1                # Bind address
MONGODB_URI=mongodb://127.0.0.1:27017/tcg-tournament
JWT_SECRET=<strong-random-secret>  # generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
NODE_ENV=development          # Set to "test" in test scripts
```

**Never commit real secrets.** `.env` is listed in `.gitignore` and is never tracked by git. Copy `.env.example` to `.env` and fill in real values before running the server. `.env.example` contains only placeholder values and is safe to commit.

---

## Legacy Directories

- `tcg-backend/` — original monolithic prototype, kept for reference but not active
- `tcg-frontend/` — empty, leftover from scaffolding

These can be deleted once no longer needed for reference.

---

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on push to main and all PRs:
1. `npm ci`
2. Install Playwright (Chromium)
3. `npm run test:api`
4. `npm run test:e2e`
5. Upload Playwright report and test-results artifacts

Node 20 is pinned in CI. `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` is set for GitHub-hosted runner action compatibility.
