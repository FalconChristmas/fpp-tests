import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// A schedule saved and reloaded is the one fppd acts on next, even when the
// next thing is a stop that lands before fppd's once-a-second pass.
//
// Regression: fpp 9f6872f27.  POST /api/schedule/reload only marked the
// schedule for loading on that pass, and the check fppd makes when a playlist
// stops (CheckIfShouldBePlayingNow) used the items it already had.  Here the
// entry is held back by a protected, UI-started playlist; the entry is
// removed, the schedule reloaded and the playlist stopped at once -- and fppd
// started the removed entry, which then played to the end of its window.

test.skip(!container, 'reads the player clock to open a schedule window under the playlist');

const MINE = 'fpp-tests-reload-mine';
const SHOW = 'fpp-tests-reload-show';

const pauseList = (name: string) => ({
  name, version: 4, repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
  mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 300 }],
});

async function status(request: APIRequestContext) {
  return (await request.get('/api/fppd/status')).json();
}

const scheduleEntries = async (request: APIRequestContext) =>
  ((await (await request.get('/api/fppd/schedule')).json()).schedule.entries as { playlist: string }[]).map((e) => e.playlist);

test('a schedule reloaded just before Stop Now is the one fppd uses', async ({ page, request }) => {
  test.setTimeout(120_000);
  const [date, hms] = inPlayer('date', '+%Y-%m-%d %H:%M:%S').trim().split(' ');
  const [h, m, s] = hms.split(':').map(Number);
  const now = h * 3600 + m * 60 + s;
  test.skip(now > 86400 - 900, 'too close to midnight for a same-day window');
  const clock = (t: number) =>
    [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((v) => String(v).padStart(2, '0')).join(':');
  const opens = now + 20;

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
    // The control: the window is open and fppd is holding the entry back.
    await expect.poll(async () => (await status(request)).scheduler?.blockedSchedule?.playlistName,
      { timeout: 60_000, intervals: [1000] }).toBe(SHOW);

    // The entry removed, the schedule reloaded and the playlist stopped, back
    // to back from the player itself: milliseconds apart, well inside the
    // second before fppd's next pass.
    expect((await request.post('/api/schedule', { data: before })).ok()).toBe(true);
    inPlayer('sh', '-c', 'curl -s -o /dev/null -X POST http://localhost/api/schedule/reload && ' +
      'curl -s -o /dev/null -X POST -H "Content-Type: application/json" -d \'{"command":"Stop Now","args":[]}\' http://localhost/api/command');

    await expect.poll(async () => (await status(request)).current_playlist?.playlist ?? '',
      { message: 'what fppd is playing after the stop', timeout: 10_000 }).toBe('');
    expect((await status(request)).status_name).toBe('idle');
    // It stays idle: the removed entry is not started in the playlist's place.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await status(request);
      expect(st.current_playlist?.playlist ?? '', 'fppd started the removed entry').toBe('');
    }
    const items = (await (await request.get('/api/fppd/schedule')).json()).schedule.items as { args: string[] }[];
    expect(items.map((i) => i.args?.[0]), 'fppd still lists the removed entry').not.toContain(SHOW);
    expect(await scheduleEntries(request)).not.toContain(SHOW);
  } finally {
    // On a tree without the fix the removed entry is playing: wait for the
    // reload to land, then stop it.
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
    await expect.poll(() => scheduleEntries(request), { timeout: 10_000 }).not.toContain(SHOW);
    await request.post('/api/command', { data: { command: 'Stop Now', args: [] } });
    await expect.poll(async () => (await status(request)).status_name, { timeout: 10_000 }).toBe('idle');
    await request.put('/api/settings/UIStartedPlaylistsProtected', { data: protectedBefore });
    await request.delete(`/api/playlist/${MINE}`);
    await request.delete(`/api/playlist/${SHOW}`);
  }
});
