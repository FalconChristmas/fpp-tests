import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { WLAN, addWlan, removeWlan } from './wifi-stubs';
import { setSettingInFile, snapshotSettings } from './settings-file';

// What the Network page's Update Interface sends for a wireless interface
// (SaveNetworkConfig()).  The API never gives a saved password back, so the
// page shows "Saved - leave blank to keep": a blank password on the network
// it was saved for must be left out of the save (the player keeps it; sending
// "" would leave a WiFi-only player off its network), while a blank one on a
// different network clears it, and a typed one is sent.  A password WPA can't
// use is refused before anything is sent.  The saved state is answered here;
// nothing is saved to the player.

test.skip(!container, 'adds a wireless adapter to the run-web.sh player');

let restoreSettings: () => void;
test.beforeAll(() => addWlan());
test.afterAll(() => removeWlan());
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '1');
});
test.afterEach(() => restoreSettings());

const SAVED = { PROTO: 'dhcp', SSID: 'fpp-tests-net', PSKSet: true, HIDDEN: '1', WPA3: '1',
  BACKUPSSID: 'fpp-tests-backup', BACKUPPSKSet: true, BACKUPHIDDEN: '0', BACKUPWPA3: '0' };

// Answers the interface's saved config and records what Update posts.
async function openWifi(page: Page, saved: Record<string, unknown> = SAVED) {
  const posts: any[] = [];
  await page.route((u) => u.pathname.endsWith(`/api/network/interface/${WLAN}`), (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { INTERFACE: WLAN, ...saved } });
    if (route.request().method() === 'POST') {
      posts.push(JSON.parse(route.request().postData()!));
      return route.fulfill({ json: { status: 'OK' } });
    }
    return route.fallback();
  });
  page.on('dialog', (d) => d.accept());
  await page.goto('/networkconfig.php');
  await page.click(`#${WLAN}-tab`);
  await expect(page.locator(`#eth_ssid_${WLAN}`)).toHaveValue(String(saved.SSID ?? ''), { timeout: 15_000 });
  return posts;
}
const field = (page: Page, id: string) => page.locator(`#${id}_${WLAN}`);
const update = (page: Page) => page.locator('input[value="Update Interface"]:visible').click();

test('a saved network and its backup are drawn, and a blank password keeps the saved one', async ({ page }) => {
  const posts = await openWifi(page);
  await expect(field(page, 'eth_hidden')).toBeChecked();
  await expect(field(page, 'eth_wpa3')).toBeChecked();
  await expect(field(page, 'backupeth_ssid')).toHaveValue('fpp-tests-backup');
  await expect(field(page, 'backupeth_hidden')).not.toBeChecked();
  await expect(field(page, 'eth_psk')).toHaveAttribute('placeholder', 'Saved - leave blank to keep');
  await expect(field(page, 'backupeth_psk')).toHaveAttribute('placeholder', 'Saved - leave blank to keep');
  await update(page);
  await expect.poll(() => posts.length).toBe(1);
  const sent = posts[0];
  expect(sent).toMatchObject({ INTERFACE: WLAN, PROTO: 'dhcp', SSID: 'fpp-tests-net', HIDDEN: true, WPA3: true,
    BACKUPSSID: 'fpp-tests-backup', BACKUPHIDDEN: false, BACKUPWPA3: false });
  expect(sent, 'the saved password would be overwritten').not.toHaveProperty('PSK');
  expect(sent).not.toHaveProperty('BACKUPPSK');
});

test('a typed password is sent, and a blank one on another network clears the old one', async ({ page }) => {
  const posts = await openWifi(page);
  await field(page, 'eth_psk').fill('fpp-tests new key');
  // The backup moves to another network without a password: the old key
  // was for the old network.
  await field(page, 'backupeth_ssid').fill('fpp-tests-open');
  await update(page);
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ SSID: 'fpp-tests-net', PSK: 'fpp-tests new key', BACKUPSSID: 'fpp-tests-open', BACKUPPSK: '' });
});

for (const [what, id, key, ok] of [
  ['a 7 character password', 'eth_psk', 'short12', false],
  ['a 64 character password that is not hex', 'eth_psk', 'x'.repeat(64), false],
  ['a 64 character hex key', 'eth_psk', 'a1'.repeat(32), true],
  ['a 63 character passphrase', 'eth_psk', 'p'.repeat(63), true],
  ['an 8 character passphrase', 'eth_psk', 'eight ch', true],
  ['a 7 character backup password', 'backupeth_psk', 'short12', false],
] as const) {
  test(`${what} is ${ok ? 'sent' : 'refused, and nothing is sent'}`, async ({ page }) => {
    const posts = await openWifi(page);
    await field(page, id).fill(key);
    await update(page);
    if (ok) {
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0][id === 'eth_psk' ? 'PSK' : 'BACKUPPSK']).toBe(key);
    } else {
      await expect(page.locator('.jGrowl-message', { hasText: 'must be an 8-63 character passphrase or a 64 character hex key' })).toBeVisible();
      await page.waitForTimeout(500);
      expect(posts).toEqual([]);
    }
  });
}
