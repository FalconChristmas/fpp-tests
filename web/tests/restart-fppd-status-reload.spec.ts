import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Restart FPPD from the page (RestartFPPD in fpp.js) with the restart
// request answered here, so no fppd is restarted.  The page holds its own
// status polling while fppd is away and has to ask for the status again once
// the restart is over, whichever way the restart request came back.

async function restartAndWatch(page: Page, restartStatus: number) {
  await page.route('**/api/system/fppd/restart**', (r) => r.fulfill({ status: restartStatus, body: restartStatus === 200 ? '{"status":"OK"}' : 'fail' }));
  // The failed restart goes on to poll api/system/status for fppd to come
  // back; answer it as down so that poll doesn't stand in for the reload.
  await page.route(/\/api\/system\/status(?!\?systemonly)/, (r) => r.abort());
  await page.goto('/index.php');
  await page.waitForFunction(() => (window as any).fppdWSConnected === true, null, { timeout: 15_000 });
  // The page's slow poll is 30 s away; stop it so only the restart can ask.
  await page.evaluate(() => { clearTimeout((window as any).statusTimeout); (window as any).statusTimeout = null; });
  const asked: string[] = [];
  page.on('request', (r) => { if (/\/api\/system\/status\?systemonly=1/.test(r.url())) asked.push(r.url()); });
  await page.evaluate(() => (window as any).RestartFPPD());
  return asked;
}

test('after a restart that succeeds the page asks for the system status again', async ({ page }) => {
  // Regression: 52ff794d3.  The restart paused the status poll and nothing
  // started it again, so the status (and the restart flag) the page showed
  // stayed as it was before the restart until the next slow poll.
  const asked = await restartAndWatch(page, 200);
  await expect.poll(() => asked.length, { timeout: 5_000 }).toBeGreaterThan(0);
  // ... and the poll it restarted is the one that keeps going.
  expect(await page.evaluate(() => (window as any).statusTimeout)).not.toBeNull();
});

test('after a restart that fails the page asks for the system status again', async ({ page }) => {
  // Regression: 52ff794d3.  Same for the failed restart (fppd rebooting the
  // board is why the request can fail): the status was not asked for before
  // the page began waiting for fppd to come back.
  const asked = await restartAndWatch(page, 500);
  await expect.poll(() => asked.length, { timeout: 5_000 }).toBeGreaterThan(0);
});
