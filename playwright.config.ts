import { defineConfig, devices } from '@playwright/test';

// End-to-end tests (e2e/): the real built app -- Express server plus the
// Angular build -- driven in Chromium. Playwright starts the server itself
// (webServer below), so nothing has to be running beforehand; it only needs
// `npm run build` to have produced dist/.
//
//   npm run build && npm run test:e2e
//
// PLAYWRIGHT_CHROMIUM_PATH points at an already-installed Chromium instead of
// the one `npx playwright install chromium` downloads.
const PORT = Number(process.env.E2E_PORT || 3100);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1400, height: 900 },
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
      },
    },
  ],
  webServer: {
    command: 'node dist/server/server.js',
    url: `${baseURL}/api/version`,
    env: { PORT: String(PORT) },
    // Always a fresh server: its per-IP rate limiter (60 uploads / 15 min) would
    // otherwise carry over between local runs.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
