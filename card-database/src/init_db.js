const { getDb } = require('./db');

function main() {
  getDb();
  console.log('Card database schema initialized at card-database/data/cards.db');
}

main();
