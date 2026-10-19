# Decisions

Append only. One `##` entry per decision, newest at the bottom. An agent adds an entry with
`**Status:** open` when it recommends something; Dillon's call changes it to `decided` or
`declined`. `scripts/ceo/snapshot.mjs` lists every open entry. Gitignored: copy to
`ops/decisions.md`.

**Every value below is a placeholder showing the format.**

## Delete the legacy tcg-backend folder

**Status:** open
**Raised by:** ceo · **Raised:** 2026-10-19
**Recommendation:** delete it.
**Why:** `CLAUDE.md` calls it an inactive prototype, and git history keeps it.
**Cost of deciding wrong:** none; it can be restored from git.
**Would change my mind:** finding anything in it that production still reads.

## Example of a closed entry

**Status:** decided
**Raised by:** ops · **Raised:** 2026-10-01 · **Decided:** 2026-10-03
**Decision:** hold the Playwright major bump until the E2E suite passes on it locally.
**Follow through:** `/qa` runs the suite on a branch with the bump.
