import { test, expect } from './fixtures';

// The MultiSync page marks the player's own row by bold type on the hostname
// span itself, not by wrapping the name in a <b> element inside it.
//
// Regression: 461ce2283 ("Fix Upgrade FPP for the local fpp instance").  The
// local row's hostname span held "<b>name</b>", so the name in it was
// markup, not text; bold moved to the span itself, which holds only the name.

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.14';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

test('the local row\'s hostname is bold through its span, which holds only the name', async ({ page }) => {
  const systems = { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(REMOTE, 'fpptests-remote', 'M1-fpptests-remote')] };
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: systems }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });

  const local = page.locator('#fpp_192_168_0_13_hostname');
  const remote = page.locator('#fpp_192_168_0_14_hostname');
  await expect(local).toContainText('FPPTESTLOCAL');
  expect(await local.evaluate((e) => getComputedStyle(e).fontWeight), 'local hostname not bold').toMatch(/^(bold|[6-9]00)$/);
  expect(await local.locator('b').count(), 'name wrapped in a <b> inside the span').toBe(0);
  expect((await local.textContent())!.trim()).toBe('FPPTESTLOCAL');
  expect(await remote.evaluate((e) => getComputedStyle(e).fontWeight), 'remote hostname bold').toMatch(/^(normal|[1-5]00)$/);
});
