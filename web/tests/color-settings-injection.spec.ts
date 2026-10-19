import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// A "color" setting's value went, unescaped, into the color box's style
// attribute and into a single-quoted JS string for the picker on the Settings
// page, and schedulePreview.php printed the table color pairs into style
// attributes.  Nothing limits what those settings hold, so a stored value with
// a quote in it broke out of both: into a new attribute, or into script that
// ran on the page.  Fixed in fpp a9d7e3f1b ("fix(ui): color settings reach
// style attributes and scripts as hex only").
//
// One value of each kind, in the two settings the schedule preview's first
// rows use (pair 1, A and B): the script one is a valid expression inside the
// JS string, and harmless junk in an attribute; the attribute one adds
// data-fpp-injected to whatever element it lands in.

const SCRIPT = "'+(window.__pwned=1)+'";
const ATTRIBUTE = "0' data-fpp-injected='1";
const PLAYLIST = 'fpp-tests-colors';

async function setSetting(request: APIRequestContext, name: string, value: string) {
  const r = await request.put(`/api/settings/${name}`, { data: value });
  expect(r.ok(), await r.text()).toBe(true);
}

async function getSetting(request: APIRequestContext, name: string): Promise<string> {
  return (await (await request.get(`/api/settings/${name}`)).json()).value ?? '';
}

async function assertNotInjected(page: Page) {
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  await expect(page.locator('[data-fpp-injected]')).toHaveCount(0);
}

test.describe('color settings holding a quote', () => {
  let saved: Record<string, string> = {};

  test.beforeEach(async ({ request }) => {
    saved = {
      tableColorPair1A: await getSetting(request, 'tableColorPair1A'),
      tableColorPair1B: await getSetting(request, 'tableColorPair1B'),
    };
    await setSetting(request, 'tableColorPair1A', SCRIPT);
    await setSetting(request, 'tableColorPair1B', ATTRIBUTE);
  });

  test.afterEach(async ({ request }) => {
    for (const [name, value] of Object.entries(saved)) {
      await request.put(`/api/settings/${name}`, { data: value });
    }
  });

  test('the Settings page puts neither into its markup or script', async ({ page }) => {
    await page.goto('/settings.php#settings-ui');
    // The UI tab is loaded on demand; both color boxes and their picker
    // scripts are in once these exist.
    await expect(page.locator('#tableColorPair1A_colorBox')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('#tableColorPair1B_colorBox')).toHaveCount(1);
    await assertNotInjected(page);
  });

  test('the schedule preview puts neither into its markup', async ({ page, request }) => {
    await request.delete(`/api/playlist/${PLAYLIST}`);
    const before = await (await request.get('/api/schedule')).json();
    const year = new Date().getFullYear();
    try {
      const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
        data: { name: PLAYLIST, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
      });
      expect(pl.ok()).toBe(true);
      // Every day, so the preview has rows whatever today is.
      const sch = await request.post('/api/schedule', {
        data: [{
          enabled: 1, day: 7, playlist: PLAYLIST, startTime: '20:00:00', endTime: '21:00:00',
          startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0,
        }],
      });
      expect(sch.ok()).toBe(true);
      await request.post('/api/schedule/reload');
      await expect.poll(async () =>
        (await (await request.get('/api/fppd/schedule')).json()).schedule.items.length,
      { timeout: 10_000 }).toBeGreaterThan(1);

      await page.goto('/schedulePreview.php');
      await expect(page.locator('table.schedulePreviewTable tbody tr').first()).toBeVisible();
      await assertNotInjected(page);
    } finally {
      await request.post('/api/schedule', { data: before });
      await request.post('/api/schedule/reload');
      await request.delete(`/api/playlist/${PLAYLIST}`);
    }
  });
});
