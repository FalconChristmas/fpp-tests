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
    test.fail(true, 'the headings float against the window, not the preview\'s scrolling box (FUTURE.md)');
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
    // A slow player: the dialog is still sliding in when shown.bs.modal fires
    // (Bootstrap's 300 ms timer runs from show(), the slide from the first
    // frame after the table renders).  Headings placed then, against the
    // window, were left up to ~40 px above the box.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.evaluate(() => {
      (window as any).fppTestsShown = false;
      document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsShown = true; }, { once: true });
      (window as any).PreviewSchedule();
    });
    await page.waitForFunction(() => (window as any).fppTestsShown);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await expect(page.locator('#schedulePreview table.schedulePreviewTable tbody tr').first()).toBeVisible();

    const geometry = () => page.evaluate(() => {
      const table = document.querySelector('#schedulePreview table.schedulePreviewTable:not(.floatThead-table)') as HTMLElement;
      let box = table.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 2 && getComputedStyle(box).overflowY !== 'visible'))
        box = box.parentElement;
      if (!box) return null;
      // The heading floatThead floats, in its container, else the table's own.
      const head = ((document.querySelector('#schedulePreview .floatThead-container thead tr') ||
                     table.querySelector('thead tr')) as HTMLElement).getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const top = b.top + box.clientTop;
      return { headTop: head.top, headBottom: head.bottom, boxTop: top, boxBottom: top + box.clientHeight,
               scrollTop: box.scrollTop, pageScrolls: document.scrollingElement!.scrollHeight > window.innerHeight + 1 };
    });
    const g0 = await geometry();
    expect(g0, 'something in the dialog scrolls').not.toBeNull();
    expect(g0!.pageScrolls, 'the page behind the dialog scrolls instead').toBe(false);

    await page.evaluate(() => {
      const table = document.querySelector('#schedulePreview table.schedulePreviewTable:not(.floatThead-table)') as HTMLElement;
      let box = table.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 2 && getComputedStyle(box).overflowY !== 'visible'))
        box = box.parentElement;
      box!.scrollTop = 600;
      box!.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(500);
    const g = await geometry();
    expect(g!.scrollTop).toBeGreaterThan(0);
    // The heading row sits at the top of the scrolling box: not left where
    // the table was mid-slide, nor up in the dialog body's padding.
    expect(Math.abs(g!.headTop - g!.boxTop), JSON.stringify(g)).toBeLessThanOrEqual(1);
    expect(g!.headBottom, JSON.stringify(g)).toBeLessThanOrEqual(g!.boxBottom);

    // And it stays there when the window changes size (a resize, a tablet
    // turned): floated against the window, a reflow put the headings at the
    // page and dialog headers' height, over the dialog's title bar.
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.width - 200, height: vp.height - 100 });
    await page.waitForTimeout(500);
    const r = await geometry();
    expect(r!.scrollTop, 'still scrolled').toBeGreaterThan(0);
    expect(Math.abs(r!.headTop - r!.boxTop), JSON.stringify(r)).toBeLessThanOrEqual(1);
  });
});
