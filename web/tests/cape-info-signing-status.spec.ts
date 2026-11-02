import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Signature tab of the Cape Info page opens with one line on where the
// cape stands: which driver it uses, whether its EEPROM is signed, and with
// what.  It is worked out from media/tmp/cape-info.json and the strings
// config, both seeded here.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const PIXEL_STRINGS = `${MEDIA}/config/co-pixelStrings.json`;

function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}
function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', 'sh', path, content);
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => { saved = {}; for (const p of [CAPE_INFO, PIXEL_STRINGS]) saved[p] = read(p); });
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

const cape = (extra: Record<string, unknown> = {}) => JSON.stringify({
  id: 'FppTestsHat', name: 'fpp-tests hat', version: '1.0', serialNumber: 'SN0001', ...extra });

async function status(page: any) {
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-signature-tab').click();
  return page.locator('#eeprom-signature');
}

test('a cape on no driver that needs signing says so, and how to put it right', async ({ page }) => {
  // Regression: 9392eaeed ("Add more info for when a cape doesn't need
  // signing").  A cape whose strings use no licensed driver got no status
  // line at all.  Also e85a21117: the line goes on to say a cape that should
  // be on one is put right by re-saving the string configs.
  write(CAPE_INFO, cape({ provides: ['strings'] }));
  write(PIXEL_STRINGS, JSON.stringify({ channelOutputs: [] }));
  const pane = await status(page);
  await expect(pane).toContainText('This cape is not using any Channel Output drivers which need a signed EEPROM.');
  await expect(pane).toContainText('go to the Pixel Strings config page and re-save the string configs');
});

test('a cape signed with a vendor\'s own key is licensed for all its outputs', async ({ page }) => {
  // Regression: 9392eaeed.  A cape signed with a key other than FPP's own
  // ("fp") is licensed by its vendor for every output, and the line said
  // only which key had signed it.
  write(CAPE_INFO, cape({ provides: ['strings'], verifiedKeyId: 'fpp-tests-vendor' }));
  write(PIXEL_STRINGS, JSON.stringify({ channelOutputs: [{ type: 'DPIPixels', enabled: 1, startChannel: 1, channelCount: -1, outputs: [] }] }));
  const pane = await status(page);
  // The control: the cape is seen as signed, on the driver seeded.
  await expect(pane).toContainText("Cape EEPROM is signed using the 'fpp-tests-vendor' key and uses the DPIPixels Channel Output driver.");
  await expect(pane).toContainText("This cape is licensed for it's full set of outputs.");
});
