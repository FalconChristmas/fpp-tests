import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The File Manager's Logs tab lists the system log, /var/log/syslog, beside
// FPP's own logs.  View, Tail and Download on its row have to open that file,
// though it is not in the logs directory.

test.skip(!container, 'writes a system log inside the run-web.sh container');

const SYSLOG = '/var/log/syslog';
const TEXT = 'fpp-tests live syslog line';

test('View, Tail and Download on the system log row open /var/log/syslog', async ({ page }) => {
  // Regression: f5bdc8ea8 (#1297).  The log was listed under its full path,
  // and the path was not mapped back to /var/log when the file was fetched:
  // the viewer and the download got "File ... does not exist".  The scheme
  // that commit used (slashes sent as underscores) was replaced by 33856d7dd,
  // so this guards the behavior, not the URL.
  test.setTimeout(90_000);
  inPlayer('sh', '-c', `seq -f '${TEXT} %g' 1 20 > ${SYSLOG}; chmod 644 ${SYSLOG}`);
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    // Each action from a freshly opened Logs tab with the system log's row
    // selected (closing the viewer redraws the table and drops the selection).
    const select = async (n: number) => {
      await page.goto(`/filemanager.php?n=${n}#tab-logs`);
      await page.locator('#tab-logs-tab').click();
      const row = page.locator('#tblLogs tbody tr').filter({ has: page.locator('td', { hasText: /^\/var\/log\/syslog$/ }) });
      await expect(row).toHaveCount(1);
      await row.click();
    };
    const dialog = page.locator('#fileViewerDialog');
    let n = 0;
    for (const button of ['View', 'Tail']) {
      await select(n++);
      await page.locator(`#tab-logs input[value="${button}"]`).click();
      await expect(dialog.locator('#fileViewerText'), button).toContainText(`${TEXT} 20`, { timeout: 15_000 });
      await expect(dialog.locator('#fileViewerText'), button).not.toContainText('does not exist');
    }

    await select(n++);
    // The receiving end: what the download sends is the file.
    const download = page.waitForEvent('download');
    await page.locator('#tab-logs input[value="Download"]').click();
    const d = await download;
    const path = await d.path();
    expect(path).toBeTruthy();
    const fs = await import('fs');
    expect(fs.readFileSync(path!, 'utf8')).toContain(`${TEXT} 20`);
  } finally {
    inPlayer('rm', '-f', SYSLOG);
  }
});
