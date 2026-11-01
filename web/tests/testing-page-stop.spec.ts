import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// Unticking Enable on the Display Testing page's Channel Testing tab stops
// the test fppd is running.

const testmode = async (request: APIRequestContext) => (await (await request.get('/api/testmode')).json()) ?? {};

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

// Regression: 7de71d6b2.  SetTestMode() built a Test Start command from the
// page's pattern whether Enable was ticked or not, so unticking it started
// the test again instead of stopping it: the Test Stop that replaces the
// command when Enable is off was missing, and fppd kept lighting the range.
test('unticking Enable on Channel Testing stops the test fppd is running', async ({ page, request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  await expect.poll(async () => (await testmode(request)).enabled ?? 0).toBe(0);
  await page.goto('/testing.php');
  await expect(page.locator('#testModeEnabled')).toBeAttached({ timeout: 15_000 });
  await page.locator('#testModeStartChannel').fill('1');
  await page.locator('#testModeEndChannel').fill('150');
  await page.locator('#testModeEnabled').check();
  await expect.poll(async () => !!(await testmode(request)).enabled, { timeout: 10_000 }).toBe(true);

  await page.locator('#testModeEnabled').uncheck();
  await expect.poll(async () => !!(await testmode(request)).enabled, { timeout: 10_000, message: 'fppd is still testing' }).toBe(false);
});
