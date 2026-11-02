import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// What the Pixel Strings tab on a Raspberry Pi offers by output driver: the 4
// channel colour orders and the Testing control. The player has a two-port hat, put
// where cape detection unpacks it (media/tmp/cape-info.json and
// media/tmp/strings), with the player claiming to be a Pi for the length of
// each test (config.php reads /etc/fpp/platform).  fppd, already running, is
// not affected: it reads the strings config only at start, and DPIPixels
// needs the Pi's DPI framebuffer.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsDrv.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-pixelStrings.json`;

const CAPE = {
  name: 'FppTestsDrv', longName: 'fpp-tests 2-port DPI hat', driver: 'DPIPixels', numSerial: 0,
  outputs: [{ pin: 'P1-7' }, { pin: 'P1-11' }],
  groups: [{ start: 1, count: 2 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsDrv', name: 'fpp-tests DPI', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

const vstring = (startChannel: number, pixelCount: number) => ({
  description: 'fpp-tests', startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
  nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
});

const config = (pixels0: number, pixels1: number) => ({ channelOutputs: [{
  type: 'DPIPixels', subType: 'FppTestsDrv', pinoutVersion: '1.x', enabled: 1, startChannel: 1, channelCount: -1,
  outputCount: 2, outputs: [
    { portNumber: 0, protocol: 'ws2811', virtualStrings: [vstring(0, pixels0)] },
    { portNumber: 1, protocol: 'ws2811', virtualStrings: [vstring(pixels0 * 3, pixels1)] }],
}] });

function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}
function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG]) saved[p] = read(p);
  write(PLATFORM, 'Raspberry Pi');
  write(CAPE_FILE, JSON.stringify(CAPE));
  write(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}


const withDriver = (driver: string) => write(CAPE_FILE, JSON.stringify({ ...CAPE, driver }));

const firstOrderOptions = async (page: Page) =>
  page.locator('#PixelString select.vsColorOrder').first().locator('option').allTextContents();

test('a DPIPixels cape offers the 4 channel colour orders and the Testing control', async ({ page }) => {
  // Regression: 5695b0847.  DPIPixels became channel based to drive 4
  // channel (RGBW) pixels, so its color order list gains the RGBW and WRGB
  // families; 8f0a7d08d added its per-port Testing control.
  write(CONFIG, JSON.stringify(config(10, 10)));
  await openStrings(page);
  const options = await firstOrderOptions(page);
  expect(options).toEqual(expect.arrayContaining(['RGB', 'RGBW', 'GRBW', 'WRGB']));
  await expect(page.locator('#PixelTestPatternDiv')).toBeVisible();
});

test('a cape whose driver is not channel based offers only the 3 channel orders and no Testing control', async ({ page }) => {
  // The control for the spec above, on the same page and platform: the
  // drivers the page does not know to be channel based keep the six RGB
  // orders and have no Testing control.
  withDriver('SomeOtherDriver');
  write(CONFIG, JSON.stringify(config(10, 10)));
  await openStrings(page);
  const options = await firstOrderOptions(page);
  expect(options).toEqual(expect.arrayContaining(['RGB', 'BRG']));
  expect(options.filter((o) => o.includes('W'))).toEqual([]);
  await expect(page.locator('#PixelTestPatternDiv')).toBeHidden();
});
