import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Network page's Tethering settings come from settings.json; the
// Tethering Interface choices are what its optionsCommand prints.

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
