import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A page reloads itself when fppd comes back from a restart with a different
// command list (a plugin's commands added or removed), so its command
// pickers are not left offering the old list.  The web container's fppd
// cannot be restarted under the test, so the restart is played by the page's
// own status poll: fppd's WebSocket is refused (the page then polls
// api/system/status for everything), the poll answers "Not Running" for a
// while as PHP does when fppd is down, and api/commands answers after it as
// fppd would with a plugin's command loaded.  What is not checked: a real
// fppd restart, and a real plugin command in fppd's list.

async function restart(page: Page, changeCommands: boolean) {
  await page.routeWebSocket(/fppdws/, (ws) => ws.close());
  let down = false;
  let restarted = false;
  await page.route(/\/api\/system\/status(\?|$)/, async (route) => {
    const r = await route.fetch();
    const body = await r.json();
    if (down) {
      body.fppd = 'Not Running';
      body.status_name = 'stopped';
    }
    await route.fulfill({ response: r, json: body });
  });
  await page.route(/\/api\/commands(\?|$)/, async (route) => {
    const r = await route.fetch();
    const list = await r.json();
    if (restarted && changeCommands) {
      list.push({ name: 'fpp-tests plugin command', description: 'added by a plugin', args: [], category: 'Plugins' });
    }
    await route.fulfill({ response: r, json: list });
  });
  const commands = page.waitForResponse((r) => /\/api\/commands(\?|$)/.test(r.url()));
  const status = page.waitForResponse((r) => /\/api\/system\/status/.test(r.url()));
  await page.goto('/index.php');
  await commands;
  await status;
  await page.evaluate(() => { (window as any).fppTestsNoReload = true; });
  down = true;
  await page.waitForResponse((r) => /\/api\/system\/status/.test(r.url()));
  await page.waitForResponse((r) => /\/api\/system\/status/.test(r.url()));
  restarted = true;
  down = false;
}

test('a page reloads when fppd comes back with a different command list', async ({ page }) => {
  // Feature: 2592715d0.  The page notes the command list when it loads, and
  // on fppd going from not running to running fetches it again and reloads
  // if it changed.
  await restart(page, true);
  await expect.poll(() => page.evaluate(() => (window as any).fppTestsNoReload === true), { timeout: 15_000 }).toBe(false);
});

test('a page does not reload when fppd comes back with the same command list', async ({ page }) => {
  // Feature: 2592715d0, the other half: an unchanged list leaves the page be.
  await restart(page, false);
  await page.waitForResponse((r) => /\/api\/commands(\?|$)/.test(r.url()), { timeout: 15_000 });
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (window as any).fppTestsNoReload)).toBe(true);
});
