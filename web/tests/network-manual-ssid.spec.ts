import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { WLAN, addWlan, removeWlan } from './wifi-stubs';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Regression: 5b42d838b ("Reveal SSID password field when a manual SSID is
// entered").  The WiFi password row on the Network page appeared only when a
// network was picked from the scan list or loaded from a saved config, so an
// SSID typed by hand (a hidden network) had nowhere to put its password.
// (The fix's other half, showing a saved backup network's password field, is
// not tested: the field showed on the fix's parent too.)  The adapter is
// wifi-stubs.ts's dummy wlan9; its saved config is answered by the test, and
// nothing is saved.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '1');
  addWlan();
});
test.afterEach(() => {
  removeWlan();
  restoreSettings();
});

async function openWlan(page: Page, config: Record<string, unknown>) {
  await page.route((u) => u.pathname.endsWith(`/api/network/interface/${WLAN}`), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { INTERFACE: WLAN, PROTO: 'dhcp', ...config } }) : route.fallback());
  await page.goto('/networkconfig.php');
  await page.click(`#${WLAN}-tab`);
  await expect(page.locator(`#eth_ssid_${WLAN}`)).toBeVisible({ timeout: 15_000 });
}

test('typing an SSID by hand shows the password field, and clearing it hides it', async ({ page }) => {
  await openWlan(page, { SSID: '' });
  const pskRow = page.locator(`#pskRow_${WLAN}`);
  await expect(pskRow).toBeHidden();
  await page.locator(`#eth_ssid_${WLAN}`).pressSequentially('fpp-tests-hidden-net');
  await expect(pskRow, 'no password field for a typed SSID').toBeVisible();
  await expect(page.locator(`#eth_psk_${WLAN}`)).toBeEditable();
  await page.locator(`#eth_ssid_${WLAN}`).fill('');
  await page.locator(`#eth_ssid_${WLAN}`).dispatchEvent('input');
  await expect(pskRow).toBeHidden();
});

test('picking a WEP network says it is not supported, and the save is refused', async ({ page }) => {
  // FPP does not join WEP networks (6c79a206b). The page used to ask
  // for a WEP key that nothing stored, so the network could never be joined
  // and nothing said why.  Picking one now shows a notice in place of a key
  // field, Update Interface refuses while it shows, and typing another SSID
  // takes it away.
  const posted: string[] = [];
  // A POST is captured and answered here, so a regression saves nothing on the player.
  await page.route((u) => u.pathname.endsWith(`/api/network/interface/${WLAN}`), (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postData() ?? '');
    return route.fulfill({ json: { status: 'OK' } });
  });
  await openWlan(page, { SSID: '' });
  await page.evaluate((w) => (window as any).selectWifiNetworkForInterface('fpp-tests-wep', w, 'WEP', null), WLAN);
  const wepRow = page.locator(`#wepRow_${WLAN}`);
  await expect(wepRow).toBeVisible();
  await expect(wepRow).toContainText('WEP');
  await expect(page.locator(`#pskRow_${WLAN}`)).toBeHidden();
  await page.click('input[value="Update Interface"]');
  await expect(page.locator('#ipWarning')).toContainText('WEP networks are not supported');
  expect(posted, 'a WEP network was saved').toEqual([]);
  await page.locator(`#eth_ssid_${WLAN}`).fill('fpp-tests-wpa');
  await page.locator(`#eth_ssid_${WLAN}`).dispatchEvent('input');
  await expect(wepRow).toBeHidden();
  await expect(page.locator(`#pskRow_${WLAN}`)).toBeVisible();
});
