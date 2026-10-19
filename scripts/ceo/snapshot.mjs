// snapshot.mjs - the CEO agent's view of The Duel Club (theduelclub.com).
//
// Reads git, GitHub (through gh, if it is installed and signed in), the test files, the card
// catalog and Duel Links skill data, and the agent state in ops/ (decisions, owner context, staff
// reports). Prints one markdown snapshot so the agent reasons from the same numbers every run.
//
// Read-only. Never writes anything. It cannot see production: users, tournaments, and AWS cost
// come from Dillon's admin panel and from /ops.
//
// Usage:
//   node scripts/ceo/snapshot.mjs            # markdown
//   node scripts/ceo/snapshot.mjs --json     # raw numbers
//   node scripts/ceo/snapshot.mjs --today 2026-10-19

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPS = join(ROOT, "ops");

// Edit these when the project changes.
const CONFIG = {
  defaultBranch: "main",
  roles: ["dev", "qa", "ops", "cards", "growth"],
  staleReportDays: 14,
  staleCommitDays: 14,
  staleCatalogDays: 60,
};

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const todayArg = args[args.indexOf("--today") + 1];
// Local date, not UTC: toISOString() rolls over to tomorrow in the evening in Denver.
const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = args.includes("--today") && todayArg ? todayArg : localDate(new Date());

const DAY = 86_400_000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const missing = [];

