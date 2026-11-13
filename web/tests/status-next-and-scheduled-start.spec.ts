import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// What the status page says about the schedule, against the player's own
// fppd: the next playlist with when it starts, "No playlist scheduled." when
// nothing is, and a schedule entry whose time has come is started by fppd's
// scheduler and shown playing.  The playlist is a pause: nothing is shown or
// heard.  The schedule is put back, then the playlist stopped.

const NAME = 'fpp-tests-next-up';
let before: unknown;

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  const r = await request.post(`/api/playlist/${NAME}`, { data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0,
    leadIn: [], mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 600 }], leadOut: [], playlistInfo: {} } });
  expect(r.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  // The schedule first, or the scheduler starts the playlist again.
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
  await request.post('/api/playlists/stop');
  await request.delete(`/api/playlist/${NAME}`);
});

// The player's wall clock, minutes from now: [YYYY-MM-DD, HH:MM:SS].
async function playerClock(request: APIRequestContext, minutes: number) {
  const zone = String((await (await request.get('/api/settings/TimeZone')).json()).value || 'UTC');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(Date.now() + minutes * 60_000)).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}:00`];
}

async function useSchedule(request: APIRequestContext, entries: object[]) {
  expect((await request.post('/api/schedule', { data: entries })).ok()).toBe(true);
  expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
}
const entry = (date: string, start: string, end: string, extra: object = {}) => ({
  enabled: 1, day: 7, type: 'playlist', playlist: NAME, command: '', args: [],
  startTime: start, endTime: end, startDate: date, endDate: date, repeat: 0, stopType: 0, ...extra,
});

test('the next playlist is named, with when it starts', async ({ page, request }) => {
  const [date, start] = await playerClock(request, 120);
  const [, end] = await playerClock(request, 130);
  test.skip(end < start, 'the entry would cross the player\'s midnight');
  await useSchedule(request, [entry(date, start, end)]);
  await page.goto('/index.php');
  const next = page.locator('#nextPlaylist');
  await expect(next).toContainText(`'${NAME}' on `, { timeout: 15_000 });
  // Its start, in 12- or 24-hour form as the player is set.
  const [h, m] = start.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  await expect(next).toContainText(new RegExp(`(${String(h).padStart(2, '0')}|\\b${h12}):${String(m).padStart(2, '0')}`));
});

test('with every entry disabled the page says no playlist is scheduled', async ({ page, request }) => {
  const [date, start] = await playerClock(request, 120);
  const [, end] = await playerClock(request, 130);
  test.skip(end < start, 'the entry would cross the player\'s midnight');
  await useSchedule(request, [entry(date, start, end, { enabled: 0 })]);
  await page.goto('/index.php');
  await expect(page.locator('#nextPlaylist')).toHaveText('No playlist scheduled.', { timeout: 15_000 });
});

test('an entry whose time has come is started by the scheduler and shown playing', async ({ page, request }) => {
  const [date, start] = await playerClock(request, -1);
  const [, end] = await playerClock(request, 30);
  test.skip(end < start, 'the entry would cross the player\'s midnight');
  await page.goto('/index.php');
  await expect(page.locator('#txtPlayerStatus')).toContainText(/idle/i, { timeout: 15_000 });
  await useSchedule(request, [entry(date, start, end)]);
  await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).current_playlist?.playlist,
    { timeout: 30_000 }).toBe(NAME);
  await expect(page.locator('#txtPlayerStatus')).toContainText(/playing/i, { timeout: 10_000 });
  await expect(page.locator('#playlistRow1')).toHaveClass(/PlaylistRowPlaying/, { timeout: 10_000 });
});
