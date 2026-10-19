---
name: cards
description: >
  Run the card data steward for The Duel Club. Modes: status (is the catalog, banlist data, and
  skill list current, the default), refresh (an ordered plan to update the catalog or skills),
  banlist (verify stored limits against a named source), ask <question> (answer a card or format
  question from the local catalog). Plans and verifies; the operator runs imports.
argument-hint: "[status | refresh | banlist | ask <question>]"
disable-model-invocation: true
context: fork
agent: cards
---

## Card steward run

Arguments: `$ARGUMENTS`

Work from the repo root. Pick the mode from the first word. No arguments means **status**.
Anything else is a question: answer it as the card steward.

**Every mode starts the same way:** read `docs/staff-handbook.md` and `CLAUDE.md` → Card Database,
Deck Builder, and Duel Links Skill Catalog, then run `node scripts/ceo/snapshot.mjs`.

### status
When was the catalog and the skill JSON last updated (file dates, git log, `gh run list` for the
`Update Card Database` and `Sync Card Images` workflows)? What has probably changed since? What
can't be known offline, and what would show it?

### refresh
The ordered steps to update the catalog and/or skills, including the sanity checks (card count, a
few known cards, a diff of the skill JSON), how it ships (only with the next deploy), and who runs
each command. Never run an import yourself.

### banlist
Sample cards whose limits changed and compare the stored `banlistInfo` with a source you name and
date. Report matches and mismatches. If you have no source, say so and say what to check.

### ask <question>
Answer from the local catalog (`npm run cards:search -- "<name>"`) and `CLAUDE.md`, name the
source, and say when the data may be stale. Never answer a ruling from memory as fact.

**Every mode ends the same way:** a report in `ops/staff/cards/<YYYY-MM-DD>-<topic>.md` in the
handbook format, and your reply ends with the bottom line and the path.
