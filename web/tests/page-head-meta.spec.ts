import { test, expect } from './fixtures';
import { answerUpdateCheck } from './standin-http';

// Feature: 73bfb4ae2 ("break html meta tags to a common include file").  The
// viewport and charset tags moved out of menuHead.inc into
// common/htmlMeta.inc, which every page's <head> includes first: a page
// without a viewport tag is drawn at desktop width on a phone, zoomed out.
// The same commit put the settings' help icons back on the page's own
// origin; 09707ac47 had pointed them (and the header logos) at
// http://localhost/, which only resolves on the player itself.

const PAGES = [
  'index.php', 'about.php', 'settings.php', 'playlists.php', 'scheduler.php',
  'filemanager.php', 'cronjobs.php', 'help.php', 'networkconfig.php', 'plugins.php',
  'credits.php', 'effects.php', 'changelog.php', 'commandPresets.php', 'channeloutputs.php',
];

test('every page carries the shared viewport and charset tags once', async ({ page }) => {
  test.setTimeout(120_000);
  await answerUpdateCheck(page);
  const missing: string[] = [];
  for (const p of PAGES) {
    const r = await page.goto(`/${p}`, { waitUntil: 'domcontentloaded' });
    expect(r?.status(), p).toBe(200);
    const viewport = await page.locator('head meta[name="viewport"]').evaluateAll((ms) => ms.map((m) => m.getAttribute('content') ?? ''));
    const charset = await page.locator('head meta[charset]').count();
    if (viewport.length !== 1 || !/width=device-width/.test(viewport[0]) || charset !== 1) {
      missing.push(`${p}: viewport ${JSON.stringify(viewport)}, charset tags ${charset}`);
    }
  }
  expect(missing).toEqual([]);
});

test("the settings' help icons and the header logos load from the page's own origin", async ({ page, baseURL }) => {
  await answerUpdateCheck(page);
  const elsewhere: string[] = [];
  page.on('request', (r) => { if (r.resourceType() === 'image' && !r.url().startsWith(baseURL!)) elsewhere.push(r.url()); });
  await page.goto('/settings.php?tab=UI');
  const icons = page.locator('img.icon-help');
  await expect(icons.first()).toBeAttached({ timeout: 15_000 });
  const srcs = await icons.evaluateAll((is) => is.map((i) => (i as HTMLImageElement).src));
  expect(srcs.length).toBeGreaterThan(0);
  expect(srcs.filter((s) => !s.startsWith(baseURL!)), 'help icons from another host').toEqual([]);
  // The receiving end: the browser fetched them, from here.
  await expect.poll(() => icons.first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const logos = await page.locator('.headerLeft img').evaluateAll((is) => is.map((i) => (i as HTMLImageElement).src));
  expect(logos.length).toBeGreaterThan(0);
  expect(logos.filter((s) => !s.startsWith(baseURL!)), 'header logos from another host').toEqual([]);
  expect(elsewhere).toEqual([]);
});
