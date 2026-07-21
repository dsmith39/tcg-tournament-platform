/*
 * Generates 24-char hex ids shaped like Mongo ObjectIds so the existing
 * `objectIdSchema` regex in server/validation.js (and any frontend code
 * that assumed that shape) keeps working unmodified after the SQLite move.
 */
const crypto = require('crypto');

const generateId = () => crypto.randomBytes(12).toString('hex');

module.exports = { generateId };
