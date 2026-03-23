#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

if (process.platform === 'win32') {
  run('powershell', [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, 'run-e2e-local.ps1'),
    ...(args.includes('--cleanup-only') ? ['-CleanupOnly'] : [])
  ]);
} else {
  run('bash', [
    path.join(__dirname, 'run-e2e-local.sh'),
    ...(args.includes('--cleanup-only') ? ['--cleanup-only'] : [])
  ]);
}
