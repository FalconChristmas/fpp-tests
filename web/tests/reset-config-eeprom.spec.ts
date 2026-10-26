import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';

// Reset FPP Config's EEPROM / String Config area (System settings), and the
// warning that sends people to it.  The receiving end of a reset is what is
// left on disk for the next boot's cape detection to read.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const GONE = ['config/cape-eeprom.bin', 'config/co-pixelStrings.json', 'config/co-bbbStrings.json', 'tmp/cape-info.json'];
const KEPT = 'config/co-other.json';

const exists = (rel: string) => inPlayer('sh', '-c', `test -e '${MEDIA}/${rel}' && echo y || echo n`).trim() === 'y';

let saved: Record<string, string | null> = {};
let uiLevel = '0';
// The reset sets the reboot flag in the settings file; put it back.
let restoreSettings: () => void = () => {};
test.beforeEach(async ({ request }) => {
  restoreSettings = snapshotSettings();
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  saved = {};
  for (const rel of [...GONE, KEPT]) {
    saved[rel] = exists(rel) ? inPlayer('base64', '-w0', `${MEDIA}/${rel}`) : null;
  }
});
test.afterEach(async ({ request }) => {
  restoreSettings();
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
  for (const [rel, b64] of Object.entries(saved)) {
    if (b64 === null) inPlayer('rm', '-f', `${MEDIA}/${rel}`);
    else inPlayer('sh', '-c', `echo '${b64}' | base64 -d > '${MEDIA}/${rel}'`);
  }
});

test('the EEPROM / String Config area removes the cape EEPROM and string configs, and nothing else', async ({ page, request }) => {
  // Feature: 7cc716515 (#2426).  A string config left behind for a cape that
  // is no longer fitted (warning 13) is cleared from Reset FPP Config: the
  // virtual EEPROM, both strings configs and the cape-info cape detection
  // published from them.
  for (const rel of GONE) inPlayer('sh', '-c', `mkdir -p '${MEDIA}/$(dirname ${rel})' && echo '{}' > '${MEDIA}/${rel}'`);
  inPlayer('sh', '-c', `echo '{"channelOutputs": []}' > '${MEDIA}/${KEPT}'`);

  // The Reset FPP Config button is an Advanced setting.
  await request.put('/api/settings/uiLevel', { data: '1' });
  page.on('dialog', (d) => d.accept());
  await page.goto('/settings.php#settings-system');
  await page.locator('input[value="Reset FPP Config"]').click();
  const dialog = page.locator('#resetFPPDialog');
  await expect(dialog.locator('#rc_eeprom')).toBeVisible();
  await expect(dialog.locator('label[for="rc_eeprom"]')).toHaveText('EEPROM / String Config');
  await dialog.locator('#noneButton').click();
  await dialog.locator('#rc_eeprom').check();
  await dialog.locator('button', { hasText: /^Reset$/ }).click();
  await expect(page.locator('#resetConfigText')).toHaveValue(/Area: eeprom/, { timeout: 30_000 });

  for (const rel of GONE) expect(exists(rel), rel).toBe(false);
  expect(exists(KEPT), `${KEPT}, another area's`).toBe(true);
});

test('warning 13 has a help page that points at the reset', async ({ request }) => {
  // Feature: 7cc716515.  The string outputs raise the "configuration
  // references missing hardware" warning with id 13, whose definition links
  // a help page naming the EEPROM / String Config reset.
  const defs = await (await request.get('/warnings-definitions.json')).json();
  const list = (Array.isArray(defs) ? defs : defs.warnings ?? Object.values(defs).flat()) as any[];
  const w13 = list.find((w) => w.id === 13);
  expect(w13, JSON.stringify(list.map((w) => w.id))).toMatchObject({ HelpPageType: 'md' });
  const help = await request.get('/help/warning-helpers/warning-13.md');
  expect(help.status()).toBe(200);
  expect(await help.text()).toMatch(/EEPROM \/ String Config/);
});
