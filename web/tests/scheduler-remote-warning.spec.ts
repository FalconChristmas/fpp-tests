import { test, expect } from './fixtures';

// On a Remote, an enabled playlist schedule entry cannot run (a Remote
// follows its master): the Scheduler marks such rows and shows a warning;
// disabled playlist entries and command entries are fine.

const PLAYLIST = 'fpp-tests-sched-remote';
let before: unknown;

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(pl.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings/fppMode', { data: 'player' });
  await request.post('/api/schedule', { data: before });
  await request.delete(`/api/playlist/${PLAYLIST}`);
});

const year = new Date().getFullYear();
const entry = (extra: object) => ({
  enabled: 1, day: 7, type: 'playlist', playlist: PLAYLIST, startTime: '19:00:00', endTime: '20:00:00',
  startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
});

test('only an enabled playlist entry is flagged on a Remote', async ({ page, request }) => {
  // Feature: 5e13bdaf1 "Few more UI enhancements for scheduling FPP Commands on
  // Remotes" (5e13bdaf1): a Remote can run commands but not playlists.
  expect((await request.post('/api/schedule', { data: [
    entry({}),                                                // enabled playlist
    entry({ enabled: 0 }),                                    // disabled playlist
    entry({ type: 'command', playlist: '', command: 'All Lights Off', args: [] }),  // command
  ] })).ok()).toBe(true);
  expect((await request.put('/api/settings/fppMode', { data: 'remote' })).ok()).toBe(true);
  await page.goto('/scheduler.php');
  const rows = page.locator('#tblScheduleBody > tr');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#remoteEntryTypeWarning')).toBeVisible();
  await expect(rows.nth(0)).toHaveClass(/inputWarning/);
  await expect(rows.nth(1)).not.toHaveClass(/inputWarning/);
  await expect(rows.nth(2)).not.toHaveClass(/inputWarning/);
});

test('a Player gets no such warning', async ({ page, request }) => {
  expect((await request.post('/api/schedule', { data: [entry({})] })).ok()).toBe(true);
  expect((await request.put('/api/settings/fppMode', { data: 'player' })).ok()).toBe(true);
  await page.goto('/scheduler.php');
  await expect(page.locator('#tblScheduleBody > tr')).toHaveCount(1);
  await expect(page.locator('#remoteEntryTypeWarning')).toBeHidden();
});
