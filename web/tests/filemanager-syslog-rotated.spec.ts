import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The File Manager's Logs tab and the logs zip (api/files/zip/Logs, the
// tab's download) take the system log from /var/log as well as FPP's own
// logs.  Only the live file was taken; logrotate's copies of it (syslog.1,
// syslog.2.gz ...) never showed up, though they hold most of the history.
// The container has no syslog, so the test writes one and two rotated copies.

test.skip(!container, 'writes system logs inside the run-web.sh container');

const LOGS = ['/var/log/syslog', '/var/log/syslog.1', '/var/log/syslog.2.gz'];

function zipNames(path: string): string[] {
  return JSON.parse(inPlayer('python3', '-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', path));
}

test('the rotated syslog files are listed, open and are in the logs zip', async ({ page, request }) => {
  // Regression: a78eee23d.  GetFilesHelper() and ZipLogs() named
  // /var/log/syslog and /var/log/messages only.
  test.setTimeout(90_000);
  inPlayer('sh', '-c', 'echo "fpp-tests live syslog" > /var/log/syslog; echo "fpp-tests rotated once" > /var/log/syslog.1; ' +
    'echo "fpp-tests rotated twice" | gzip > /var/log/syslog.2.gz; chmod 644 /var/log/syslog*');
  const zip = '/tmp/fpp-tests-logs.zip';
  try {
    const files = (await (await request.get('/api/files/Logs')).json()).files.map((f: any) => f.name);
    // The control: the live one, as before.
    expect(files).toContain('/var/log/syslog');
    // Soft, here and below: each place a rotated file is missing is reported.
    expect.soft(files).toEqual(expect.arrayContaining(['/var/log/syslog.1', '/var/log/syslog.2.gz']));

    // What the Logs tab lists, and a rotated one opens from there.
    await page.goto('/filemanager.php#tab-logs');
    await page.locator('#tab-logs-tab').click();
    const rows = page.locator('#tblLogs tbody tr');
    for (const f of LOGS) {
      await expect.soft(rows.filter({ has: page.locator('td', { hasText: new RegExp(`^${f.replace(/\./g, '\\.')}$`) }) })).toHaveCount(1);
    }
    const text = await (await request.get('/api/file/Logs/' + encodeURIComponent('/var/log/syslog.1'))).text();
    expect(text).toContain('fpp-tests rotated once');

    const response = await request.get('/api/files/zip/Logs', { timeout: 60_000 });
    expect(response.ok()).toBe(true);
    putFile(zip, await response.body());
    const names = zipNames(zip);
    expect(names).toContain('logs/syslog.log');
    expect.soft(names).toEqual(expect.arrayContaining(['logs/syslog.1', 'logs/syslog.2.gz']));
  } finally {
    inPlayer('rm', '-f', zip, ...LOGS);
  }
});
