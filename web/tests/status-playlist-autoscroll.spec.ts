import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The playing playlist on the status page (index.php): its entries are listed
// in a box of their own, which Auto Scroll Playlist Item scrolls to the one
// fppd is playing.

const NAME = 'fpp-tests-autoscroll';
const ENTRIES = 40;

const command = (request: APIRequestContext, cmd: string, args: string[]) =>
  request.post('/api/command', { data: { command: cmd, args } });
const status = async (request: APIRequestContext) => (await (await request.get('/api/fppd/status')).json());

let autoScroll: unknown;
test.beforeEach(async ({ request }) => {
  autoScroll = (await (await request.get('/api/settings/playlistAutoScroll')).json())?.value ?? '0';
  const saved = await request.post(`/api/playlist/${NAME}`, { data: {
    name: NAME, desc: 'fpp-tests autoscroll', repeat: 0, loopCount: 0, leadIn: [], leadOut: [],
    mainPlaylist: Array.from({ length: ENTRIES }, () => ({ type: 'pause', enabled: 1, playOnce: 0, duration: 300 })),
  } });
  expect(saved.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await command(request, 'Stop Now', []);
  await request.put('/api/settings/playlistAutoScroll', { data: String(autoScroll) });
  await request.delete(`/api/playlist/${NAME}`);
});

// Start the playlist at entry `item` (1-based) and open the status page.
async function playFrom(page: Page, request: APIRequestContext, item: number) {
  await command(request, 'Start Playlist At Item', [NAME, String(item), 'false', 'false']);
  await expect.poll(async () => (await status(request)).current_playlist?.index, { timeout: 10_000 }).toBe(String(item));
  await page.goto('/index.php');
  const row = page.locator(`#playlistRow${item}`);
  await expect(row).toHaveClass(/PlaylistRowPlaying/, { timeout: 15_000 });
  return row;
}

// Whether entry `item`'s row is wholly inside the visible part of the playlist box.
const inBox = (page: Page, item: number) => page.evaluate((i) => {
  const box = document.getElementById('playlistOuterScroll')!.getBoundingClientRect();
  const row = document.getElementById(`playlistRow${i}`)!.getBoundingClientRect();
  return row.top >= box.top && row.bottom <= box.bottom;
}, item);

test('with Auto Scroll on, the playing entry is scrolled into view inside the playlist box', async ({ page, request }) => {
  // Regression: 4c3dea36d (#1559).  Auto scroll scrolled the whole page to
  // the playing entry, every time it changed; the playlist is now in a box
  // of its own, and only that scrolls.
  await request.put('/api/settings/playlistAutoScroll', { data: '1' });
  await playFrom(page, request, 30);
  await expect.poll(() => inBox(page, 30), { timeout: 10_000 }).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('with Auto Scroll off, the playlist box stays where it is', async ({ page, request }) => {
  // Regression: c125b3a42 (#1554).  The page always scrolled to the playing
  // entry, so the playlist could not be read while it played; Auto Scroll
  // Playlist Item (off by default) turns that on.
  await request.put('/api/settings/playlistAutoScroll', { data: '0' });
  await playFrom(page, request, 30);
  await page.waitForTimeout(2000);
  expect(await page.locator('#playlistOuterScroll').evaluate((e) => e.scrollTop)).toBe(0);
  expect(await inBox(page, 30)).toBe(false);
});

test('Next moves fppd on and does not leave the button pressed', async ({ page, request }) => {
  // Regression: 2ea321e2b.  Previous and Next kept the focus after a click,
  // so the button stayed drawn in its pressed state.
  await request.put('/api/settings/playlistAutoScroll', { data: '0' });
  await playFrom(page, request, 2);
  for (const [button, index] of [['#btnNext', '3'], ['#btnPrev', '2']]) {
    await page.locator(button).click();
    await expect.poll(async () => (await status(request)).current_playlist?.index, { timeout: 10_000 }).toBe(index);
    expect(await page.evaluate(() => document.activeElement?.id ?? ''), `${button} after its click`).not.toBe(button.slice(1));
  }
});
