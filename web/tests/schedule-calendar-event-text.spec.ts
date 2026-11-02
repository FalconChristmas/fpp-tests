import { test, expect } from './fixtures';

// The schedule's calendar preview (scheduleCalendar.php + FullCalendar).  The
// range fppd would expand is answered here with one playlist entry today.

test.use({ colorScheme: 'light' });

test('an event\'s text follows the theme\'s emphasis colour, not FullCalendar\'s white', async ({ page }) => {
  // Regression: 70159beee.  FullCalendar paints event text from
  // --fc-event-text-color, white by default, over the pale subtle event
  // backgrounds of the light theme: the titles vanished.
  const now = Math.floor(Date.now() / 1000);
  await page.route((u) => u.pathname === '/api/fppd/schedule/range', (route) => route.fulfill({
    json: { schedule: { items: [{
      type: 'playlist', command: 'Start Playlist', playlist: 'fpp-tests-playlist', args: [], enabled: true,
      overridden: false, startTime: now - 600, endTime: now + 3600,
    }] } },
  }));
  await page.goto('/index.php');
  const preview = page.locator('#statusPreviewActions');
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await preview.click();
  await page.locator('.dropdown-menu.show .dropdown-item', { hasText: 'Calendar View' }).click();
  const calendar = page.locator('#scheduleCalendarModal');
  const title = calendar.locator('.fc .sch-cal-event', { hasText: 'fpp-tests-playlist' }).first();
  await expect(title).toBeVisible({ timeout: 15_000 });
  const colours = await page.evaluate(() => {
    const ev = document.querySelector('#scheduleCalendarModal .fc .sch-cal-event') as HTMLElement;
    const text = (ev.querySelector('.fc-event-main, .fc-list-event-title') ?? ev) as HTMLElement;
    const probe = document.createElement('span');
    probe.style.color = 'var(--bs-emphasis-color)';
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return { got: getComputedStyle(text).color, want, node: text.className };
  });
  expect(colours.want, 'the control: emphasis colour is dark in the light theme').not.toBe('rgb(255, 255, 255)');
  expect(colours.got, JSON.stringify(colours)).toBe(colours.want);
});
