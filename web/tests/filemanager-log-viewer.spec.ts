import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The File Manager's file viewer, opened on a log from the Logs tab.  A log
// is read newest-last, and the viewer is a scrollable modal: its body is the
// one vertical scroller.

test.skip(!container, 'writes a log inside the run-web.sh container');

const LOG = '/home/fpp/media/logs/fpp-tests-long.log';

test('a long log opens at its newest line, with one vertical scroller', async ({ page }) => {
  // Regression: 34f0e5dcc.  The viewer opened at the top of the file (weeks
  // old, for a rotated log), and the pre inside it had a fixed height of its
  // own while the dialog overflowed the modal by its margins: three
  // vertical scrollbars, nested.
  inPlayer('sh', '-c', `seq -f 'fpp-tests line %g' 1 3000 > ${LOG}`);
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/filemanager.php#tab-logs');
    await page.locator('#tab-logs-tab').click();
    await page.locator('#tblLogs tbody tr').filter({ has: page.locator('td', { hasText: /^fpp-tests-long\.log$/ }) }).click();
    await page.locator('#tab-logs input[value="View"]').click();
    const dialog = page.locator('#fileViewerDialog');
    await expect(dialog.locator('#fileViewerText')).toContainText('fpp-tests line 3000', { timeout: 15_000 });

    const body = dialog.locator('.modal-body');
    // Opened scrolled to the end, where the newest line is.
    await expect(body).toBeVisible();
    // Soft, here and below, so each of the fix's two halves is reported.
    await expect.configure({ soft: true }).poll(() => body.evaluate((b) => b.clientHeight > 0 && b.scrollHeight - b.clientHeight - b.scrollTop <= 2), { timeout: 5_000 }).toBe(true);
    // The body is what scrolls: it holds the whole log, many times its height.
    const dims = await body.evaluate((b) => ({ scroll: b.scrollHeight, client: b.clientHeight }));
    expect.soft(dims.scroll, JSON.stringify(dims)).toBeGreaterThan(3 * dims.client);
    // The body is the only thing that scrolls vertically: not the text in
    // it, and not the modal around the dialog.
    const pre = dialog.locator('#fileViewerText pre').first();
    expect.soft(await pre.evaluate((p) => p.scrollHeight - p.clientHeight), 'the text scrolls on its own').toBeLessThanOrEqual(1);
    expect.soft(await dialog.evaluate((m) => m.scrollHeight - m.clientHeight), 'the modal around the dialog scrolls').toBeLessThanOrEqual(1);
  } finally {
    inPlayer('rm', '-f', LOG);
  }
});
