import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Small fixes on the Pixel Strings tab of Channel Outputs, each on the
// cape it needs: the player claims to be a BeagleBone or a Pi for the length
// of each test (config.php reads /etc/fpp/platform), the cape is put where
// cape detection unpacks it from the EEPROM (media/tmp/cape-info.json and
// media/tmp/strings), and the string config is written where the page loads
// it from.  fppd, already running, is not affected: it reads the string
// config only at start.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsUi.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const BBB_CONFIG = `${MEDIA}/config/co-bbbStrings.json`;
const PI_CONFIG = `${MEDIA}/config/co-pixelStrings.json`;

// Any key but the FPP project's own ("fp") licenses every port.
const SIGNED = {
  id: 'FppTestsUi', name: 'fpp-tests ui', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

const vstring = (description: string, startChannel: number, pixelCount: number, extra: Record<string, unknown> = {}) => ({
  description, startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
  nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0', ...extra,
});

// One string per port, from [description, startChannel, pixelCount, extra].
function config(type: string, strings: [string, number, number, Record<string, unknown>?][]) {
  return {
    channelOutputs: [{
      type, subType: 'FppTestsUi', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: strings.length,
      outputs: strings.map(([d, s, n, x], i) => ({
        portNumber: i, protocol: 'ws2811', differentialType: 0, virtualStrings: [vstring(d, s, n, x)],
      })),
    }],
  };
}
const bbCape = (ports: number, extra: Record<string, unknown> = {}) => ({
  name: 'FppTestsUi', longName: 'fpp-tests string cape', numSerial: 0,
  outputs: Array.from({ length: ports }, (_, i) => ({ pin: `P8-${String(8 + 2 * i).padStart(2, '0')}` })),
  groups: [{ start: 1, count: ports, type: 'single' }], ...extra,
});

function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 666 "$1"', 'sh', path, content);
}
function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; base64 "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let saved: Record<string, string | null> = {};
let putSettingsBack: () => void;
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, BBB_CONFIG, PI_CONFIG]) saved[p] = read(p);
  putSettingsBack = snapshotSettings();
  write(CAPE_INFO, JSON.stringify(SIGNED));
});
test.afterEach(() => {
  for (const [p, b64] of Object.entries(saved)) {
    if (b64 === null) inPlayer('rm', '-f', p);
    else inPlayer('sh', '-c', 'echo "$2" | base64 -d > "$1" && chmod 666 "$1"', 'sh', p, b64);
  }
  putSettingsBack();
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '3' : undefined));
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}

const row = (page: Page, port: number) => page.locator(`#PixelString tr[id$="_Output_0_${port}_0"]`);

test('pixel counts over a bank\'s size are flagged as errors on the strings that exceed it', async ({ page }) => {
  // Regression: 8f4d934cb.  The bank check marked the offending strings'
  // pixel counts through ncNodes, a variable that does not exist (the list
  // is pcNodes), so the check died with a script error before it marked
  // anything: the warning was never shown.
  write(PLATFORM, 'BeagleBone Black');
  write(CAPE_FILE, JSON.stringify(bbCape(4, { pixelLimits: [{ type: 'banks', limit: 101, banks: [[0, 1], [2, 3]] }] })));
  write(BBB_CONFIG, JSON.stringify(config('BBB48String', [['a', 1, 10], ['b', 31, 10], ['c', 61, 10], ['d', 91, 10]])));
  // Bank 1 sized below its strings (10 pixels each); bank 2 holds its own.
  setSettingInFile('bank1Size', '5');
  setSettingInFile('bank2Size', '40');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openStrings(page);
  await expect(page.locator('#bank1Size')).toHaveText('5');
  await expect(row(page, 0).locator('input.vsPixelCount')).toHaveClass(/inputError/);
  await expect(row(page, 1).locator('input.vsPixelCount')).toHaveClass(/inputError/);
  await expect(row(page, 0).locator('input.vsPixelCount'))
    .toHaveAttribute('data-bs-original-title', /exceeds the bank size/);
  // The control: the other bank's strings fit.
  await expect(row(page, 2).locator('input.vsPixelCount')).not.toHaveClass(/inputError/);
  await expect(row(page, 3).locator('input.vsPixelCount')).not.toHaveClass(/inputError/);
  expect(errors).toEqual([]);
});

test('the View Cape Warnings link is shown on load when the licence warning was hidden', async ({ page }) => {
  // Regression: b37ad4760.  A cape licensed for fewer outputs than it has
  // shows its warning box; hiding the box leaves a "View Cape Warnings" link
  // to bring it back.  On a later load with the warning hidden the page did
  // nothing, so neither the box nor the link was there.
  write(PLATFORM, 'BeagleBone Black');
  write(CAPE_FILE, JSON.stringify(bbCape(2)));
  // Signed by the project's own key, which licenses no port.
  write(CAPE_INFO, JSON.stringify({ ...SIGNED, verifiedKeyId: 'fp' }));
  write(BBB_CONFIG, JSON.stringify(config('BBB48String', [['a', 1, 50], ['b', 151, 50]])));
  const box = page.locator('#capeWarningsDiv');
  const link = page.locator('#capeWarningsSpan');

  setSettingInFile('HideLicenseWarning', '1');
  await openStrings(page);
  await expect(link).toBeVisible();
  await expect(box).toBeHidden();

  // The control: not hidden, the box shows and the link does not.
  setSettingInFile('HideLicenseWarning', '0');
  await page.goto('/channeloutputs.php?shown');
  await page.locator('#stringTab-tab').click();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(link).toBeHidden();
});

