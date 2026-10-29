import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// "Protect UI-started playlists from the schedule" (UIStartedPlaylistsProtected):
// a playlist started with the status page's Play button is started
// "Protected from Schedule Override", so a schedule entry whose window opens
// under it is held back, and the status page says which entry was blocked.
// The receiving end is the real fppd: its scheduler holds the entry back and
// reports it in status (scheduler.blockedSchedule), which the page shows.
//
// Added in fpp 48b8cc08d (the page passes the setting to Start Playlist At
// Item; fppd's scheduler half is covered by
// scenarios/test_schedule_manual_priority.py).

test.skip(!container, 'reads the player clock to open a schedule window under the playlist');

const MINE = 'fpp-tests-protect-mine';
const SHOW = 'fpp-tests-protect-show';

const pauseList = (name: string) => ({
  name, version: 4, repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
  mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 300 }],
});

async function status(request: APIRequestContext) {
  return (await request.get('/api/fppd/status')).json();
}

test('a playlist started from the status page holds a schedule entry back and says so', async ({ page, request }) => {
  test.setTimeout(120_000);
  // The player's own local clock: the schedule is in its time zone.
  const [date, hms] = inPlayer('date', '+%Y-%m-%d %H:%M:%S').trim().split(' ');
  const [h, m, s] = hms.split(':').map(Number);
  const now = h * 3600 + m * 60 + s;
  test.skip(now > 86400 - 900, 'too close to midnight for a same-day window');
  const clock = (t: number) =>
    [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((v) => String(v).padStart(2, '0')).join(':');
  const opens = now + 30;

  const before = await (await request.get('/api/schedule')).json();
  const protectedBefore = String((await (await request.get('/api/settings/UIStartedPlaylistsProtected')).json())?.value ?? '0');
  try {
    expect((await request.post(`/api/playlist/${MINE}`, { data: pauseList(MINE) })).ok()).toBe(true);
    expect((await request.post(`/api/playlist/${SHOW}`, { data: pauseList(SHOW) })).ok()).toBe(true);
    await request.put('/api/settings/UIStartedPlaylistsProtected', { data: '1' });
    expect((await request.post('/api/schedule', {
      data: [{ enabled: 1, day: 7, playlist: SHOW, startTime: clock(opens), endTime: clock(opens + 600),
        startDate: date, endDate: date, repeat: 0, stopType: 1 }],
    })).ok()).toBe(true);
    await request.post('/api/schedule/reload');

    await page.goto('/index.php');
    await page.locator('#playlistSelect').selectOption(MINE);
    await page.locator('#btnPlay').click();
    await expect.poll(async () => (await status(request)).current_playlist?.playlist, { timeout: 10_000 }).toBe(MINE);

    // The window opens; fppd holds the entry back and reports it.
    await expect.poll(async () => (await status(request)).scheduler?.blockedSchedule?.playlistName,
      { timeout: 60_000, intervals: [1000] }).toBe(SHOW);
    expect((await status(request)).current_playlist?.playlist).toBe(MINE);
    await expect(page.locator('#warningsRow')).toContainText(
      `Scheduled playlist '${SHOW}' was blocked from starting due to schedule protection`, { timeout: 15_000 });
  } finally {
    await request.post('/api/command', { data: { command: 'Stop Now', args: [] } });
    await request.put('/api/settings/UIStartedPlaylistsProtected', { data: protectedBefore });
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
    await request.delete(`/api/playlist/${MINE}`);
    await request.delete(`/api/playlist/${SHOW}`);
  }
});
