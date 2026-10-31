import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// More of the Pixel Strings tab (see pixel-strings-page.spec.ts, whose harness this repeats): on a BeagleBone with a two-port
// string cape.  The tab is drawn only on a player that can drive strings, and
// the page decides that from /etc/fpp/platform (config.php), so the test
// player claims to be a BeagleBone for the length of each test.  The cape is
// put where cape detection unpacks it from the EEPROM: media/tmp/cape-info.json
// (signed, so all its ports are licensed for more than 50 pixels) and its
// string layout in media/tmp/strings.  fppd, already running, is not
// affected: it reads the string config only at start, and has no BeagleBone
// string driver here.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_FILE = `${STRINGS_DIR}/FppTestsStrings.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsStrings', longName: 'fpp-tests 2-port string cape', numSerial: 0,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }],
  groups: [{ start: 1, count: 2 }],
};
// Any key but the FPP project's own ("fp") licenses every port.
const CAPE_INFO_JSON = {
  id: 'FppTestsStrings', name: 'fpp-tests strings', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

function vstring(description: string, startChannel: number, pixelCount: number, extra: Record<string, unknown> = {}) {
  return {
    description, startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
    nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0', ...extra,
  };
}

function stringsConfig(port0: object[], port1: object[]) {
  return {
    channelOutputs: [{
      type: 'BBB48String', subType: 'FppTestsStrings', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: 2,
      outputs: [
        { portNumber: 0, protocol: 'ws2811', differentialType: 0, virtualStrings: port0 },
        { portNumber: 1, protocol: 'ws2811', differentialType: 0, virtualStrings: port1 },
      ],
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

function putBack(path: string, content: string | null) {
  if (content === null) {
    inPlayer('rm', '-f', path);
  } else {
    writeFile(path, content);
  }
}

let saved: Record<string, string | null> = {};

test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG]) {
    saved[p] = readFile(p);
  }
  writeFile(PLATFORM, 'BeagleBone Black');
  writeFile(CAPE_FILE, JSON.stringify(CAPE));
  writeFile(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
});

test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    putBack(p, content);
  }
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}

async function savedConfig(request: APIRequestContext) {
  return (await request.get('/api/channel/output/co-bbbStrings')).json();
}

// The table row of one string: rows carry the port and string in their id.
const row = (page: Page, port: number, str = 0) => page.locator(`#PixelString tr[id$="_Output_0_${port}_${str}"]`);
// The Direction select, found by its options rather than its class: the class
// is what 182255979 fixed.
const direction = (page: Page, port: number) =>
  row(page, port).locator('select').filter({ has: page.locator('option', { hasText: /^Reverse$/ }) });
const save = (page: Page) => page.locator('#stringTab input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');

async function saveAndWait(page: Page, request: APIRequestContext, done: (c: any) => boolean) {
  await save(page).click();
  await expect.poll(async () => done(await savedConfig(request)), { timeout: 15_000 }).toBe(true);
  return savedConfig(request);
}

const reverseOf = (c: any, port: number) => c.channelOutputs[0].outputs[port].virtualStrings[0].reverse;


test('sixty virtual strings on one port are all drawn and all saved', async ({ page, request }) => {
  // Regression: b83a25a7a.  A port took 30 virtual strings; a config with more
  // lost the rest on load and on save.
  const many = Array.from({ length: 60 }, (_, i) => vstring(`s${i}`, i * 3, 1));
  writeFile(CONFIG, JSON.stringify(stringsConfig(many, [vstring('second', 300, 50)])));
  await openStrings(page);
  await expect(page.locator('#PixelString tr[id*="_Output_0_0_"]')).toHaveCount(60);
  await row(page, 1).locator('input.vsDescription').fill('second-saved');
  const got = await saveAndWait(page, request, (c) => c.channelOutputs[0].outputs[1].virtualStrings[0].description === 'second-saved');
  expect(got.channelOutputs[0].outputs[0].virtualStrings.length).toBe(60);
});

