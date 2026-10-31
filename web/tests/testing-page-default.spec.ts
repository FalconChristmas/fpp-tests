import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The pattern the Display Testing page (testing.php) starts with when no test
// is running, and the test fppd then runs (/api/testmode) when it is enabled.

const testmode = async (request: APIRequestContext) => (await (await request.get('/api/testmode')).json()) ?? {};

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

test('with no test running the page starts on the R-G-B cycle, and fppd runs that', async ({ page, request }) => {
  // Regression: a6e288cec.  The default was the R-G-B chase, which lights
  // one channel in three; the R-G-B cycle lights every pixel in each colour
  // in turn, which shows a whole string's colour order at a glance.
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  await expect.poll(async () => (await testmode(request)).enabled ?? 0).toBe(0);
  await page.goto('/testing.php');
  await expect(page.locator('#testModeEnabled')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('input[name="testModeMode"]:checked')).toHaveAttribute('id', 'RGBCycle-RGB');
  await page.locator('#testModeEnabled').check();
  await expect.poll(async () => {
    const t = await testmode(request);
    return t.enabled ? t.subMode : 'off';
  }, { timeout: 10_000 }).toBe('RGBCycle-RGB');
});