test('a DPI port\'s power estimate counts the end nulls\' idle draw', async ({ page }) => {
  // Regression: c9f8cc373.  The port's details (the tooltip on its label)
  // add up the current of its pixels at full brightness, 60 mA each.  Off and
  // null pixels draw 2 mA, which was left out.  100 pixels and 100 end nulls
  // come to 6 A + 200 * 2 mA = 6.4 A; 100 pixels alone, 6.2 A (the idle draw
  // of the pixels themselves); without any idle draw both read 6 A.
  write(PLATFORM, 'Raspberry Pi');
  write(CAPE_FILE, JSON.stringify({
    name: 'FppTestsUi', longName: 'fpp-tests 2-port DPI hat', driver: 'DPIPixels', numSerial: 0,
    outputs: [{ pin: 'P1-7' }, { pin: 'P1-11' }], groups: [{ start: 1, count: 2 }],
  }));
  write(PI_CONFIG, JSON.stringify(config('DPIPixels', [['a', 0, 100, { endNulls: 100 }], ['b', 300, 100]])));
  await openStrings(page);
  const detail = (port: number) => row(page, port).locator('td.vsPortLabel')
    .evaluate((e) => e.getAttribute('data-bs-original-title') || '');
  await expect.poll(() => detail(0), { timeout: 10_000 }).toContain('200 pixels');
  expect(await detail(0)).toContain(', 6.4 A max');
  // The control: no nulls.
  expect(await detail(1)).toContain('100 pixels');
  expect(await detail(1)).toContain(', 6.2 A max');
});

test('a DPI port\'s pixel count and power estimate count its start nulls', async ({ page }) => {
  // Regression: the port details read the start nulls from .vsNullNodes, a
  // class no row has (the field is .vsStartNulls), so they were never counted.
  // 100 pixels and 50 start nulls come to 150 pixels and 6 A + 150 * 2 mA = 6.3 A.
  write(PLATFORM, 'Raspberry Pi');
  write(CAPE_FILE, JSON.stringify({
    name: 'FppTestsUi', longName: 'fpp-tests 2-port DPI hat', driver: 'DPIPixels', numSerial: 0,
    outputs: [{ pin: 'P1-7' }, { pin: 'P1-11' }], groups: [{ start: 1, count: 2 }],
  }));
  write(PI_CONFIG, JSON.stringify(config('DPIPixels', [['a', 0, 100, { nullNodes: 50 }], ['b', 300, 100]])));
  await openStrings(page);
  const detail = (port: number) => row(page, port).locator('td.vsPortLabel')
    .evaluate((e) => e.getAttribute('data-bs-original-title') || '');
  await expect(row(page, 0).locator('input.vsStartNulls'), 'the start nulls were loaded').toHaveValue('50');
  await expect.poll(() => detail(1), { timeout: 10_000 }).toContain('100 pixels');
  expect(await detail(0)).toContain('150 pixels');
  expect(await detail(0)).toContain(', 6.3 A max');
  // The control: no nulls.
  expect(await detail(1)).toContain(', 6.2 A max');
});

test('Clone String numbers the clones on from a description that ends in a number', async ({ page, request }) => {
  // Regression: d32a7f704.  Cloning a string whose description ended in a
  // number gave each clone a name of its own old description plus the next
  // number, so the clones lost the name: "Str09" cloned over three empty
  // ports gave "10", "11", "12".  They continue the source's numbering, to
  // the width the highest number needs, and keep the name.
  write(PLATFORM, 'BeagleBone Black');
  write(CAPE_FILE, JSON.stringify(bbCape(4)));
  write(BBB_CONFIG, JSON.stringify(config('BBB48String', [['Str09', 1, 50], ['', 151, 0], ['', 301, 0], ['', 451, 0]])));
  await openStrings(page);
  await row(page, 0).locator('td.vsPortLabel').dispatchEvent('mousedown');
  await page.locator('#cloneStringButton').click();
  await expect(row(page, 3).locator('input.vsPixelCount'), 'the clones were made').toHaveValue('50');
  const names = async () => Promise.all([0, 1, 2, 3].map((p) => row(page, p).locator('input.vsDescription').inputValue()));
  expect(await names()).toEqual(['Str09', 'Str10', 'Str11', 'Str12']);

  await page.locator('#stringTab input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => {
    const c = await (await request.get('/api/channel/output/co-bbbStrings')).json();
    return c.channelOutputs?.[0]?.outputs?.map((o: any) => o.virtualStrings[0].description);
  }, { timeout: 15_000 }).toEqual(['Str09', 'Str10', 'Str11', 'Str12']);
});

test('F2 steps over a group label row to the next port', async ({ page }) => {
  // Regression: dc89f817f.  F2 fills in the next row's start channel.  With
  // group labels between ports the next row is the label's, which has no
  // start channel, and the fill went nowhere: the next port was neither
  // filled in nor selected.
  write(PLATFORM, 'BeagleBone Black');
  write(CAPE_FILE, JSON.stringify(bbCape(2, {
    groups: [{ start: 1, count: 1, label: 'Alpha' }, { start: 2, count: 1, label: 'Beta' }],
  })));
  write(BBB_CONFIG, JSON.stringify(config('BBB48String', [['first', 0, 50], ['second', 998, 50]])));
  await openStrings(page);
  expect(await page.locator('#PixelString h2.divider').count(), 'the control: group label rows').toBe(2);
  await row(page, 0).locator('td.vsPortLabel').dispatchEvent('mousedown');
  await page.keyboard.press('F2');
  await expect(row(page, 1).locator('input.vsStartChannel')).toHaveValue('151');
  await expect(row(page, 1)).toHaveClass(/selectedEntry/);
});
