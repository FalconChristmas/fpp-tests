import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Sorting the MultiSync table by IP address and by the colour each remote
// reports for itself (advancedView.backgroundColor, which also paints its
// row).  The systems list and the status answers are the test's, as in
// multisync-sort-filter.spec.ts.

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

function status(backgroundColor: string) {
  return {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: { Platform: 'Raspberry Pi', backgroundColor, Branch: 'master', LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', Utilization: { CPU: 1, Memory: 2 } },
  };
}

// Host names in an order neither the addresses (as numbers or as text) nor
// the colours share.  The local player is at 10.0.0.1, with no colour.
const REMOTES: [string, string, string][] = [
  ['10.0.0.10', 'fpptests-c', '800080'],
  ['10.0.0.9', 'fpptests-a', ''],
  ['10.0.0.100', 'fpptests-d', '008000'],
  ['10.0.0.2', 'fpptests-b', ''],
];

async function openMultisync(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system('10.0.0.1', 'fpptests-local', 'M1-fpptests-local', 1),
    ...REMOTES.map(([ip, host]) => system(ip, host, `M1-${host}`)),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: Object.fromEntries(REMOTES.map(([ip, , c]) => [ip, status(c)])) }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  const polled = page.waitForResponse((r) => r.url().includes('/api/system/status'));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(5, { timeout: 15_000 });
  await polled;
}

async function hostnames(page: Page): Promise<string[]> {
  return page.locator('#fppSystems tr.systemRow').evaluateAll((rows) =>
    rows.map((r) => (r.querySelector('span[id^="fpp_"]')?.textContent ?? '').trim()));
}

test('the IP column sorts addresses as numbers', async ({ page }) => {
  // Regression: 74a1bb69b.  ipSorter read the address from the row with
  // $(row).find('td[data-ip]'), but bootstrap-table hands it the row's data,
  // not its element, so it fell back to the cell's HTML -- a link whose
  // markup starts the same for every address -- and the order was no order.
  await openMultisync(page);
  await page.locator('#fppSystemsTable thead th[data-field="ipaddress"] .sortable').click();
  const want = ['fpptests-local', 'fpptests-b', 'fpptests-a', 'fpptests-c', 'fpptests-d'];
  const got = await hostnames(page);
  expect([JSON.stringify(want), JSON.stringify([...want].reverse())]).toContain(JSON.stringify(got));
});

test("each remote's row is painted its colour, and Sort Systems by Color orders the coloured rows by it", async ({ page }) => {
  // Feature: 8a4422d27.  The colour a remote reports went only into the
  // hidden FPP Color column: its row was not painted, and the colour sort
  // had no colour to sort the rows on.
  // Feature: 8606a9fda, the Sort Systems by Color button itself.
  await openMultisync(page);
  const bg = (host: string) => page.locator('#fppSystems tr.systemRow', { hasText: host }).evaluate((r) => (r as HTMLElement).style.background);
  await expect.poll(() => bg('fpptests-c')).toContain('rgb(128, 0, 128)');
  expect(await bg('fpptests-d')).toContain('rgb(0, 128, 0)');
  expect(await bg('fpptests-a')).toBe('');

  await page.locator('#sortbyColorBtn').click();
  // 0x008000 before 0x800080, wherever the rows without a colour went.
  await expect.poll(async () => (await hostnames(page)).filter((h) => h === 'fpptests-c' || h === 'fpptests-d'))
    .toEqual(['fpptests-d', 'fpptests-c']);
});

test('Sort Systems by Color puts the rows without a colour last', async ({ page }) => {
  // Regression: 74a1bb69b.  A row without a colour sorted as -1, so the
  // uncoloured rows -- usually most of them -- came first and the coloured
  // ones were pushed to the bottom.
  await openMultisync(page);
  await expect.poll(() => page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-d' })
    .evaluate((r) => (r as HTMLElement).style.background)).toContain('rgb(0, 128, 0)');
  await page.locator('#sortbyColorBtn').click();
  await expect.poll(async () => (await hostnames(page)).slice(0, 2)).toEqual(['fpptests-d', 'fpptests-c']);
  expect((await hostnames(page)).slice(2).sort()).toEqual(['fpptests-a', 'fpptests-b', 'fpptests-local']);
});
