/*
 * Switches a staged copy of cards.db out of WAL journal mode before it's
 * zipped into the Lambda package. WAL mode needs to create a `-shm` file
 * even for read-only connections, which fails on Lambda's read-only
 * filesystem (see card-database/src/db.js). Local dev always reopens the
 * source db in WAL mode on next run, so this only ever touches the staged
 * copy passed on argv, never the source file under card-database/data/.
 */
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node flatten_for_deploy.js <path-to-staged-cards.db>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = DELETE;');
db.close();
