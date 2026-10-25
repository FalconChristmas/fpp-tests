import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// MultiSync's saved display order: in reorder mode the rows can be dragged,
// Save Display Order stores the order as the MultiSyncDisplayOrder setting
// (each system's uuid:<UUID>, or host:<name> without one, joined by "|"),
// and the page lists the systems in that order when it next loads -- the
// setting is read back by multisync.php itself.  The systems list is the
// test's, as in multisync.spec.ts; the setting is the player's own.

test.skip(!container, 'reads the stored setting inside the run-web.sh container');

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const SYSTEMS = [
  system('192.168.0.13', 'fpptests-1', 'M1-fpptests-1', 1),
  system('192.168.0.21', 'fpptests-2', 'M1-fpptests-2'),
  system('192.168.0.22', 'fpptests-3', 'M1-fpptests-3'),
  system('192.168.0.23', 'fpptests-4', ''),
];

const clear = (page: Page) =>
  page.request.put('/api/settings/MultiSyncDisplayOrder', { data: '', headers: { 'Content-Type': 'text/plain' } });

test.afterEach(async ({ page }) => {
  await clear(page);
});

async function openMultisync(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: SYSTEMS } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(4, { timeout: 15_000 });
}

async function hostnames(page: Page): Promise<string[]> {
  return page.locator('#fppSystems tr.systemRow').evaluateAll((rows) =>
    rows.map((r) => (r.querySelector('span[id^="fpp_"]')?.textContent ?? '').trim()));
}

test('a dragged order is saved, comes back on the next load, and Sort by Saved Order restores it', async ({ page }) => {
  // Feature: ac72949ca (#2065).  multisync.spec.ts checks that a drag
  // survives a refresh; this is the order being kept: saved, stored, and
  // used when the page is opened again.
  await clear(page);
  await openMultisync(page);
  await expect.poll(() => hostnames(page)).toEqual(['fpptests-1', 'fpptests-2', 'fpptests-3', 'fpptests-4']);

  // Drag the first row below the second, as multisync.spec.ts does.
  await page.locator('#reorderModeBtn').click();
  const grips = page.locator('#fppSystems tr.systemRow .reorder-grip');
  await grips.first().waitFor({ state: 'visible' });
  const from = (await grips.nth(0).boundingBox())!;
  const to = (await grips.nth(1).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.75, { steps: 20 });
  await page.mouse.up();
  const dragged = ['fpptests-2', 'fpptests-1', 'fpptests-3', 'fpptests-4'];
  await expect.poll(() => hostnames(page)).toEqual(dragged);

  const saved = page.waitForResponse((r) => r.url().includes('/api/settings/MultiSyncDisplayOrder') && r.request().method() === 'PUT');
  await page.locator('#saveDisplayOrderBtn').click();
  expect((await saved).ok()).toBe(true);
  expect(inPlayer('sh', '-c', "grep '^MultiSyncDisplayOrder ' /home/fpp/media/settings || true").trim())
    .toBe('MultiSyncDisplayOrder = "uuid:M1-fpptests-2|uuid:M1-fpptests-1|uuid:M1-fpptests-3|host:fpptests-4"');

  // Opened again: the saved order, not the hostname sort.
  await openMultisync(page);
  await expect.poll(() => hostnames(page)).toEqual(dragged);

  // Sorted by a column, then back to the saved order.
  await page.locator('#fppSystemsTable thead th[data-field="hostname"] .sortable').click();
  await expect.poll(() => hostnames(page)).not.toEqual(dragged);
  await page.locator('#sortBySavedOrderBtn').click();
  await expect.poll(() => hostnames(page)).toEqual(dragged);
});
