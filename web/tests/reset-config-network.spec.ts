import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';

// Reset FPP Config keeps the network config in an area of its own.
//
// Regression: 2d58e0951 added the "Reset FPP Config" button to System
// settings; 314305250 moved the interface files out of the Configuration area
// into a Network area (resetting the config used to take the player off the
// network), and the Everything button leaves that area unchecked, as
// 387ffe16d did for the "all" list of the first version.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MEDIA = '/home/fpp/media';
const SAVED = '/tmp/fpp-tests-reset-network';
const NET = ['config/interface.eth0', 'config/leases.eth0'];
const MARKER = 'config/dhcpLeaseResetPending';
const CONFIG_FILE = 'config/gpio.json';

const present = (f: string) => inPlayer('sh', '-c', `test -e ${MEDIA}/${f} && echo y || echo n`).trim() === 'y';

let restoreSettings: () => void = () => {};
let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  restoreSettings = snapshotSettings();
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  inPlayer('sh', '-c', `rm -rf ${SAVED} && mkdir -p ${SAVED}/config && cd ${MEDIA} && ` +
    `for f in ${NET.join(' ')} ${CONFIG_FILE} ${MARKER}; do [ -e "$f" ] && cp -a "$f" "${SAVED}/$f"; done; true`);
  inPlayer('sh', '-c', `cd ${MEDIA} && echo 'iface' > ${NET[0]} && echo 'lease' > ${NET[1]} && echo '[]' > ${CONFIG_FILE}`);
});
test.afterEach(async ({ request }) => {
  restoreSettings();
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
  inPlayer('sh', '-c', `cd ${MEDIA} && rm -f ${NET.join(' ')} ${CONFIG_FILE} ${MARKER}; ` +
    `cp -a ${SAVED}/. ${MEDIA}/ 2>/dev/null; rm -rf ${SAVED}`);
});

test('resetting the Configuration area leaves the network files; the Network area removes them', async ({ request }) => {
  const cfg = await request.get('/resetConfig.php?areas=config');
  expect(await cfg.text()).toContain('Area: config');
  expect(present(CONFIG_FILE), 'the area did not run').toBe(false);
  for (const f of NET) expect(present(f), `${f} removed with the Configuration area`).toBe(true);

  const net = await request.get('/resetConfig.php?areas=network');
  expect(await net.text()).toContain('Area: network');
  for (const f of NET) expect(present(f), `${f} left behind`).toBe(false);
});

test('the Reset FPP Config dialog lists Network apart, and Everything does not check it', async ({ page, request }) => {
  await request.put('/api/settings/uiLevel', { data: '1' });
  await page.goto('/settings.php#settings-system');
  await page.locator('input[value="Reset FPP Config"]').click();
  const dialog = page.locator('#resetFPPDialog');
  await expect(dialog.locator('label[for="rc_network"]')).toHaveText('Network Config Files');
  await dialog.locator('#allButton').click();
  await expect(dialog.locator('#rc_config')).toBeChecked();
  await expect(dialog.locator('#rc_settings')).toBeChecked();
  await expect(dialog.locator('#rc_network')).not.toBeChecked();
});
