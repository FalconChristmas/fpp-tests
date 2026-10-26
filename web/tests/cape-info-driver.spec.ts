import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Cape Info page's "This cape uses the ... Channel Output driver", which
// it reads from the strings config.  The cape is put where cape detection
// unpacks it from the EEPROM (media/tmp/cape-info.json).

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const BBB_STRINGS = `${MEDIA}/config/co-bbbStrings.json`;
const PIXEL_STRINGS = `${MEDIA}/config/co-pixelStrings.json`;

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
  for (const p of [CAPE_INFO, BBB_STRINGS, PIXEL_STRINGS]) saved[p] = read(p);
  write(CAPE_INFO, JSON.stringify({ id: 'FppTestsHat', name: 'fpp-tests string hat', version: '1.0', serialNumber: 'SN0001',
                                    provides: ['strings'] }));
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

test('a non-Beagle player names the driver from its own strings config, not a stale BeagleBone one', async ({ page, request }) => {
  // Regression: 49cfdf618.  cape-info.php took co-bbbStrings.json whenever
  // it existed, so a Pi (here, any non-Beagle player) with one left behind
  // by another controller claimed to run BBB48String.  It now reads the
  // platform's own file, as fppd's CapeUtils does.
  expect((await (await request.get('/api/system/info')).json()).Platform).not.toMatch(/Beagle/);
  write(BBB_STRINGS, JSON.stringify(strings('BBB48String')));
  write(PIXEL_STRINGS, JSON.stringify(strings('DPIPixels')));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).toContainText('the DPIPixels Channel Output driver');
  await expect(page.locator('body')).not.toContainText('BBB48String');
});
