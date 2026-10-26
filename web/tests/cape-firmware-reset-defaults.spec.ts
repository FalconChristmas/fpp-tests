import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';

// Cape Info's EEPROM upgrade and its "Reset configuration to defaults from
// new firmware" box.  The upgrade runs scripts/upgradeCapeFirmware through
// sudo; there is no cape EEPROM in the container to write, so this player's
// copy of that script is a stand-in that keeps the arguments it was given
// (upgradeCapeFirmware.php's side is real).  The script turns resetDefaults
// into fppcapedetect -force-defaults, which is not run here.

test.skip(!container, 'stands in for the upgrade script inside the run-web.sh container');
// The vendor hosts are added to connect-src only once the player has the index.
test.use({ bypassCSP: true });

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';
const SCRIPT = '/opt/fpp/scripts/upgradeCapeFirmware';
const ARGS = '/tmp/fpp-tests-ucf-args';

let uiLevel = '0';
// The upgrade's done handler sets the reboot flag; put the settings back.
let restoreSettings: () => void = () => {};
test.beforeEach(async ({ request }) => {
  restoreSettings = snapshotSettings();
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  await request.put('/api/settings/uiLevel', { data: '1' });
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({
    id: 'FppTestsCape', name: 'fpp-tests cape', version: '1.0', serialNumber: 'SN0001', provides: ['strings'],
    vendor: { name: 'fpp-tests vendor' } }), CAPE_INFO);
  inPlayer('sh', '-c', `cp -p ${SCRIPT} ${SCRIPT}.fpp-tests && printf '#!/bin/sh\\necho "$*" > ${ARGS}\\necho stand-in upgrade done\\n' > ${SCRIPT} && chmod 755 ${SCRIPT} && rm -f ${ARGS}`);
});
test.afterEach(async ({ request }) => {
  inPlayer('sh', '-c', `mv ${SCRIPT}.fpp-tests ${SCRIPT}; rm -f ${ARGS} ${CAPE_INFO} /home/fpp/media/tmp/eepromVendors.json`);
  restoreSettings();
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function upgrade(page: Page, reset: boolean | null) {
  await page.route(/eepromVendors\.json/, (r) => r.fulfill({ json: { vendors: [] }, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-upgrade-tab').click();
  const box = page.locator('#resetDefaultsConfig');
  if (reset === null) {
    await expect(box, 'the box as the page opens').toBeChecked();
  } else {
    await box.setChecked(reset);
  }
  await page.locator('#firmware').setInputFiles({ name: 'fpp-tests.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(128, 0x41) });
  inPlayer('rm', '-f', ARGS);
  await page.locator('#UpdateFirmware').click();
  await expect.poll(() => inPlayer('sh', '-c', `cat ${ARGS} 2>/dev/null || true`).trim(), { timeout: 20_000 }).not.toBe('');
  return inPlayer('cat', ARGS).trim().split(/\s+/);
}

test('the EEPROM upgrade resets the configs to the new firmware\'s defaults unless told not to', async ({ page }) => {
  // Feature: 079c0b4de (#1458).  The upgrade dialog has a "Reset
  // configuration to defaults" box, ticked by default, which upgradeCapeFirmware.php
  // passes to the script as "resetDefaults"; cleared, the script is run
  // without it and the existing configs are kept.
  const ticked = await upgrade(page, null);
  expect(ticked, 'the script\'s arguments').toContain('resetDefaults');
  const cleared = await upgrade(page, false);
  expect(cleared, 'the script\'s arguments').not.toContain('resetDefaults');
  // The file it was given is the uploaded one, either way.
  expect(cleared[cleared.length - 1]).toMatch(/^\/tmp\//);
});
