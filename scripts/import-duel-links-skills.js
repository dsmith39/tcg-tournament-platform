/*
 * Refreshes the local Duel Links skill catalog from the DuelLinksMeta API.
 *
 * Duel Links skills are a mobile-game concept with no entry in the YGOPRODeck
 * catalog the rest of the app resolves cards against, so they get their own
 * mirror. Like `npm run cards:import`, this is meant to be run manually by the
 * operator when new skills ship -- the running app only ever reads the checked-in
 * JSON, never this API.
 *
 * Unlike the card catalog (a gitignored SQLite file the deploy script stages),
 * the skill list is small enough to check in as JSON, so it ships with the source
 * tree and CI deploys need no extra step.
 *
 *   npm run skills:import
 */
const fs = require('fs');
const path = require('path');

const API_URL = 'https://www.duellinksmeta.com/api/v1/skills?limit=5000';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'server', 'reference-data', 'duel-links-skills.json');

// A floor, not an expectation: the catalog only grows, so a response far below
// the size we already ship means a truncated or errored fetch, and overwriting
// the checked-in list with it would silently gut the skill picker.
const MIN_EXPECTED_SKILLS = 900;

async function fetchSkills() {
  const response = await fetch(API_URL, {
    headers: { accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch skills: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('Unexpected response shape: expected a JSON array of skills');
  }

  return payload;
}

function mapSkill(skill) {
  return {
    name: String(skill.name || '').trim(),
    description: String(skill.description || '').trim(),
    // Rush Duel runs its own skill pool. They're kept in the same file (a player
    // may well be registering a Rush deck) but flagged so the picker can label them.
    rush: !!skill.rush
  };
}

async function runImport() {
  console.log('Fetching Duel Links skills from DuelLinksMeta...');
  const raw = await fetchSkills();

  const seen = new Set();
  const skills = raw
    .map(mapSkill)
    .filter((skill) => {
      if (!skill.name) return false;
      const key = skill.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (skills.length < MIN_EXPECTED_SKILLS) {
    throw new Error(
      `Refusing to write only ${skills.length} skills (expected at least ${MIN_EXPECTED_SKILLS}) -- `
      + 'the upstream response looks truncated. Left the existing catalog in place.'
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(skills, null, 2)}\n`, 'utf8');

  const rushCount = skills.filter((skill) => skill.rush).length;
  console.log(`Wrote ${skills.length} skills (${skills.length - rushCount} Speed Duel, ${rushCount} Rush Duel) to ${OUTPUT_PATH}.`);
}

runImport().catch((error) => {
  console.error(error);
  process.exit(1);
});
