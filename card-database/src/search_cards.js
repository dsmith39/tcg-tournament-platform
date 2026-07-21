const cardsRepo = require('./models/cards');

function parseArgs(argv) {
  const args = { name: '', limit: 20 };
  const nameParts = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--limit') {
      const next = argv[index + 1];
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error('--limit must be a positive number');
      }

      args.limit = Math.floor(parsed);
      index += 1;
      continue;
    }

    nameParts.push(token);
  }

  args.name = nameParts.join(' ').trim();
  if (!args.name) {
    throw new Error('Card name is required. Example: npm run cards:search -- "Blue-Eyes"');
  }

  return args;
}

function main() {
  try {
    const { name, limit } = parseArgs(process.argv.slice(2));
    const rows = cardsRepo.searchByName(name, limit);

    if (rows.length === 0) {
      console.log('No cards found.');
      return;
    }

    for (const row of rows) {
      console.log(
        `[${row.cardId}] ${row.name} | ${row.type} | ${row.race} | ${row.attribute || 'N/A'} | `
        + `ATK ${row.atk ?? 'N/A'} / DEF ${row.def ?? 'N/A'} | `
        + `Level ${row.level ?? 'N/A'} | Archetype: ${row.archetype || 'None'}`
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();
