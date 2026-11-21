import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { dropSettings, keepingSettings, setSettingInFile } from './privacy-helpers';
import { settingInFile } from './settings-file';

// The Network page's Tethering settings come from settings.json: the
// Tethering Interface choices are what its optionsCommand prints, and the
// SSID field follows the host name when that option is checked.

test.skip(!container, 'stands in for ifconfig inside the run-web.sh container');

let real = '';
test.beforeEach(() => {
  real = inPlayer('readlink', '-f', '/sbin/ifconfig').trim();
  inPlayer('sh', '-c', `cp -p '${real}' '${real}.fpp-tests' && printf '%s\\n' '#!/bin/sh' ` +
    `'printf "eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\\n\\nwlan7: flags=4099<UP,BROADCAST,MULTICAST>  mtu 1500\\n\\n"' > '${real}'`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `mv -f '${real}.fpp-tests' '${real}'`);
});

test('the Tethering Interface choices are the WiFi interfaces ifconfig lists', async ({ page }) => {
  // Feature: e9b20cfa3 ("Convert WiFi Tethering tab to use settings defined
  // in settings.json").  A select setting can take its options from a shell
  // command (optionsCommand), which TetherInterface uses to offer the wl*
  // interfaces.
  await page.goto('/networkconfig.php');
  const options = page.locator('select#TetherInterface option');
  await expect(options).toHaveCount(1);
  await expect(options).toHaveAttribute('value', 'wlan7');
});

test('the SSID field follows the host name while "Use hostname as tether SSID" is checked', async ({ page }) => {
  // Feature: fpp#3199. The checkbox sits between Interface and SSID, is on by
  // default, and greys out the SSID as a copy of the host name (FPP.local ->
  // FPP). Unchecking leaves the value editable.
  await keepingSettings(async () => {
    dropSettings('TetherUseHostname', 'TetherSSID');
    setSettingInFile('HostName', 'fpp-tests.local');
    await page.goto('/networkconfig.php');
    await page.click('#tab-tethering-tab');
    const checkbox = page.locator('#TetherUseHostname');
    const ssid = page.locator('#TetherSSID');
    await expect(checkbox).toBeVisible({ timeout: 15_000 });
    await expect(checkbox).toBeChecked();
    await expect(ssid).toBeDisabled();
    await expect(ssid).toHaveValue('fpp-tests');
    const order = await page.locator('#TetherInterfaceRow, #TetherUseHostnameRow, #TetherSSIDRow')
      .evaluateAll((els) => els.map((el) => el.id));
    expect(order).toEqual(['TetherInterfaceRow', 'TetherUseHostnameRow', 'TetherSSIDRow']);

    await checkbox.uncheck();
    await expect(ssid).toBeEnabled();
    await expect(ssid).toHaveValue('fpp-tests');
    await expect.poll(() => settingInFile('TetherUseHostname')).toBe('0');

    await checkbox.check();
    await expect(ssid).toBeDisabled();
    await expect.poll(() => settingInFile('TetherSSID')).toBe('fpp-tests');
  });
});

test('an existing custom SSID leaves the option off; the default or hostname leaves it on', async ({ page }) => {
  // Feature: fpp#3199. Installs that already chose a tether SSID keep it and
  // the new option stays off, so a later host name change cannot overwrite
  // it. Those still on FPP, or already matching their host name, get the
  // new on default.
  await keepingSettings(async () => {
    dropSettings('TetherUseHostname');
    setSettingInFile('HostName', 'fpp-tests-host');
    setSettingInFile('TetherSSID', 'fpp-tests-show');
    await page.goto('/networkconfig.php');
    await page.click('#tab-tethering-tab');
    await expect(page.locator('#TetherUseHostname')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#TetherUseHostname')).not.toBeChecked();
    await expect(page.locator('#TetherSSID')).toBeEnabled();
    await expect(page.locator('#TetherSSID')).toHaveValue('fpp-tests-show');

    for (const name of ['FPP', 'fpp-tests-host']) {
      setSettingInFile('TetherSSID', name);
      await page.reload();
      await page.click('#tab-tethering-tab');
      await expect(page.locator('#TetherUseHostname')).toBeChecked();
      await expect(page.locator('#TetherSSID')).toBeDisabled();
    }
  });
});
