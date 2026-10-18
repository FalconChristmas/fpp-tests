import path from 'path';
import { defineConfig, devices } from '@playwright/test';

// run-web.sh serves the UI and points the suite at it; any other FPP works too
// (PLAYWRIGHT_BASE_URL=http://<player> npx playwright test), but the tests
// change its settings and add and remove playlists.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.FPP_TESTS_WEB_ARTIFACTS || path.join(__dirname, '..', 'artifacts', 'web');

// FPP_TESTS_THEMES=1 runs every test in both color schemes and writes a
// side-by-side screenshot report of them (playwright-report/sightline.html),
// for reviewing theme work. The nightly run uses the light scheme only.
const themes = process.env.FPP_TESTS_THEMES === '1';
const schemes = themes ? (['light', 'dark'] as const) : (['light'] as const);

export default defineConfig({
  testDir: './tests',
  // One fppd behind every test, and the tests change its settings.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: path.join(artifacts, 'test-results'),
  reporter: [
    ['list'],
    ['junit', { outputFile: path.join(artifacts, 'junit.xml') }],
    ['html', { open: 'never', outputFolder: path.join(artifacts, 'report') }],
    ...(themes ? [['./reporters/visual-comparison-reporter.js'] as [string]] : []),
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: themes ? { mode: 'on', fullPage: true } : 'only-on-failure',
  },
  projects: [
    // A fresh player sends every page to the setup wizard; this finishes it
    // the way a user does, once, before anything else runs.
    { name: 'setup', testMatch: /.*\.setup\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    ...schemes.map((scheme) => ({
      name: `chromium-${scheme}`,
      dependencies: ['setup'],
      // Full HD, which the tests were written at; the preset is 1280x720.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, colorScheme: scheme },
    })),
  ],
});
