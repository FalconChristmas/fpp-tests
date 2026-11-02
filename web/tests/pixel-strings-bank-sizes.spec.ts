import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// A string cape whose outputs share pixel counts in banks (a bank slider
// splits the cape's limit between them) on the Pixel Strings tab: the sizes
// the slider starts at, and that moving it saves them.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsBanks.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;
const SETTINGS = `${MEDIA}/settings`;

const CAPE = {
  name: 'FppTestsBanks', longName: 'fpp-tests banked cape', numSerial: 0,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }, { pin: 'P8-12' }, { pin: 'P8-14' }],
  groups: [{ start: 1, count: 4, type: 'single' }],
  pixelLimits: [{ type: 'banks', limit: 101, banks: [[0, 1], [2, 3]] }],
};
// a key other than 'fp' licenses every output, which the banks need
const CAPE_INFO_JSON = {
  id: 'FppTestsBanks', name: 'fpp-tests banks', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

function stringsConfig() {
  const port = (portNumber: number) => ({
    portNumber, protocol: 'ws2811', differentialType: 0,
    virtualStrings: [{
      description: `s${portNumber}`, startChannel: 1 + portNumber * 30, pixelCount: 10, groupCount: 0, reverse: 0,
      colorOrder: 'RGB', nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
    }],
  });
  return {
    channelOutputs: [{
      type: 'BBB48String', subType: 'FppTestsBanks', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: 4, outputs: [0, 1, 2, 3].map(port),
    }],
  };
}

function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; base64 "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}
function putBack(path: string, b64: string | null) {
  if (b64 === null) inPlayer('rm', '-f', path);
  else inPlayer('sh', '-c', 'echo "$2" | base64 -d > "$1" && chmod 666 "$1"', 'sh', path, b64);
}
function writeFile(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 666 "$1"', 'sh', path, content);
}
function setting(name: string): string | null {
  const line = inPlayer('sh', '-c', `grep -E '^${name} *=' ${SETTINGS} || true`).trim();
  const m = line.match(/=\s*"?([^"]*)"?$/);
  return m ? m[1] : null;
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG, SETTINGS]) saved[p] = readFile(p);
  writeFile(PLATFORM, 'BeagleBone Black');
  writeFile(CAPE_FILE, JSON.stringify(CAPE));
  writeFile(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
  writeFile(CONFIG, JSON.stringify(stringsConfig()));
  inPlayer('sh', '-c', `sed -i '/^bank[0-9]Size *=/d' ${SETTINGS}`);
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) putBack(p, content);
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  await expect(page.locator('#bankSliderDiv')).toBeVisible();
}

test('the bank slider starts at the largest string of each bank when no sizes were saved', async ({ page }) => {
  // Feature: e323b9cd3 (the baseline it kept).  Every string is 10 pixels.
  await openStrings(page);
  await expect(page.locator('#bank1Size')).toHaveText('10');
  await expect(page.locator('#bank2Size')).toHaveText('10');
});

test('saved bank sizes are what the slider starts at, not the strings\' pixel counts', async ({ page }) => {
  // Regression: e323b9cd3.  The sizes were worked out from the strings on
  // every load, so a bank sized larger than its strings (room to grow)
  // snapped back to the strings' own size.
  writeFile(SETTINGS, (readFile(SETTINGS) ? Buffer.from(readFile(SETTINGS)!, 'base64').toString() : '')
    + 'bank1Size = "40"\nbank2Size = "25"\n');
  await openStrings(page);
  await expect(page.locator('#bank1Size')).toHaveText('40');
  await expect(page.locator('#bank2Size')).toHaveText('25');
});

test('moving the bank slider saves the new sizes', async ({ page }) => {
  // Regression: e323b9cd3.  Nothing saved the sizes the slider was moved to.
  await openStrings(page);
  const handle = page.locator('#bankSlider .ui-slider-handle');
  await handle.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(() => setting('bank1Size'), { timeout: 10_000 }).toBe('15');
  expect(setting('bank2Size')).toBe('85');
});
