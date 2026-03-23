#!/usr/bin/env node
/*
 * Cross-platform wrapper for local E2E execution.
 *
 * This script chooses the OS-native cleanup/test runner:
 * - PowerShell script on Windows
 * - Bash script on macOS/Linux
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function run(command, commandArgs) {
  // Inherit stdio so developers can see real-time Playwright output.
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
  // Windows path: bypass script execution-policy friction for local runs.
  run('powershell', [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, 'run-e2e-local.ps1'),
    ...(args.includes('--cleanup-only') ? ['-CleanupOnly'] : [])
  ]);
} else {
  // Unix path: shell script handles cleanup + e2e invocation.
  run('bash', [
    path.join(__dirname, 'run-e2e-local.sh'),
    ...(args.includes('--cleanup-only') ? ['--cleanup-only'] : [])
  ]);
}
