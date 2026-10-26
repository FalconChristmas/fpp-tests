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
    route.request().method() === 'GET' ? route.fulfill({ json: { INTERFACE: WLAN, PROTO: 'dhcp', ...config } }) : route.continue());
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
