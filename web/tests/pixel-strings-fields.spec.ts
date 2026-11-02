import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Editing the fields of the Pixel Strings tab (see pixel-strings-more.spec.ts,
// whose harness this repeats): on a BeagleBone with a four-port string cape.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsFields.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsFields', longName: 'fpp-tests 4-port string cape', numSerial: 0,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }, { pin: 'P8-12' }, { pin: 'P8-14' }],
  groups: [{ start: 1, count: 4 }],
};
// Any key but the FPP project's own ("fp") licenses every port.
const CAPE_INFO_JSON = {
  id: 'FppTestsFields', name: 'fpp-tests fields', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

function stringsConfig(strings: { pixelCount: number; groupCount?: number }[]) {
  return {
    channelOutputs: [{
      type: 'BBB48String', subType: 'FppTestsFields', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: strings.length,
      outputs: strings.map((s, i) => ({
        portNumber: i, protocol: 'ws2811', differentialType: 0,
        virtualStrings: [{
          description: `s${i}`, startChannel: 1 + i * 100, pixelCount: s.pixelCount, groupCount: s.groupCount ?? 0,
          reverse: 0, colorOrder: 'RGB', nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
        }],
      })),
    }],
  };
}

function writeFile(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}
function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG]) saved[p] = readFile(p);
  writeFile(PLATFORM, 'BeagleBone Black');
  writeFile(CAPE_FILE, JSON.stringify(CAPE));
  writeFile(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else writeFile(p, content);
  }
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}

const row = (page: Page, port: number) => page.locator(`#PixelString tr[id$="_Output_0_${port}_0"]`);

test('the end channel is a whole number when the group count does not divide the pixels, and fraction keys are swallowed', async ({ page }) => {
  // Regression: 3d7a1e369.  Ten RGB pixels in groups of four ended 7.5
  // channels past the start (30 / 4) when edited; the last, partial group
  // still takes a whole set of channels, so the string ends 9 past it.  The
  // number fields also took "." and "e", which fed such fractions in.
  writeFile(CONFIG, JSON.stringify(stringsConfig([{ pixelCount: 10, groupCount: 4 }, { pixelCount: 10, groupCount: 3 }])));
  await openStrings(page);
  const end = (port: number) => row(page, port).locator('.vsEndChannel');
  const start = async (port: number) => Number(await row(page, port).locator('input.vsStartChannel').inputValue());

  const pixels = row(page, 0).locator('input.vsPixelCount');
  const s0 = await start(0);
  await pixels.fill('11');
  await pixels.dispatchEvent('change');
  await expect(end(0), 'eleven pixels in groups of four are three sets').toHaveText(String(s0 + 9 - 1));
  await pixels.fill('13');
  await pixels.dispatchEvent('change');
  await expect(end(0), 'thirteen pixels are four sets').toHaveText(String(s0 + 12 - 1));
  await pixels.fill('10');
  await pixels.dispatchEvent('change');
  await expect(end(0), 'ten pixels are three sets').toHaveText(String(s0 + 9 - 1));

  await pixels.fill('20');
  for (const key of ['.', 'e', '-', '+']) {
    await pixels.press(key);
  }
  await expect(pixels, 'no character but a digit goes in').toHaveValue('20');
  for (const input of ['input.vsStartChannel', 'input.vsGroupCount', 'input.vsStartNulls', 'input.vsEndNulls', 'input.vsZigZag']) {
    const field = row(page, 0).locator(input);
    const before = await field.inputValue();
    await field.press('.');
    await expect(field, `${input} swallows a decimal point`).toHaveValue(before);
  }
});

test('the end channel as first drawn from a saved config is a whole number too', async ({ page }) => {
  // Regression: 3d7a1e369 (master bug).  The commit made the edit path round
  // the last partial group up, but the first draw of a row divided plainly,
  // so ten RGB pixels in groups of four opened at 8.5.  Now it rounds up, like
  // the edit path, and an empty string ends at 0.
  writeFile(CONFIG, JSON.stringify(stringsConfig([
    { pixelCount: 10, groupCount: 4 }, { pixelCount: 0 }, { pixelCount: 12, groupCount: 4 }, { pixelCount: 10 },
  ])));
  await openStrings(page);
  const start = async (p: number) => Number(await row(page, p).locator('input.vsStartChannel').inputValue());
  const end = (p: number) => row(page, p).locator('.vsEndChannel');
  await expect(end(0)).toHaveText(String((await start(0)) + 9 - 1));    // 3 nodes of 3 channels
  await expect(end(1), 'no pixels, no end channel').toHaveText('0');
  await expect(end(2), 'an exact multiple is unchanged').toHaveText(String((await start(2)) + 9 - 1));
  await expect(end(3)).toHaveText(String((await start(3)) + 30 - 1));
  // As drawn is what editing gives.
  await row(page, 0).locator('input.vsPixelCount').fill('10');
  await row(page, 0).locator('input.vsPixelCount').dispatchEvent('change');
  await expect(end(0)).toHaveText(String((await start(0)) + 9 - 1));
});

test('Clone String can copy upward when the entered count is negative', async ({ page }) => {
  // Regression: 5abcce30a.  Clone String only went down the table; a negative
  // count now copies the selected string onto the rows above it, and a zero
  // count does nothing.
  writeFile(CONFIG, JSON.stringify(stringsConfig([{ pixelCount: 10 }, { pixelCount: 10 }, { pixelCount: 10 }, { pixelCount: 77 }])));
  let answer = '-2';
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(answer) : d.accept()));
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  const count = (port: number) => row(page, port).locator('input.vsPixelCount');
  const clone = async (port: number) => {
    await row(page, port).locator('td.vsPortLabel').dispatchEvent('mousedown');
    await page.locator('#cloneStringButton').click();
  };

  answer = '0';
  await clone(3);
  await expect(count(2), 'zero copies nothing').toHaveValue('10');

  answer = '-2';
  await clone(3);
  await expect(count(2)).toHaveValue('77');
  await expect(count(1)).toHaveValue('77');
  await expect(count(0), 'only the two rows asked for').toHaveValue('10');
  await expect(count(3)).toHaveValue('77');
});
