import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The MultiSync page's send options: with "Send MultiSync to ALL KNOWN
// remotes via Unicast" on, fppd unicasts to every remote it knows, so the
// per-remote unicast boxes (each remote-mode row's .syncCheckbox, saved as
// MultiSyncRemotes) do nothing.  The systems list is answered by the test;
// the settings are the player's own.

test.skip(!container, 'reads the stored settings inside the run-web.sh container');

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.21';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const put = (page: Page, name: string, value: string) =>
  page.request.put(`/api/settings/${name}`, { data: value, headers: { 'Content-Type': 'text/plain' } });

function stored(name: string): string {
  return inPlayer('sh', '-c', `grep '^${name} ' /home/fpp/media/settings || true`).trim();
}

test.afterEach(async ({ page }) => {
  await put(page, 'MultiSyncRemotes', '');
  await put(page, 'MultiSyncUnicast', '1');
  await put(page, 'MultiSyncEnabled', '0');
});

test('the per-remote unicast boxes are hidden while unicast to all known remotes is on', async ({ page }) => {
  // Regression: 2ed55662b.  The per-remote boxes stayed on show (and
  // clickable) with "ALL KNOWN remotes via Unicast" on, where they change
  // nothing.  Turning it off brings them back as they were left.
  await put(page, 'MultiSyncEnabled', '1');
  await put(page, 'MultiSyncUnicast', '1');
  await put(page, 'MultiSyncRemotes', REMOTE);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(REMOTE, 'fpptests-remote', 'M1-fpptests-remote')] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });

  const box = page.locator(`input.syncCheckbox[name='${REMOTE}']`);
  const label = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' }).getByText('Select IPs for Unicast Sync');
  // The control: the remote's box is drawn, holding its saved selection.
  await expect(box).toHaveCount(1);
  await expect(box).toBeChecked();
  await expect(page.locator('#MultiSyncUnicast')).toBeChecked();
  await expect(box).toBeHidden();
  await expect(label).toBeHidden();

  await page.locator('.fppSystemsUiSettingsToggle').click();
  await expect(page.locator('#MultiSyncUnicast')).toBeVisible();
  // Turned off: the picker is back, with the selection as it was.
  const saved = page.waitForResponse((r) => r.url().includes('/api/settings/MultiSyncUnicast') && r.request().method() === 'PUT');
  await page.locator('#MultiSyncUnicast').uncheck();
  expect((await saved).ok()).toBe(true);
  await expect(box).toBeVisible();
  await expect(label).toBeVisible();
  await expect(box).toBeChecked();
  // What fppd reads: unicast to the picked remote only.
  await expect.poll(() => stored('MultiSyncUnicast')).toBe('MultiSyncUnicast = "0"');
  expect(stored('MultiSyncRemotes')).toBe(`MultiSyncRemotes = "${REMOTE}"`);

  // And on again: hidden again.
  await page.locator('#MultiSyncUnicast').check();
  await expect(box).toBeHidden();
  await expect(label).toBeHidden();
  await expect.poll(() => stored('MultiSyncUnicast')).toBe('MultiSyncUnicast = "1"');
  expect(stored('MultiSyncRemotes')).toBe(`MultiSyncRemotes = "${REMOTE}"`);
});
