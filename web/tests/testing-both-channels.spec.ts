import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The Display Testing page's Channel Testing tab: the Both +/- buttons move
// the start and end channel together.

const testmode = async (request: APIRequestContext) => (await (await request.get('/api/testmode')).json()) ?? {};

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

// Regression: 943d3d485.  Both called the start and the end adjusters one
// after the other, and each one sent a Test Start to fppd for the range as
// it stood, so the half-moved range (new end, old start) went to the pixels
// before the final one; with the buttons held down that is a flash of the
// wrong range on every click.  Only the final range is sent now.
for (const [button, from, to, sets] of [
  ['incBothButton', [100, 200], '103-203', ['103-203']],
  ['decBothButton', [100, 200], '97-197', ['97-197']],
] as const) {
  test(`${button} sends one Test Start with the moved range`, async ({ page, request }) => {
    await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
    await page.goto('/testing.php');
    await expect(page.locator('#testModeEnabled')).toBeAttached({ timeout: 15_000 });
    await page.locator('#testModeStartChannel').fill(String(from[0]));
    await page.locator('#testModeEndChannel').fill(String(from[1]));
    await page.locator('#testModeEnabled').check();
    await expect.poll(async () => !!(await testmode(request)).enabled, { timeout: 10_000 }).toBe(true);

    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.method() != 'POST' || !r.url().endsWith('/api/command')) return;
      const d = JSON.parse(r.postData() || '{}');
      if (d.command == 'Test Start') sent.push(d.args.find((a: string) => /^\d+-\d+$/.test(a)));
    });
    await page.locator(`#${button}`).click();
    await expect.poll(() => sent.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    expect(sent).toEqual(sets);
    await expect.poll(async () => (await testmode(request)).channelSet, { timeout: 10_000 }).toBe(to);
  });
}
