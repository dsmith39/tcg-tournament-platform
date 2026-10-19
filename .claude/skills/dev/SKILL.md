---
name: dev
description: >
  Run the developer for The Duel Club. Modes: fix <what> (a bug), build <what> (a feature or
  endpoint), or any coding task. Works on a branch, runs the test suites, and commits; never
  pushes to main, merges, deploys, or touches AWS or production data.
argument-hint: "[fix <what> | build <what> | <task>]"
disable-model-invocation: true
context: fork
agent: developer
---

## Developer run

Arguments: `$ARGUMENTS`

Read `docs/staff-handbook.md` and `CLAUDE.md` first. Pick the mode from the first word. Anything
else is the task itself.

**Before any edit:** check `git status`. If you're on `main`, create a branch for the job first.
If the working tree has uncommitted changes that aren't yours, stop and say so.

### fix <what>
Reproduce it, ideally as a failing test. Fix the smallest thing that solves it and check nothing
else moved. Include the reserved word alias check for any DynamoDB expression you touch.

### build <what>
Find the closest existing route or section and follow its pattern: validation schema, rate
limit policy, auth gate, realtime broadcast where the data changes. Add tests with the code. Check
both themes and a narrow viewport for anything visible. Update the Model shapes or Key Patterns
notes in your report if `CLAUDE.md` needs a change; don't edit `CLAUDE.md` yourself.

**Every mode ends the same way:** `npm run test:api` and `npm run test:e2e:local` run and
reported honestly (including anything you couldn't run and why), a commit on the branch, and a
note in `ops/staff/dev/` with the branch, what changed, results, rough hours, and anything Dillon
has to do (push the branch, open the PR). Never push to `main`, and remember a merge deploys.
