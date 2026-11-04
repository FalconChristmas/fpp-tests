import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Restart FPPD button the header shows when settings were changed.  A
// change that needs only a quick restart (restartFlag 2) must reach
// /api/system/fppd/restart as a query string, quick=1, and fppd then
// restarts in place: a full stop and start takes the container's fppd out
// from under it (see small-endpoints.spec.ts), a pid that stays is the
// quick one.

test.skip(!container, 'reads the stored settings inside the run-web.sh container');

const put = (page: Page, name: string, value: string) =>
  page.request.put(`/api/settings/${name}`, { data: value, headers: { 'Content-Type': 'text/plain' } });
const pid = () => inPlayer('sh', '-c', 'pidof fppd || true').trim();

test.afterEach(async ({ page }) => {
  await put(page, 'restartFlag', '0');
});

test('Restart FPPD for a change that needs a quick restart asks for ?quick=1 and fppd restarts in place', async ({ page }) => {
  // Regression: d796f1944.  The page appended "&quick=1" to a URL with no
  // query string yet ("api/system/fppd/restart&quick=1"), a path no route
  // matches, so the restart that was meant to be quick failed.
  // Also 88bb2b27b ("fppd start/stop/restart api move -- #944"), which
  // added the endpoint: red with its routes taken out.
  test.setTimeout(120_000);
  await put(page, 'restartFlag', '2');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/index.php');
  const before = pid();
  expect(before, 'no fppd running before the restart').toMatch(/^\d+$/);
  const button = page.locator('button[name="btnRestartFPPD"]:visible').first();
  await expect(button).toBeVisible();
  const sent = page.waitForRequest((r) => r.url().includes('/api/system/fppd/restart'));
  const answered = page.waitForResponse((r) => r.url().includes('/api/system/fppd/restart'));
  await button.click();
  const req = await sent;
  const url = new URL(req.url());
  expect(url.pathname).toMatch(/\/api\/system\/fppd\/restart$/);
  expect(url.searchParams.get('quick')).toBe('1');
  expect(req.method()).toBe('POST');
  // The receiving end: fppd took it as a quick restart.
  const res = await answered;
  expect(res.status(), await res.text()).toBe(200);
  await expect.poll(async () => {
    try { return (await (await page.request.get('/api/fppd/status', { timeout: 5_000 })).json()).mode_name ?? ''; } catch { return ''; }
  }, { timeout: 60_000, intervals: [1000] }).not.toBe('');
  expect(pid(), 'fppd was stopped and started again, not restarted in place').toBe(before);
});

test('Restart FPPD with no restart flag set also asks for ?quick=1', async ({ page }) => {
  // Regression: 97eb320a7.  Only a flag of 2 asked for a quick restart; the
  // restart the page offers with nothing flagged (a plugin's, the status
  // page's) did the full stop and start.
  test.setTimeout(120_000);
  await put(page, 'restartFlag', '0');
  await page.goto('/index.php');
  expect(Number(await page.evaluate(() => (window as any).settings['restartFlag']))).toBe(0);
  const before = pid();
  expect(before, 'no fppd running before the restart').toMatch(/^\d+$/);
  const sent = page.waitForRequest((r) => r.url().includes('/api/system/fppd/restart'));
  const answered = page.waitForResponse((r) => r.url().includes('/api/system/fppd/restart'));
  await page.evaluate(() => (window as any).RestartFPPD());
  const url = new URL((await sent).url());
  expect(url.searchParams.get('quick')).toBe('1');
  const res = await answered;
  expect(res.status(), await res.text()).toBe(200);
  await expect.poll(async () => {
    try { return (await (await page.request.get('/api/fppd/status', { timeout: 5_000 })).json()).mode_name ?? ''; } catch { return ''; }
  }, { timeout: 60_000, intervals: [1000] }).not.toBe('');
  expect(pid(), 'fppd was stopped and started again, not restarted in place').toBe(before);
});
