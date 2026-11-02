import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Cape Info page names a BBShiftString cape's Channel Output driver and
// says what its EEPROM licenses, as it does for BBB48String and DPIPixels.
// The cape is put where cape detection unpacks it from the EEPROM
// (media/tmp/cape-info.json) and the driver where the page reads it (the
// strings config; this player is not a BeagleBone, so co-pixelStrings.json).

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const PIXEL_STRINGS = `${MEDIA}/config/co-pixelStrings.json`;
const BBB_STRINGS = `${MEDIA}/config/co-bbbStrings.json`;

const strings = (type: string) => ({ channelOutputs: [{ type, enabled: 1, startChannel: 1, channelCount: -1, outputs: [] }] });

function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}
function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', 'sh', path, content);
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [CAPE_INFO, PIXEL_STRINGS, BBB_STRINGS]) saved[p] = read(p);
  inPlayer('rm', '-f', BBB_STRINGS);
  write(CAPE_INFO, JSON.stringify({ id: 'FppTestsHat', name: 'fpp-tests string hat', version: '1.0', serialNumber: 'SN0001',
                                    provides: ['strings'] }));
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

test('a cape with a BBShiftString strings config is shown with its driver and licence', async ({ page }) => {
  // Regression: 84c1e770e.  The page only recognised BBB48String and
  // DPIPixels, so a BBShiftString cape had no mention of the
  // driver and no Licensed Outputs row.
  write(PIXEL_STRINGS, JSON.stringify(strings('BBShiftString')));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).toContainText('the BBShiftString Channel Output driver');
  await expect(page.locator('body')).toContainText(/Output.Driver:\s*BBShiftString/);
  await expect(page.locator('td', { hasText: /^None, cape EEPROM is not signed\.$/ })).toHaveCount(1);

  // The control: a driver the page doesn't know says nothing of the sort.
  write(PIXEL_STRINGS, JSON.stringify(strings('SomeOtherDriver')));
  await page.goto('/cape-info.php?fpp-tests=other');
  await expect(page.locator('body')).not.toContainText(/Output.Driver:/);
  await expect(page.locator('td', { hasText: /^None, cape EEPROM is not signed\.$/ })).toHaveCount(0);
});

test('a signed BBShiftString cape shows its licence', async ({ page }) => {
  // Regression: 84c1e770e.  Licensed Outputs was worked out for the other
  // two drivers only.
  write(PIXEL_STRINGS, JSON.stringify(strings('BBShiftString')));
  write(CAPE_INFO, JSON.stringify({ id: 'FppTestsHat', name: 'fpp-tests string hat', version: '1.0', serialNumber: 'SN0001',
                                    provides: ['strings'], verifiedKeyId: 'fp', signed: { licensePorts: 16 } }));
  await page.goto('/cape-info.php');
  await expect(page.locator('td', { hasText: /^16 \('fp' key\)$/ })).toHaveCount(1);
});
