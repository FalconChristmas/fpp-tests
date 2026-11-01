import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// With no send method left on the MultiSync page and no remote picked, the
// page turns Multicast on, because that is what fppd falls back to.  The
// systems list is answered by the test; the settings are the player's own.

test.skip(!container, 'reads the stored settings inside the run-web.sh container');

const LOCAL = '192.168.0.13';

const put = (page: Page, name: string, value: string) =>
  page.request.put(`/api/settings/${name}`, { data: value, headers: { 'Content-Type': 'text/plain' } });

function stored(name: string): string {
  return inPlayer('sh', '-c', `grep '^${name} ' /home/fpp/media/settings || true`).trim();
}

test.afterEach(async ({ page }) => {
  await put(page, 'MultiSyncMulticast', '0');
  await put(page, 'MultiSyncUnicast', '1');
  await put(page, 'MultiSyncEnabled', '0');
});

test('turning off the last send method saves Multicast as the one in use', async ({ page }) => {
  // Regression: e2864eb38.  The page ticked Multicast when nothing was
  // chosen, but without a change event, so the box showed it on while the
  // setting stayed off (and the page showed it unchecked again on reload).
  await put(page, 'MultiSyncEnabled', '1');
  await put(page, 'MultiSyncUnicast', '1');
  await put(page, 'MultiSyncMulticast', '0');
  await put(page, 'MultiSyncBroadcast', '0');
  await put(page, 'MultiSyncRemotes', '');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [{
      address: LOCAL, hostname: 'FPPTESTLOCAL', local: 1, fppMode: 2, fppModeString: 'player',
      typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
      version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid: 'M1-fpptests-local',
      channelRanges: '', multiSyncCapable: 1, multisync: false,
      lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
    }] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('.fppSystemsUiSettingsToggle').click();
  await expect(page.locator('#MultiSyncUnicast')).toBeChecked();
  await expect(page.locator('#MultiSyncMulticast')).not.toBeChecked();

  const saved = page.waitForResponse((r) => r.url().includes('/api/settings/MultiSyncUnicast') && r.request().method() === 'PUT');
  await page.locator('#MultiSyncUnicast').uncheck();
  expect((await saved).ok()).toBe(true);
  // The page puts Multicast on in its place ...
  await expect(page.locator('#MultiSyncMulticast')).toBeChecked();
  // ... and what fppd reads says so too.
  await expect.poll(() => stored('MultiSyncMulticast')).toBe('MultiSyncMulticast = "1"');
  expect(stored('MultiSyncUnicast')).toBe('MultiSyncUnicast = "0"');
});
