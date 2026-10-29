import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The status page redraws from every status fppd pushes (about once a
// second).  Parts that haven't changed must be left alone: rewriting them
// with the same content costs a layout each time and drops whatever the user
// had selected or hovered there.  Each check counts the DOM mutations of an
// element over several pushes, with nothing changing.

test.describe.configure({ timeout: 60_000 });

// Count the mutations of each selector's element from now on.
async function watch(page: Page, selectors: string[]) {
  await page.evaluate((sels) => {
    const w = window as any;
    w.__fppTestsMutations = {};
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no ${sel}`);
      w.__fppTestsMutations[sel] = 0;
      new MutationObserver((records) => {
        w.__fppTestsMutations[sel] += records.length;
      }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
    }
    // Each status update replaces lastStatusJSON with a new object.
    w.__fppTestsUpdates = 0;
    let last = w.lastStatusJSON;
    setInterval(() => {
      if (w.lastStatusJSON !== last) {
        last = w.lastStatusJSON;
        w.__fppTestsUpdates++;
      }
    }, 50);
  }, selectors);
}

const mutations = (page: Page) => page.evaluate(() => (window as any).__fppTestsMutations as Record<string, number>);

// How many status updates have reached the page since watch().
const updates = (page: Page) => page.evaluate(() => (window as any).__fppTestsUpdates as number);

test("the status page's mode title and the Top button are not rewritten while nothing changes", async ({ page }) => {
  // Regression: b9476f24c.  SetupUIForMode set the "Status - Player Mode"
  // title's innerHTML, and setTopScrollText the Top button's, on every
  // status update, the same text each time.
  await page.goto('/index.php');
  await expect(page.locator('h1.title.statusTitle')).toHaveText('Status - Player Mode', { timeout: 15_000 });
  await page.waitForTimeout(2000);
  await watch(page, ['h1.title.statusTitle', '#scrollTopButton']);
  await page.waitForTimeout(5000);
  // The control: status updates kept arriving while it was watched.
  expect(await updates(page)).toBeGreaterThanOrEqual(3);
  expect(await mutations(page)).toEqual({ 'h1.title.statusTitle': 0, '#scrollTopButton': 0 });
});

test('the Wi-Fi strength icon in the header is named', async ({ page }) => {
  // Regression: b9476f24c.  The icon had no title, so neither a hover nor
  // a screen reader said what it showed.
  await page.routeWebSocket('**/fppdws', () => {});
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.interfaces = [{
      ifname: 'wlan0', flags: ['BROADCAST', 'UP'], operstate: 'UP',
      addr_info: [{ family: 'inet', local: '10.1.0.5', prefixlen: 24 }], wifi: { level: 70, unit: '%', desc: 'good' },
    }];
    return route.fulfill({ response, json });
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/index.php');
  await expect(page.locator('#header_IPs img')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#header_IPs img')).toHaveAccessibleName('WiFi Strength');
});

test("the volume display is not repainted while the volume doesn't change", async ({ page }) => {
  // Regression: 57836c012.  updateVolumeUI rewrote the volume number, both
  // sliders and the speaker icon on every status update.
  // Regression: fpp 9d1035fe3.  57836c012's check compared $('#volume').html(),
  // a string, with !== to the number its callers pass (parseInt), so the two
  // never matched and every update still repainted.
  await page.goto('/index.php');
  await expect(page.locator('#volume')).toHaveText(/^\d+$/, { timeout: 15_000 });
  await page.waitForTimeout(2000);
  await watch(page, ['#volume']);
  await page.waitForTimeout(5000);
  // The control: status updates kept arriving while it was watched.
  expect(await updates(page)).toBeGreaterThanOrEqual(3);
  expect(await mutations(page)).toEqual({ '#volume': 0 });
});
