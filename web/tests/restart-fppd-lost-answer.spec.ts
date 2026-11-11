import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Restart FPPD when the restart request itself gets no answer: fppd may be
// taking the whole player down with it (a sound card or Pi Pixel change makes
// it reboot), so the page polls /api/system/status until fppd is running
// again, and gives up after a number of tries.  Nothing is restarted here:
// the restart request and the status are answered by the test.

type Mode = 'down' | 'stopped' | 'running';

async function restartWithNoAnswer(page: Page, state: { mode: Mode }, tries?: number) {
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).RestartFPPD === 'function' && (window as any).settings);
  const restarts: string[] = [];
  await page.route('**/api/system/fppd/restart**', (route) => {
    restarts.push(`${route.request().method()} ${new URL(route.request().url()).search}`);
    return route.abort('connectionreset');
  });
  await page.route('**/api/system/status**', (route) => {
    if (state.mode === 'down') return route.abort('connectionrefused');
    if (state.mode === 'stopped') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ fppd: 'Not Running', status_name: 'stopped' }) });
    return route.continue();
  });
  await page.evaluate((n) => {
    const w = window as any;
    // Every notice raised, kept: they fade after a few seconds.
    w.fppTestsNotices = [];
    const raise = w.$.jGrowl;
    // (jGrowl keeps its defaults on the function itself.)
    w.$.jGrowl = Object.assign(function (this: unknown, message: string, ...rest: unknown[]) {
      w.fppTestsNotices.push(message);
      return raise.call(this, message, ...rest);
    }, raise);
    w.settings['restartFlag'] = 1;
    if (n) w.max_retries = n;
    w.RestartFPPD();
  }, tries);
  return restarts;
}

const notices = (page: Page, text: string) =>
  page.evaluate((t) => ((window as any).fppTestsNotices as string[]).filter((m) => m === t).length, text);

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/restartFlag', { data: '0', headers: { 'Content-Type': 'text/plain' } });
});

test('a restart that got no answer is reported once fppd is seen running again', async ({ page }) => {
  test.setTimeout(60_000);
  const state = { mode: 'down' as Mode };
  const restarts = await restartWithNoAnswer(page, state);
  // A full restart was flagged: no ?quick=1.
  await expect.poll(() => restarts).toEqual(['POST ']);

  // The player is not answering: said once, however many polls fail.
  await expect.poll(() => notices(page, 'FPP is rebooting..'), { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(4500);
  expect(await notices(page, 'FPP is rebooting..')).toBe(1);
  expect(await notices(page, 'FPPD Restarted')).toBe(0);

  // Answering, fppd not up yet: still waiting.
  state.mode = 'stopped';
  await page.waitForTimeout(4500);
  expect(await notices(page, 'FPPD Restarted')).toBe(0);
  await expect(page.locator('.modal.show')).toHaveCount(0);

  // fppd running: reported, once, and the restart flag is cleared.
  const cleared = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/api/settings/restartFlag'));
  state.mode = 'running';
  await expect.poll(() => notices(page, 'FPPD Restarted'), { timeout: 10_000 }).toBe(1);
  expect((await cleared).postData()).toBe('0');
  expect(Number(await page.evaluate(() => (window as any).settings['restartFlag']))).toBe(0);
  await page.waitForTimeout(4500);
  expect(await notices(page, 'FPPD Restarted')).toBe(1);
});

test('a restart after which fppd never comes back ends in an error, not a success', async ({ page }) => {
  test.setTimeout(60_000);
  const state = { mode: 'stopped' as Mode };
  await restartWithNoAnswer(page, state, 3);
  const dialog = page.locator('.modal.show');
  await expect(dialog).toContainText('Error restarting FPPD', { timeout: 20_000 });
  expect(await notices(page, 'FPPD Restarted')).toBe(0);
  // Given up: fppd turning up later is not announced as this restart's success.
  state.mode = 'running';
  await page.waitForTimeout(4500);
  expect(await notices(page, 'FPPD Restarted')).toBe(0);
  expect(Number(await page.evaluate(() => (window as any).settings['restartFlag']))).toBe(1);
});
