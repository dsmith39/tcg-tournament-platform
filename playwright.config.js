const { defineConfig, devices } = require('@playwright/test');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3200',
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: `${npmCommand} run start`,
    url: 'http://127.0.0.1:3200',
    timeout: 120_000,
    reuseExistingServer: true,
    env: {
      NODE_ENV: 'production',
      PORT: '3200',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/tcg-playwright-placeholder',
      JWT_SECRET: 'playwright-local-secret'
    }
  }
});
