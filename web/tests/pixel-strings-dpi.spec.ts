import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Pixel Strings tab on a Raspberry Pi with a two-port DPIPixels hat, put
// where cape detection unpacks it (media/tmp/cape-info.json and
// media/tmp/strings), with the player claiming to be a Pi for the length of
// each test (config.php reads /etc/fpp/platform).  fppd, already running, is
// not affected: it reads the strings config only at start, and DPIPixels
// needs the Pi's DPI framebuffer.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsDPI.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-pixelStrings.json`;

const CAPE = {
  name: 'FppTestsDPI', longName: 'fpp-tests 2-port DPI hat', driver: 'DPIPixels', numSerial: 0,
  outputs: [{ pin: 'P1-7' }, { pin: 'P1-11' }],
  groups: [{ start: 1, count: 2 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsDPI', name: 'fpp-tests DPI', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

const vstring = (startChannel: number, pixelCount: number) => ({
  description: 'fpp-tests', startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
  nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
});

const config = (pixels0: number, pixels1: number) => ({ channelOutputs: [{
  type: 'DPIPixels', subType: 'FppTestsDPI', pinoutVersion: '1.x', enabled: 1, startChannel: 1, channelCount: -1,
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

const row = (page: Page, port: number) => page.locator(`#PixelString tr[id$="_Output_0_${port}_0"]`);

test('the max fps note gives DPIPixels\' exact ceiling for the longest string, and none for short ones', async ({ page }) => {
  // Feature: 6d9abbe1d.  DPIPixels sizes its framebuffer to the longest
  // string and runs any sequence rate up to the ceiling that sets: at 38.4MHz
  // and 1921 clocks a scanline, five channels a line plus 11 lines of reset
  // and blanking.  1600 pixels (4800 channels, 971 lines) allow 20 fps, 800
  // pixels 40; a 100-pixel string allows far more than any sequence asks.
  write(CONFIG, JSON.stringify(config(1600, 100)));
  await openStrings(page);
  const fps = page.locator('#pixelStringMaxFPS');
  await expect(fps).toHaveText('Runs up to 20 fps (longest port 1, 4800 ch)');
  await expect(fps).toHaveAttribute('title', /ceiling of 20 fps/);

  await row(page, 0).locator('input.vsPixelCount').fill('800');
  await row(page, 0).locator('input.vsPixelCount').dispatchEvent('change');
  await expect(fps).toHaveText('Runs up to 40 fps (longest port 1, 2400 ch)');

  await row(page, 0).locator('input.vsPixelCount').fill('50');
  await row(page, 0).locator('input.vsPixelCount').dispatchEvent('change');
  await expect(fps).toHaveText('String length is not a frame-rate limit (longest port 2, 300 ch)');
});
