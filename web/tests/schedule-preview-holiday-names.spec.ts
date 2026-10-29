import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The schedule preview (schedulePreview.php) names the holiday a schedule
// entry is anchored on next to that day's start and stop.  fppd resolves a
// holiday to a yearless date (startDateInt MMDD), while the occurrences it
// schedules carry the full date (YYYYMMDD).

test.skip(!container, 'reads the player\'s own date');

const PLAYLIST = 'fpp-tests-preview-holiday';
const HOLIDAY = { name: 'fpp-tests Holiday', shortName: 'FppTestsHoliday', year: 0 };

test.describe('schedule preview holiday names', () => {
  let before: unknown;
  let holidays: string | null;

  test.beforeEach(async ({ request }) => {
    before = await (await request.get('/api/schedule')).json();
    const h = await request.get('/api/configfile/user-holidays.json');
    holidays = h.ok() ? await h.text() : null;
    const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
      data: { name: PLAYLIST, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
    });
    expect(pl.ok()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/configfile/user-holidays.json', { data: Buffer.from(holidays ?? '[]') });
    await request.post('/api/schedule/reload');
    await request.delete(`/api/playlist/${PLAYLIST}`);
  });

  test('an occurrence on a holiday is labelled with the holiday\'s name', async ({ page, request }) => {
    // Regression: 229cdb45d (#2077).  The preview compared the entry's
    // date with the occurrence's in full, which held only while fppd gave
    // holidays a year (the year fppd's roll-forward picked, the bug fixed in
    // the same commit); with yearless holidays no occurrence matched, and
    // no holiday was ever named.
    // Two days from the player's today, with no year: a holiday every year.
    const [month, day] = inPlayer('date', '-d', '+2 days', '+%m %d').trim().split(' ').map(Number);
    const r = await request.post('/api/configfile/user-holidays.json', { data: [{ ...HOLIDAY, month, day }] });
    expect(r.ok()).toBe(true);
    const sch = await request.post('/api/schedule', { data: [{
      enabled: 1, day: 7, playlist: PLAYLIST, startTime: '19:00:00', endTime: '20:00:00',
      startDate: HOLIDAY.shortName, endDate: HOLIDAY.shortName, repeat: 0, stopType: 1 }] });
    expect(sch.ok()).toBe(true);
    // fppd knows the holiday once a reload has run after the file changed.
    const mmdd = month * 100 + day;
    await expect.poll(async () => {
      await request.post('/api/schedule/reload');
      const s = (await (await request.get('/api/fppd/schedule')).json()).schedule;
      return [Object.values(s.entries ?? {}).map((e: any) => e.startDateInt), s.items.map((i: any) => i.startDateInt % 10000)];
    }, { timeout: 15_000 }).toEqual([[mmdd], [mmdd]]);

    await page.goto('/schedulePreview.php');
    const rows = page.locator('table.schedulePreviewTable tbody tr', { hasText: PLAYLIST });
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText(`(${HOLIDAY.name})`);
  });
});
