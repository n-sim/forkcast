import { defineConfig, devices } from '@playwright/test';

// Installed-app journeys drive the packaged desktop app (see tests/app-fixture.ts);
// `browser` journeys drive a real browser against the household server, which
// serves the built frontend. Build both first: `npm run test:prepare`.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // A broken environment fails every journey; stop early rather than retry all.
  maxFailures: process.env.CI ? 10 : 0,
  reporter: 'list',
  timeout: 60_000,
  // The Windows runners are slow under two workers; 5s is too tight for UI
  // state changes that follow a save or a synchronization.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  use: {
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /browser[\/]/,
      use: { viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'tablet',
      testIgnore: /browser[\/]/,
      use: { viewport: { width: 820, height: 1180 }, hasTouch: true },
    },
    {
      name: 'browser',
      testMatch: /browser[\/].*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