function run(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// ---- git -------------------------------------------------------------------------------------

const git = {
  branch: run("git", ["branch", "--show-current"]),
  uncommitted: (run("git", ["status", "--porcelain"]) || "").split("\n").filter(Boolean).length,
  recent: (run("git", ["log", "-5", "--date=short", "--pretty=%ad %s"]) || "").split("\n").filter(Boolean),
  commits7d: Number(run("git", ["rev-list", "--count", "--since=7.days", "HEAD"]) || 0),
  commits30d: Number(run("git", ["rev-list", "--count", "--since=30.days", "HEAD"]) || 0),
  lastCommitDate: run("git", ["log", "-1", "--date=short", "--pretty=%ad"]),
};
git.daysSinceCommit = git.lastCommitDate ? daysBetween(git.lastCommitDate, today) : null;

// ---- GitHub ----------------------------------------------------------------------------------

function gh(ghArgs) {
  const out = run("gh", ghArgs);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const prs = gh(["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,author,updatedAt,headRefName"]);
const runs = gh(["run", "list", "--limit", "8", "--json", "workflowName,conclusion,status,createdAt,headBranch"]);
const github = {
  available: prs !== null,
  openPrs: prs ? prs.length : null,
  dependabotPrs: prs ? prs.filter((p) => /dependabot/i.test(p.author?.login || "") || /^dependabot/.test(p.headRefName)).length : null,
  prs: prs ? prs.slice(0, 10).map((p) => ({ number: p.number, title: p.title, updated: p.updatedAt?.slice(0, 10) })) : [],
  runs: runs ? runs.map((r) => ({ workflow: r.workflowName, result: r.conclusion || r.status, branch: r.headBranch, date: r.createdAt?.slice(0, 10) })) : [],
};
if (!github.available) missing.push("GitHub data (gh not installed or not signed in)");

// ---- project: tests, catalog, skills, legacy -------------------------------------------------

function countMatches(path, re) {
  const text = readText(path);
  return text === null ? null : (text.match(re) || []).length;
}

function fileAge(path) {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  return { modified: localDate(st.mtime), ageDays: daysBetween(localDate(st.mtime), today), mb: Math.round((st.size / 1_048_576) * 10) / 10 };
}

function skillCount() {
  const text = readText(join(ROOT, "server", "reference-data", "duel-links-skills.json"));
  if (text === null) return null;
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data.length : Array.isArray(data.skills) ? data.skills.length : null;
  } catch {
    return null;
  }
}

const e2eDir = join(ROOT, "tests", "e2e");
const project = {
  apiTests: countMatches(join(ROOT, "tests", "api.integration.test.js"), /^\s*(?:it|test)\(/gm),
  e2eSpecs: existsSync(e2eDir) ? readdirSync(e2eDir).filter((f) => f.endsWith(".spec.js")).length : null,
  cardsDb: fileAge(join(ROOT, "card-database", "data", "cards.db")),
  // Tracked file: last commit date, not mtime (a fresh checkout resets mtime).
  skillsJson: (() => {
    const d = run("git", ["log", "-1", "--date=short", "--pretty=%ad", "--", "server/reference-data/duel-links-skills.json"]);
    return d ? { modified: d, ageDays: daysBetween(d, today) } : null;
  })(),
  skillCount: skillCount(),
  legacyDirs: ["tcg-backend", "tcg-frontend"].filter((d) => existsSync(join(ROOT, d))),
};

// ---- agent state in ops/ ---------------------------------------------------------------------

function openDecisions() {
  const text = readText(join(OPS, "decisions.md"));
  if (text === null) return [];
  const out = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const title = block.split("\n")[0].trim();
    if (/\*\*Status:\*\*\s*open/i.test(block)) out.push(title);
  }
  return out;
}

function teamReports() {
  return CONFIG.roles.map((role) => {
    const dir = join(OPS, "staff", role);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
    const latest = files.at(-1) || null;
    const date = latest?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;
    return { role, reports: files.length, latest, ageDays: date ? daysBetween(date, today) : null };
  });
}

if (!existsSync(join(OPS, "ceo-context.md"))) missing.push("ops/ceo-context.md (run /ceo setup)");

const thisWeek = isoWeek(today);
const decisions = openDecisions();
const team = teamReports();

const snapshot = { today, thisWeek, git, github, project, openDecisions: decisions, team, missing };

if (asJson) {
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

// ---- markdown --------------------------------------------------------------------------------

const out = [];
out.push(`# Duel Club snapshot, ${today} (${thisWeek})`, "");

out.push("## Code");
out.push(`- Branch ${git.branch ?? "unknown"}, ${git.uncommitted} uncommitted file(s), default branch ${CONFIG.defaultBranch} (a merge there deploys)`);
out.push(`- Commits: ${git.commits7d} in 7 days, ${git.commits30d} in 30 days${git.daysSinceCommit !== null ? `, last ${git.lastCommitDate} (${git.daysSinceCommit} days ago)` : ""}`);
if (git.daysSinceCommit !== null && git.daysSinceCommit > CONFIG.staleCommitDays) out.push(`- FLAG: no commit in over ${CONFIG.staleCommitDays} days`);
for (const c of git.recent) out.push(`  - ${c}`);
out.push("");

out.push("## GitHub");
if (github.available) {
  out.push(`- ${github.openPrs} open PR(s), ${github.dependabotPrs} from Dependabot`);
  for (const p of github.prs) out.push(`  - #${p.number} ${p.title} (updated ${p.updated})`);
  if (github.runs.length) out.push(`- Recent runs: ${github.runs.map((r) => `${r.workflow} ${r.result} ${r.date}`).join("; ")}`);
} else {
  out.push("- Unavailable (gh missing or signed out)");
}
out.push("");

out.push("## Product data and tests");
out.push(`- Tests: ${project.apiTests ?? "unknown"} API cases, ${project.e2eSpecs ?? "unknown"} E2E spec files (counted from source, not run)`);
if (project.cardsDb) {
  const stale = project.cardsDb.ageDays > CONFIG.staleCatalogDays ? " STALE" : "";
  out.push(`- Local card catalog: ${project.cardsDb.mb}MB, edited ${project.cardsDb.modified} (${project.cardsDb.ageDays} days ago)${stale}. Local copy only; the deployed one lives in S3`);
} else {
  out.push("- Local card catalog: not built on this machine (npm run cards:init-db && cards:import)");
}
if (project.skillsJson) {
  out.push(`- Duel Links skills: ${project.skillCount ?? "unknown"} entries, edited ${project.skillsJson.modified} (${project.skillsJson.ageDays} days ago)`);
}
if (project.legacyDirs.length) out.push(`- Legacy folders still present: ${project.legacyDirs.join(", ")}`);
out.push("- Users, tournaments, and AWS cost: not visible here. Ask Dillon (admin panel stats) and /ops.");
out.push("");

out.push("## Decisions");
out.push(decisions.length ? `- Open: ${decisions.join("; ")}` : "- No open decisions logged");
out.push("");

out.push("## Team (latest report in ops/staff/)");
for (const t of team) {
  const stale = t.ageDays !== null && t.ageDays > CONFIG.staleReportDays ? " STALE" : "";
  out.push(t.latest ? `- ${t.role}: ${t.latest} (${t.ageDays} days old, ${t.reports} total)${stale}` : `- ${t.role}: no reports yet`);
}

if (missing.length) {
  out.push("", "## Missing data");
  out.push(`- ${missing.join("; ")}`);
}

console.log(out.join("\n"));
