import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The About tab's rows on the Cape Info page that come from the cape's
// signature: how many outputs it licenses, and whether its EEPROM is a
// chip or a file.  The cape is put where cape detection unpacks it from the
// EEPROM (media/tmp/cape-info.json), with a DPIPixels strings config so the
// page has a pixel driver to speak of.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const BBB_STRINGS = `${MEDIA}/config/co-bbbStrings.json`;
const PIXEL_STRINGS = `${MEDIA}/config/co-pixelStrings.json`;

function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}
function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', 'sh', path, content);
}
const cape = (extra: object = {}) => ({ id: 'FppTestsHat', name: 'fpp-tests string hat', version: '1.0',
  serialNumber: 'SN0001', provides: ['strings'], ...extra });

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [CAPE_INFO, BBB_STRINGS, PIXEL_STRINGS]) saved[p] = read(p);
  const strings = JSON.stringify({ channelOutputs: [{ type: 'DPIPixels', enabled: 1, startChannel: 1, channelCount: -1, outputs: [] }] });
  write(BBB_STRINGS, strings);
  write(PIXEL_STRINGS, strings);
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

const row = (page: import('@playwright/test').Page, label: string) =>
  page.locator(`xpath=//tr[td/b[contains(., '${label}')]]`);

test('the licensed output count is drawn from the key that signed the cape', async ({ page }) => {
  // Feature: efed6030f.  An 'fp' key licenses the number of ports its
  // signature says; any other key licenses all of them; an unsigned cape
  // none.
  write(CAPE_INFO, JSON.stringify(cape({ verifiedKeyId: 'fp', signed: { licensePorts: '24' } })));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).toContainText("24 ('fp' key)");
  write(CAPE_INFO, JSON.stringify(cape({ verifiedKeyId: 'fp' })));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).toContainText('Unknown, licensePorts setting does not exist');
  write(CAPE_INFO, JSON.stringify(cape({ verifiedKeyId: 'ab' })));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).toContainText("Unlimited ('ab' key)");
  write(CAPE_INFO, JSON.stringify(cape()));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).toContainText('None, cape EEPROM is not signed.');
});

test('the EEPROM location row says Physical or File, and warns when the flag disagrees', async ({ page }) => {
  // Feature: 4e81a1706 (the location row) and 9392eaeed.  An unsigned cape's
  // EEPROM read from a chip is Physical, from cape-eeprom.bin is File, and
  // an image whose location flag doesn't match where it was read says so.
  write(CAPE_INFO, JSON.stringify(cape({ eepromLocation: '/sys/bus/i2c/devices/1-0050/eeprom' })));
  await page.goto('/cape-info.php');
  await expect(row(page, 'EEPROM')).toContainText('Physical');
  await expect(page.locator('body')).not.toContainText('Location flag specified');
  write(CAPE_INFO, JSON.stringify(cape({ eepromLocation: '/home/fpp/media/config/cape-eeprom.bin' })));
  await page.goto('/cape-info.php');
  await expect(row(page, 'EEPROM')).toContainText('File');
  write(CAPE_INFO, JSON.stringify(cape({ eepromLocation: '/home/fpp/media/config/cape-eeprom.bin',
    validEepromLocation: false })));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).toContainText('Location flag specified in EEPROM');
});
