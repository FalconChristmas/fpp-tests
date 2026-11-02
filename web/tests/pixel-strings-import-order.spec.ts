import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Import Strings on the Pixel Strings tab, from an uploaded xLights layout.
// Set up as pixel-strings-page.spec.ts does: the player claims to be a
// BeagleBone with a two-port string cape.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsStrings.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;
const XML = `${MEDIA}/upload/xlights_rgbeffects.xml`;

const CAPE = {
  name: 'FppTestsStrings', longName: 'fpp-tests 2-port string cape', numSerial: 0,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }], groups: [{ start: 1, count: 2 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsStrings', name: 'fpp-tests strings', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};
const vs = () => ({
  description: '', startChannel: 0, pixelCount: 0, groupCount: 0, reverse: 0, colorOrder: 'RGB',
  nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
});
const CONFIG_JSON = {
  channelOutputs: [{
    type: 'BBB48String', subType: 'FppTestsStrings', pinoutVersion: '1.x', enabled: 1,
    startChannel: 1, channelCount: -1, outputCount: 2,
    outputs: [
      { portNumber: 0, protocol: 'ws2811', differentialType: 0, virtualStrings: [vs()] },
      { portNumber: 1, protocol: 'ws2811', differentialType: 0, virtualStrings: [vs()] },
    ],
  }],
};

const write = (path: string, content: string) =>
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
const read = (path: string): string | null => {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
};
const putBack = (path: string, c: string | null) => (c === null ? inPlayer('rm', '-f', path) : write(path, c));

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG, XML]) saved[p] = read(p);
  write(PLATFORM, 'BeagleBone Black');
  write(CAPE_FILE, JSON.stringify(CAPE));
  write(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
  write(CONFIG, JSON.stringify(CONFIG_JSON));
});
test.afterEach(() => {
  for (const [p, c] of Object.entries(saved)) putBack(p, c);
});

const row = (page: Page, port: number, str = 0) => page.locator(`#PixelString tr[id$="_Output_0_${port}_${str}"]`);

test('Import Strings fills a port in ascending start channel order, not layout order', async ({ page }) => {
  // Regression: e79e5e3d2.  Models were imported in the order the layout file
  // lists them, so with two on one port the later start channel took the
  // port's first string.  They are sorted by start channel first.
  write(XML, `<?xml version="1.0" encoding="UTF-8"?>
<xrgb><models>
<model name="fpp-tests late" DisplayAs="Tree" Tree="Tree" TreeDegrees="360" StringCount="1" NodesPerString="20" StartChannel="301">
  <ControllerConnection Port="1" Protocol="ws2811"/></model>
<model name="fpp-tests early" DisplayAs="Tree" Tree="Tree" TreeDegrees="360" StringCount="1" NodesPerString="10" StartChannel="1">
  <ControllerConnection Port="1" Protocol="ws2811"/></model>
<model name="fpp-tests middle" DisplayAs="Tree" Tree="Tree" TreeDegrees="360" StringCount="1" NodesPerString="15" StartChannel="151">
  <ControllerConnection Port="1" Protocol="ws2811"/></model>
</models></xrgb>`);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  await page.locator('#stringTab input[value="Import Strings"]').click();
  const got: string[] = [];
  for (let s = 0; s < 3; s++) {
    await expect(row(page, 0, s).locator('input.vsPixelCount')).not.toHaveValue('0');
    got.push(await row(page, 0, s).locator('input.vsDescription').inputValue() + '@' +
      await row(page, 0, s).locator('input.vsStartChannel').inputValue());
  }
  expect(got).toEqual(['fpp-tests early@1', 'fpp-tests middle@151', 'fpp-tests late@301']);
});
