/*
 * Standalone MongoDB connectivity probe.
 *
 * Usage: run directly to validate MONGODB_URI/network reachability before
 * booting the full backend.
 */
const mongoose = require('mongoose');
require('dotenv').config();

console.log('Testing URI:', process.env.MONGODB_URI);

mongoose.set('strictQuery', false);
// Conservative timeouts avoid indefinite hangs during environment diagnosis.
mongoose.connect(process.env.MONGODB_URI, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 60000,  // 60 seconds
  socketTimeoutMS: 60000,
  family: 4  // IPv4 only
})
.then(() => {
  console.log('✅ Connection successful!');
  process.exit(0);
})
.catch(err => {
  console.error('❌ Full error:', err);
  process.exit(1);
});
