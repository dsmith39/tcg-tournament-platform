# `ops/` agent state

Working state for the CEO and staff agents (`docs/staff-handbook.md`). Nothing here is project
documentation; that lives in `CLAUDE.md`. Most of it is gitignored because it holds decisions,
owner goals, and notes that mention users and costs.

| Path | Git | What it is |
|---|---|---|
| `README.md` | tracked | this file |
| `schema/*` | tracked | example shaped files that document the format |
| `ceo-context.md` | gitignored | owner facts the repo can't show: goals, hours, what's been tried. Filled by `/ceo setup` |
| `decisions.md` | gitignored | append only decision log; agents raise entries, Dillon decides |
| `ceo-memos/` | gitignored | weekly CEO memos |
| `staff/<role>/` | gitignored | dated reports per employee |

Because these files are gitignored they have no version history and no remote copy. Copy the
folder somewhere safe now and then (a zip in cloud storage is enough). Never put a key, token, or
user record in here.

Start with `/ceo setup`, then `/ceo review`.
