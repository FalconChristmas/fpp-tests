import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// "Select Columns to Display" on the MultiSync page: a popover listing the
// table's columns, each with a box that shows or hides it, under an "Auto"
// box that leaves it to the window's width.  The systems list and the status
// polls are answered by the test, as in multisync.spec.ts.

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const STATUS = {
  status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
  advancedView: { Platform: 'Raspberry Pi', Branch: 'master', LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', Utilization: { CPU: 1, Memory: 2 } },
};

// `joined` more remotes come into the list after the page has loaded.
async function openMultisync(page: Page, joined: () => number = () => 0) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system('10.0.0.1', 'fpptests-local', 'M1-fpptests-local', 1),
    system('10.0.0.2', 'fpptests-remote', 'M1-fpptests-remote'),
    ...Array.from({ length: joined() }, (_, i) => system(`10.0.0.${10 + i}`, `fpptests-new${i}`, `M1-fpptests-new${i}`)),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { '10.0.0.2': STATUS } }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  const polled = page.waitForResponse((r) => r.url().includes('/api/system/status'));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  await polled;
}

async function refresh(page: Page) {
  const polled = page.waitForResponse((r) => r.url().includes('/api/system/status'));
  await page.locator('#refreshStatsButton').click();
  await polled;
  // Let the render that follows the answer finish.
  await page.waitForTimeout(500);
}

const labels = (page: Page) => page.locator('.popover #columnSelector label').allTextContents()
  .then((l) => l.map((t) => t.trim()));

test('the column selector shows and hides a column', async ({ page }) => {
  // Feature: 028a9d86e.  The button, and the popover holding a box per column.
  await openMultisync(page);
  await page.locator('#columnSelectorBtn').click();
  const pop = page.locator('.popover #columnSelector');
  await expect(pop).toBeVisible();
  expect(await labels(page)).toEqual(['Auto', 'IP Address', 'Platform', 'Mode', 'Status', 'Elapsed', 'Version', 'Git Versions', 'Utilization']);

  // While Auto is on the window decides, and the column boxes are locked.
  const platform = pop.locator('label', { hasText: 'Platform' }).locator('input');
  await expect(platform).toBeDisabled();
  await pop.locator('label', { hasText: 'Auto' }).locator('input').uncheck();
  await expect(platform).toBeEnabled();

  const th = page.locator('#fppSystemsTable thead th[data-field="platform"]');
  await expect(th).toBeVisible();
  await platform.uncheck();
  await expect(th).toHaveCount(0);
  await expect(page.locator('#fppSystems tr.systemRow').first()).not.toContainText('Raspberry Pi 4');
  // Clicks inside the popover leave it open.
  await expect(pop).toBeVisible();
  await platform.check();
  await expect(th).toBeVisible();
});

test('the column selector lists each column once, however often the table is rebuilt', async ({ page }) => {
  // Regression: 48310d77d.  Each rebuild of the table added the column list
  // to the selector again, without clearing the one already there.  The
  // table is rebuilt (and the list with it) when Refresh finds a system
  // that joined.
  let joined = 0;
  await openMultisync(page, () => joined);
  for (joined = 1; joined <= 2; joined++) {
    await refresh(page);
    await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2 + joined);
  }
  await page.locator('#columnSelectorBtn').click();
  await expect(page.locator('.popover #columnSelector')).toBeVisible();
  const once = await labels(page);
  expect(new Set(once).size).toBe(once.length);
  expect(once).toHaveLength(9);
});

test('the Auto box is set off from the column boxes', async ({ page }) => {
  // Feature: 9bf7b665c.  A dotted rule under the first (Auto) label, and the
  // next label pulled up to it.
  await openMultisync(page);
  await page.locator('#columnSelectorBtn').click();
  const pop = page.locator('.popover #columnSelector');
  await expect(pop).toBeVisible();
  const style = (n: number) => pop.locator('label').nth(n).evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: `${s.borderBottomStyle} ${s.borderBottomWidth}`, display: s.display, marginTop: s.marginTop };
  });
  expect(await style(0)).toMatchObject({ border: 'dotted 2px', display: 'block' });
  expect((await style(1)).marginTop).toBe('-8px');
  expect((await style(2)).border).not.toContain('dotted');
});
