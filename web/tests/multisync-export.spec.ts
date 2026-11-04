import { test, expect } from './fixtures';
import { readFileSync } from 'fs';

// The MultiSync page's Export button: the systems' statuses, flattened to
// one row per system, saved as a spreadsheet.  The systems list and their
// statuses are answered by the test.

function system(address: string, hostname: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid: `M1-${hostname}`,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

test('Export saves a spreadsheet with a row per system and its status flattened into columns', async ({ page }) => {
  // Feature: 997d828fa ("First Attempt at allowing MultiSync data to be
  // exported", #1048).
  const systems = [system('192.0.2.11', 'fpptests-local', 1), system('192.0.2.12', 'fpptests-remote')];
  const status = (host: string, temp: number) => ({
    status_name: 'idle', mode_name: 'player', advancedView: { HostName: host, Utilization: { CPU: temp } },
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems } }));
  await page.route('**/api/system/status?**', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('type') !== 'FPP') return route.fulfill({ json: {} });
    return route.fulfill({ json: { '192.0.2.11': status('fpptests-local', 11), '192.0.2.12': status('fpptests-remote', 12) } });
  });
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  const polled = page.waitForResponse((r) => r.url().includes('/api/system/status?type=FPP'));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  await polled;

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportStatsButton').click()]);
  expect(download.suggestedFilename()).toBe('export.xlsx');
  const file = readFileSync((await download.path())!);
  expect(file.subarray(0, 2).toString()).toBe('PK');
  // Read back with the page's own copy of the spreadsheet library.
  const rows = await page.evaluate((b64) => {
    const X = (window as any).XLSX;
    const wb = X.read(b64, { type: 'base64' });
    return { sheets: wb.SheetNames, rows: X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }) };
  }, file.toString('base64'));
  expect(rows.sheets).toEqual(['Data']);
  const [head, ...body] = rows.rows as unknown[][];
  expect(head[0]).toBe('ip');
  expect(head).toEqual(expect.arrayContaining(['status_name', 'advancedView.HostName', 'advancedView.Utilization.CPU']));
  const col = (name: string) => head.indexOf(name);
  expect(body.map((r) => [r[0], r[col('advancedView.HostName')], r[col('advancedView.Utilization.CPU')]])).toEqual([
    ['192.0.2.11', 'fpptests-local', 11],
    ['192.0.2.12', 'fpptests-remote', 12],
  ]);
});
