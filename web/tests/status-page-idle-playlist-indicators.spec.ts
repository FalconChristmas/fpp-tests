import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The status page's Global Pause and Randomised indicators while nothing
// plays (updateMainPageGlobalPauseIndicator in fpp.js): they describe the
// playlist picked in the list, which the user is about to start.

const PAUSED = 'fpp-tests-idle-paused';
const RANDOM = 'fpp-tests-idle-random';
const PLAIN = 'fpp-tests-idle-plain';

const playlist = (name: string, extra: Record<string, unknown>) => ({
  name, desc: '', repeat: 0, loopCount: 0, random: 0, leadIn: [], leadOut: [],
  mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 60 }, { type: 'pause', enabled: 1, playOnce: 0, duration: 60 }],
  ...extra,
});

const command = (request: APIRequestContext, cmd: string, args: string[]) =>
  request.post('/api/command', { data: { command: cmd, args } });
const status = async (request: APIRequestContext) => (await request.get('/api/fppd/status')).json();

let verbose = '';
test.beforeEach(async ({ request }) => {
  verbose = String((await (await request.get('/api/settings/verbosePlaylistItemDetails')).json())?.value ?? '');
  await request.put('/api/settings/verbosePlaylistItemDetails', { data: '1' });
  await command(request, 'Stop Now', []);
  for (const p of [playlist(PAUSED, { globalPauseBetweenSequencesMS: 500, random: 2 }), playlist(RANDOM, { random: 1 }), playlist(PLAIN, {})]) {
    expect((await request.post(`/api/playlist/${p.name}`, { data: p })).ok()).toBe(true);
  }
});
test.afterEach(async ({ request }) => {
  await command(request, 'Stop Now', []);
  await request.put('/api/settings/verbosePlaylistItemDetails', { data: verbose });
  for (const name of [PAUSED, RANDOM, PLAIN]) await request.delete(`/api/playlist/${name}`);
});

async function open(page: Page) {
  await page.goto('/index.php');
  await expect(page.locator('#playlistSelect option', { hasText: PLAIN })).toHaveCount(1, { timeout: 15_000 });
}

// Pick a playlist and read the two indicators once they have settled.
async function pick(page: Page, name: string) {
  const loaded = page.waitForResponse((r) => r.url().includes(`/api/playlist/${name}`));
  await page.locator('#playlistSelect').selectOption(name);
  await loaded;
  await page.waitForTimeout(1500);
  const text = async (box: string, value: string) =>
    (await page.locator(box).isVisible()) ? (await page.locator(value).innerText()).trim() : null;
  return { pause: await text('#globalPauseIndicator', '#globalPauseStatus'), random: await text('#randomizeIndicator', '#randomizeStatus') };
}

test('picking a playlist on an idle player shows that playlist\'s global pause and random mode', async ({ page }) => {
  await open(page);
  expect(await pick(page, PAUSED)).toEqual({ pause: 'Configured', random: 'Once per iteration' });
  expect(await pick(page, RANDOM)).toEqual({ pause: null, random: 'Once at load time' });
  expect(await pick(page, PLAIN)).toEqual({ pause: null, random: null });
});

test('the indicators stay hidden with Verbose Playlist Item Details off', async ({ page }) => {
  await open(page);
  await page.locator('#verbosePlaylistItemDetails').uncheck();
  expect(await pick(page, PAUSED)).toEqual({ pause: null, random: null });
});

test('a playlist that was stopped does not leave its global pause and random mode on the next one picked', async ({ page, request }) => {
  await command(request, 'Start Playlist', [PAUSED, 'false', 'false']);
  await expect.poll(async () => (await status(request)).global_pause?.configured).toBe(true);
  await command(request, 'Stop Now', []);
  await expect.poll(async () => (await status(request)).status_name).toBe('idle');
  // fppd's idle status still describes the playlist it last ran; the page
  // must go by the one picked.  (It does only because it asks
  // api/player/status, which has neither field, and falls back to the
  // playlist's file: FUTURE.md.)
  expect((await status(request)).global_pause?.configured).toBe(true);

  await open(page);
  expect(await pick(page, PLAIN)).toEqual({ pause: null, random: null });
  expect(await pick(page, RANDOM)).toEqual({ pause: null, random: 'Once at load time' });
});
