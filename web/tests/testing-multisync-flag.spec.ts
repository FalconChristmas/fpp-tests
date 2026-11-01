import { test, expect } from './fixtures';

// Display Testing's Multisync box: ticked, the Test Start and Test Stop the
// page sends carry multisyncCommand true, so the remotes are tested too.

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

test('with Multisync ticked, the Test Start and Test Stop the page sends are multisync commands', async ({ page }) => {
  // Regression: 2cf4d6a6e.  The page asked jQuery whether the box was
  // is('checked'), a tag name, which no element has: the answer was always
  // false and the remotes were never tested.
  const sent: any[] = [];
  await page.route('**/api/command', (route) => {
    if (route.request().method() === 'POST') sent.push(JSON.parse(route.request().postData() ?? '{}'));
    return route.continue();
  });
  await page.goto('/testing.php');
  await expect(page.locator('#testModeEnabled')).toBeAttached({ timeout: 15_000 });
  await page.locator('#testModeStartChannel').fill('1');
  await page.locator('#testModeEndChannel').fill('150');
  await page.locator('#multisyncEnabled').check();
  await page.locator('#testModeEnabled').check();
  await expect.poll(() => sent.filter((c) => c.command === 'Test Start').length, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.locator('#testModeEnabled').uncheck();
  await expect.poll(() => sent.filter((c) => c.command === 'Test Stop').length, { timeout: 10_000 }).toBeGreaterThan(0);
  for (const c of sent.filter((c) => /^Test (Start|Stop)$/.test(c.command))) {
    expect(c.multisyncCommand, `${c.command} not sent to the remotes`).toBe(true);
  }
});