test('a BBB48String config on a BBShiftString cape is still editable and saved whole', async ({ page, request }) => {
  // Regression: 4c9d62490.  A config restored from a v1 cape (BBB48String)
  // onto a v2 (BBShiftString) was taken for the wrong type, so its strings
  // could not be edited and a Save wiped the configuration.
  writeFile(CAPE_FILE, JSON.stringify({ ...CAPE, driver: 'BBShiftString' }));
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('first', 0, 50)], [vstring('second', 150, 50)])));
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await openStrings(page);
  await expect(row(page, 0).locator('input.vsDescription')).toHaveValue('first');
  await row(page, 1).locator('input.vsDescription').fill('second-saved');
  const got = await saveAndWait(page, request, (c) => c.channelOutputs?.[0]?.outputs?.[1]?.virtualStrings?.[0]?.description === 'second-saved');
  expect(got.channelOutputs[0].outputs[0].virtualStrings[0].description).toBe('first');
  expect(got.channelOutputs[0].outputs.length).toBe(2);
  expect(errs).toEqual([]);
});

test('a serial output saved with start channel 0 opens at 1', async ({ page }) => {
  // Regression: cad5d25f0.  A BBBSerial output whose start channel was 0 (or
  // missing) was loaded as 0, a start channel that does not exist.
  writeFile(CAPE_FILE, JSON.stringify({ ...CAPE, numSerial: 2, serial: [{ pin: 'P9-24' }, { pin: 'P9-26' }] }));
  const cfg: any = stringsConfig([vstring('first', 0, 50)], [vstring('second', 150, 50)]);
  cfg.channelOutputs.push({ type: 'BBBSerial', subType: 'DMX', device: 'FppTestsStrings', enabled: 1, startChannel: 1, channelCount: 512,
    outputCount: 1, outputs: [{ outputNumber: 0, startChannel: 0, channelCount: 512 }] });
  writeFile(CONFIG, JSON.stringify(cfg));
  await openStrings(page);
  await expect(page.locator('#BBBSerialStartChannel1')).toHaveValue('1');
});

for (const platform of ['BeagleBone 64', 'BeagleBone Black']) {
  test(`the Pixel Strings tab works on a ${platform}`, async ({ page, request }) => {
    // Regression: 4fd45edfc.  The page asked for the BeagleBone Black by
    // name and so left the newer Beagles (PocketBeagle 2, BeagleBone 64)
    // without their strings.
    writeFile(PLATFORM, platform);
    writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('first', 0, 50)], [vstring('second', 150, 50)])));
    await openStrings(page);
    await expect(row(page, 0).locator('input.vsDescription')).toHaveValue('first');
    await row(page, 1).locator('input.vsDescription').fill('second-saved');
    await saveAndWait(page, request, (c) => c.channelOutputs?.[0]?.outputs?.[1]?.virtualStrings?.[0]?.description === 'second-saved');
  });
}

test('on a BeagleBone 64 the pixel test pattern is sent to the BBB Pixel Strings output, and Save adds the serial output', async ({ page, request }) => {
  // Regressions: 8c3bf5be3 (the test type was chosen by the BeagleBone Black's
  // name alone) and 47e45d39a (Save added the serial output on the
  // BeagleBone Black only).
  writeFile(PLATFORM, 'BeagleBone 64');
  writeFile(CAPE_FILE, JSON.stringify({ ...CAPE, numSerial: 2, serial: [{ pin: 'P9-24' }, { pin: 'P9-26' }] }));
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('first', 0, 50)], [vstring('second', 150, 50)])));
  await openStrings(page);

  const sent = page.waitForRequest((r) => r.url().includes('api/command') && r.method() === 'POST');
  await page.locator('#PixelTestPatternType').selectOption({ index: 1 });
  expect((await sent).postData()).toContain('"BBB Pixel Strings"');

  await page.locator('#BBBSerialMode').selectOption('DMX');
  await row(page, 1).locator('input.vsDescription').fill('second-saved');
  const got = await saveAndWait(page, request, (c) => c.channelOutputs?.[0]?.outputs?.[1]?.virtualStrings?.[0]?.description === 'second-saved');
  expect(got.channelOutputs.map((o: any) => o.type).sort()).toEqual(['BBB48String', 'BBBSerial']);
});
