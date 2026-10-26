import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// What every page does as it loads, before and while its first status
// arrives: the header, the loading placeholders, the tooltips.

// Keep the page from getting any status of its own: no socket, no polls.
async function noStatus(page: Page) {
  await page.routeWebSocket('**/fppdws', () => {});
  await page.route('**/api/system/status**', (route) => route.abort());
  await page.route('**/api/fppd/status**', (route) => route.abort());
}

test("the header's FPP mode and player state are in the page as served", async ({ page, request }) => {
  // Feature: 9d2e87087.  The page carries the status PHP read from the local
  // API (lastStatusJSON) and the mode, so the header renders before, and
  // without, any status request of its own.
  const html = await (await request.get('/index.php')).text();
  expect(html.includes('<span id="fppModeDropdownButtonModeText">Player</span>'), 'the mode in the footer').toBe(true);
  expect(/lastStatusJSON = \{/.test(html), 'the status in the page').toBe(true);

  const asked: string[] = [];
  page.on('request', (r) => { if (/\/api\/(system|fppd)\/status/.test(r.url())) asked.push(r.url()); });
  await noStatus(page);
  await page.goto('/index.php');
  await expect(page.locator('#fppModeDropdownButtonModeText')).toHaveText('Player');
  await expect(page.locator('#header_player')).toContainText('Idle');
  // The control: every status request the page made went unanswered.
  expect(asked.length).toBeGreaterThan(0);
});

test('a page that loads quickly never paints the loading placeholders', async ({ page }) => {
  // Regression: efaca5e31.  body.is-loading drew the placeholders at once,
  // so a page whose status came back in tens of milliseconds flashed a grey
  // block where the player controls were about to appear.  They wait for
  // .show-loading-skeleton now, added only if the page is still loading
  // after a short delay.
  const watch = () => page.addInitScript(() => {
    (window as any).__fppTestsSkeleton = false;
    (window as any).__fppTestsSawLoading = false;
    (window as any).__fppTestsPlaceholderShown = false;
    new MutationObserver(() => {
      const body = document.body;
      if (!body) return;
      if (body.classList.contains('is-loading')) (window as any).__fppTestsSawLoading = true;
      if (body.classList.contains('show-loading-skeleton')) (window as any).__fppTestsSkeleton = true;
      const ph = document.querySelector('.statusPageLoading') as HTMLElement | null;
      if (ph && getComputedStyle(ph).display !== 'none') (window as any).__fppTestsPlaceholderShown = true;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  await watch();
  await page.goto('/index.php');
  await expect(page.locator('body')).not.toHaveClass(/is-loading/, { timeout: 15_000 });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).__fppTestsPlaceholderShown)).toBe(false);
  expect(await page.evaluate(() => (window as any).__fppTestsSkeleton)).toBe(false);

  // The control: the page did start out loading.
  expect(await page.evaluate(() => (window as any).__fppTestsSawLoading)).toBe(true);
});

test('an empty tooltip title does not stop the page setting up', async ({ page }) => {
  // Regression: 8a624f371.  Bootstrap throws on an empty data-bs-title, and
  // SetupToolTips() let it out: the rest of the page setup after it (status,
  // the socket, the other tooltips) never ran.  A plugin or page can carry
  // one, as gpio.php did; the test adds one at the top of the page.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const bad = document.createElement('span');
      bad.id = 'fppTestsEmptyTip';
      bad.setAttribute('data-bs-toggle', 'tooltip');
      bad.setAttribute('data-bs-title', '');
      bad.textContent = 'x';
      document.body.prepend(bad);
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/index.php');
  // The control: the empty one is there for the sweep to meet.
  await expect(page.locator('#fppTestsEmptyTip')).toHaveCount(1);
  // The status arrives, and the tooltips after it are set up.
  await expect(page.locator('#header_player')).toContainText('Idle', { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[data-bs-toggle="tooltip"]')]
    .filter((e) => (window as any).bootstrap.Tooltip.getInstance(e)).length)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
