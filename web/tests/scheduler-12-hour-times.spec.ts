import { test, expect } from './fixtures';

// Regression: 9ae1a1e2b ("Fix problems with times between midnight-1am and
// noon-1pm").  The Scheduler page shows times as "08:30 PM" and
// Convert24HFromUIFormat() turns what is typed into the "HH:MM:SS" that fppd
// takes.  It added 12 hours for every PM, so 12:30 PM became 24:30:00, and
// left 12 alone for AM, so 12:30 AM (just after midnight) became 12:30:00:
// a show set to start after midnight started at noon.

const PLAYLIST = 'fpp-tests-sched-12-hour';

const CASES: Array<[string, string]> = [
  ['12:30 AM', '00:30:00'],
  ['12:05 am', '00:05:00'],
  ['12:30 PM', '12:30:00'],
  ['12:45 pm', '12:45:00'],
  ['01:15 AM', '01:15:00'],
  ['01:15 PM', '13:15:00'],
  ['11:59 PM', '23:59:00'],
];

let timeFormat: unknown;
test.beforeEach(async ({ request }) => {
  timeFormat = (await (await request.get('/api/settings/TimeFormat')).json())?.value;
  await request.put('/api/settings/TimeFormat', { data: '%I:%M %p' });
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings/TimeFormat', { data: String(timeFormat ?? '%I:%M %p') });
});

test('12-hour times around noon and midnight convert to the 24-hour time fppd takes', async ({ page }) => {
  await page.goto('/scheduler.php');
  await expect(page.locator('#tblScheduleBody')).toBeAttached();
  const got = await page.evaluate((cases) => cases.map(([ui]) => (window as any).Convert24HFromUIFormat(ui)), CASES);
  expect(got).toEqual(CASES.map(([, want]) => want));
});

test('an entry typed as 12:30 AM to 12:30 PM is saved as 00:30:00 to 12:30:00', async ({ page, request }) => {
  // The receiving end: what Save posts to /api/schedule, which fppd reads.
  const before = await (await request.get('/api/schedule')).json();
  const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(pl.ok()).toBe(true);
  try {
    expect((await request.post('/api/schedule', { data: [{
      enabled: 1, day: 7, type: 'playlist', playlist: PLAYLIST, startTime: '00:30:00', endTime: '12:30:00',
      startDate: '2026-01-01', endDate: '2027-12-31', repeat: 0, stopType: 0,
    }] })).ok()).toBe(true);
    await page.goto('/scheduler.php');
    const row = page.locator('#tblScheduleBody > tr').first();
    await expect(row.locator('.schStartTime')).toHaveValue('12:30 AM', { timeout: 15_000 });
    await expect(row.locator('.schEndTime')).toHaveValue('12:30 PM');
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
    await page.evaluate(() => (window as any).SaveSchedule());
    const resp = await posted;
    expect(resp.ok()).toBe(true);
    const sent = resp.request().postDataJSON();
    expect(sent[0]).toMatchObject({ startTime: '00:30:00', endTime: '12:30:00' });
    expect((await (await request.get('/api/schedule')).json())[0]).toMatchObject({ startTime: '00:30:00', endTime: '12:30:00' });
  } finally {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
    await request.delete(`/api/playlist/${PLAYLIST}`);
  }
});
