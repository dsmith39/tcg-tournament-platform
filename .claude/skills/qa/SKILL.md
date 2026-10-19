---
name: qa
description: >
  Run QA for The Duel Club. Modes: review (check the working branch before a PR, the default),
  logic <area> (audit tournament logic such as swiss, standings, topcut, disputes), gaps (map
  routes to tests and rank what is uncovered), write <what> (add tests on a branch). Never merges
  or deploys.
argument-hint: "[review | logic <area> | gaps | write <what> | <question>]"
disable-model-invocation: true
context: fork
agent: qa
---

## QA run

Arguments: `$ARGUMENTS`

Work from the repo root. Pick the mode from the first word. No arguments means **review**.
Anything else is a question: answer it as the QA lead.

**Every mode starts the same way:** read `docs/staff-handbook.md` and `CLAUDE.md` → Testing, then
run `node scripts/ceo/snapshot.mjs`.

### review
Diff the branch against `main`. For each changed route check validation, the rate limit policy,
auth and admin gating, and test coverage of the new path and one failure path. For each new
DynamoDB expression, check reserved word aliasing. Run `npm run test:api` and
`npm run test:e2e:local`. Report pass or fail per item, with the exact failures, and a clear
"ready for PR" or "not yet."

### logic <area>
Audit the named part of the tournament logic (`swiss`, `standings`, `topcut`, `disputes`, or
`all`) against the rules in `CLAUDE.md`. Probe odd player counts, byes, drops, ties, double
reports, and organizer permissions. Prove each finding with a failing test or a traced scenario.

### gaps
List every route in `server/api-server.js` and mark whether integration or E2E tests cover it.
Rank the uncovered ones by the damage a bug would do to a real organizer.

### write <what>
Add the tests on a branch using the existing helpers. Show each new test failing without the fix
or behavior it guards.

**Every mode ends the same way:** a report in `ops/staff/qa/<YYYY-MM-DD>-<topic>.md` in the
handbook format, and your reply ends with the bottom line and the path.
