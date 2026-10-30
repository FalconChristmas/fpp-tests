import { test, expect } from './fixtures';

// The schedule preview dialog (PreviewSchedule() -> schedulePreview.php):
// with more rows than fit, the table scrolls inside the dialog and its
// column headings stay in view, whole, above the rows scrolled under them.

const PLAYLIST = 'fpp-tests-preview-scroll';

test.describe('schedule preview scrolling', () => {
  let before: unknown;

  test.beforeEach(async ({ request }) => {
    before = await (await request.get('/api/schedule')).json();
    const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
      data: { name: PLAYLIST, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
    });
    expect(pl.ok()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
    // The hourly entry is due now, so fppd started it; a later test must
    // not find it playing (fppd lists the running item with the schedule).
    await request.post('/api/playlists/stop');
    await request.delete(`/api/playlist/${PLAYLIST}`);
  });

  test('the preview scrolls inside the dialog with its column headings in view', async ({ page, request }) => {
    // Regression: 09ef4ef6a.  The whole dialog body scrolled, and once the
    // rows had scrolled the headings floated over them were pinned above
    // the body's top edge, partly over the dialog's title bar.  Now the
    // table scrolls in its own box, with the headings at its top.
    const year = new Date().getFullYear();
    // Hourly, every day: far more rows than the dialog can show.
    const sch = await request.post('/api/schedule', { data: [{
      enabled: 1, day: 7, playlist: PLAYLIST, startTime: '00:00:00', endTime: '23:00:00',
      startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 6000, stopType: 1 }] });
    expect(sch.ok()).toBe(true);
    await request.post('/api/schedule/reload');
    await expect.poll(async () => (await (await request.get('/api/fppd/schedule')).json()).schedule.items.length, { timeout: 10_000 }).toBeGreaterThan(40);

    await page.goto('/scheduler.php');
    await page.waitForFunction(() => typeof (window as any).PreviewSchedule === 'function');
    await page.evaluate(() => {
      (window as any).fppTestsShown = false;
      document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsShown = true; }, { once: true });
      (window as any).PreviewSchedule();
    });
    await page.waitForFunction(() => (window as any).fppTestsShown);
    await expect(page.locator('#schedulePreview table.schedulePreviewTable tbody tr').first()).toBeVisible();

    const geometry = () => page.evaluate(() => {
      const table = document.querySelector('#schedulePreview table.schedulePreviewTable') as HTMLElement;
      let box = table.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 2 && getComputedStyle(box).overflowY !== 'visible'))
        box = box.parentElement;
      if (!box) return null;
      const head = (table.querySelector('thead tr') as HTMLElement).getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const top = b.top + box.clientTop;
      return { headTop: head.top, headBottom: head.bottom, boxTop: top, boxBottom: top + box.clientHeight,
               scrollTop: box.scrollTop, pageScrolls: document.scrollingElement!.scrollHeight > window.innerHeight + 1 };
    });
    const g0 = await geometry();
    expect(g0, 'something in the dialog scrolls').not.toBeNull();
    expect(g0!.pageScrolls, 'the page behind the dialog scrolls instead').toBe(false);

    await page.evaluate(() => {
      const table = document.querySelector('#schedulePreview table.schedulePreviewTable') as HTMLElement;
      let box = table.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 2 && getComputedStyle(box).overflowY !== 'visible'))
        box = box.parentElement;
      box!.scrollTop = 600;
      box!.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(500);
    const g = await geometry();
    expect(g!.scrollTop).toBeGreaterThan(0);
    // The heading row is inside the scrolling box's visible area.  floatThead
    // pins it at an offset worked out from the header heights, which can
    // land a pixel or so above the box's top edge, in the dialog body's
    // padding (1.3 px with the CI runner's fonts).
    expect(g!.headTop, JSON.stringify(g)).toBeGreaterThanOrEqual(g!.boxTop - 2);
    expect(g!.headBottom, JSON.stringify(g)).toBeLessThanOrEqual(g!.boxBottom);
  });
});
