import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Pixel Strings tab of Channel Outputs, on a BeagleBone with a two-port
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
const save = (page: Page) => page.locator('#stringTab input[type=button][value="Save"]');

async function saveAndWait(page: Page, request: APIRequestContext, done: (c: any) => boolean) {
  await save(page).click();
  await expect.poll(async () => done(await savedConfig(request)), { timeout: 15_000 }).toBe(true);
  return savedConfig(request);
}

const reverseOf = (c: any, port: number) => c.channelOutputs[0].outputs[port].virtualStrings[0].reverse;

test('a string set to Reverse is saved Reverse, and reads Reverse after a reload', async ({ page, request }) => {
  // Regression: 182255979.  The Direction select was drawn with class
  // "fvsReverse" while every reader and writer looks for ".vsReverse", so
  // Save wrote parseInt(undefined) -- NaN, which JSON.stringify writes as
  // null -- and on reload the string was back to Forward.
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('first', 0, 50)], [vstring('second', 150, 50)])));
  await openStrings(page);
  await direction(page, 0).selectOption('1');
  // A description change marks what this Save wrote, whatever it did to reverse.
  await row(page, 1).locator('input.vsDescription').fill('second-saved');
  const got = await saveAndWait(page, request,
    (c) => c.channelOutputs[0].outputs[1].virtualStrings[0].description === 'second-saved');
  expect(reverseOf(got, 0), 'port 1 as saved').toBe(1);
  expect(reverseOf(got, 1), 'port 2, left Forward, as saved').toBe(0);

  await page.reload();
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  await expect(direction(page, 0)).toHaveValue('1');
  await expect(direction(page, 1)).toHaveValue('0');
});

test('a Reverse string keeps Reverse through a Save that did not touch it', async ({ page, request }) => {
  // Regression: 182255979.  A string already saved Reverse was drawn Reverse,
  // but any Save of the page wrote it back as null, which fppd reads as
  // Forward.
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('first', 0, 50, { reverse: 1 })], [vstring('second', 150, 50)])));
  await openStrings(page);
  await expect(direction(page, 0)).toHaveValue('1');
  await row(page, 1).locator('input.vsDescription').fill('second-saved');
  const got = await saveAndWait(page, request,
    (c) => c.channelOutputs[0].outputs[1].virtualStrings[0].description === 'second-saved');
  expect(reverseOf(got, 0)).toBe(1);
});

test('Clone String copies a string\'s Reverse to the strings it fills', async ({ page, request }) => {
  // Regression: 182255979.  Clone read the direction through the same
  // ".vsReverse" lookup and set it the same way, so a clone came out Forward.
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('String 1', 0, 50, { reverse: 1 })], [vstring('', 150, 0)])));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '1' : undefined));
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  await row(page, 0).locator('td.vsPortLabel').dispatchEvent('mousedown');
  await page.locator('#cloneStringButton').click();
  await expect(row(page, 1).locator('input.vsPixelCount'), 'the clone was made').toHaveValue('50');
  await expect(direction(page, 1)).toHaveValue('1');
  const got = await saveAndWait(page, request, (c) => c.channelOutputs[0].outputs[1].virtualStrings[0].pixelCount === 50);
  expect(reverseOf(got, 1), 'the clone as saved').toBe(1);
});

test('Clone String finds its string whatever header rows the table holds', async ({ page }) => {
  // Regression: 584498b3f. Clone String took the selected string's place
  // from its rowIndex in the whole table less one, while it counted the
  // strings in the table's body: it assumed exactly one header row above
  // them. The floating
  // header (floatThead) leaves its own sizing header in the table, one
  // normally, but a full web run caught the table holding two, as a second
  // floatThead set-up without a destroy leaves it. The first string's place
  // then came out one past itself, there were no strings below it, and the
  // clone was refused: "Max rows to clone going down is 0".
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('String 1', 0, 50)], [vstring('', 150, 0)])));
  const alerts: string[] = [];
  page.on('dialog', (d) => {
    if (d.type() === 'alert') alerts.push(d.message());
    d.accept(d.type() === 'prompt' ? '1' : undefined);
  });
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  // The table as that run had it: a second copy of floatThead's sizing header.
  const firstRowIndex = await page.evaluate(() => {
    const t = document.getElementById('PixelString') as HTMLTableElement;
    const head = t.querySelector(':scope > thead')!;
    t.insertBefore(head.cloneNode(true), head);
    return (t.querySelector('tr[id$="_Output_0_0_0"]') as HTMLTableRowElement).rowIndex;
  });
  // The control: two header rows above the first string.
  expect(firstRowIndex).toBe(2);
  await row(page, 0).locator('td.vsPortLabel').dispatchEvent('mousedown');
  await page.locator('#cloneStringButton').click();
  await expect(row(page, 1).locator('input.vsPixelCount'), `the clone was made (alerts: ${alerts.join(' | ')})`).toHaveValue('50');
});

test('the estimated max fps is set by the longest port: about 40 fps at 800 pixels', async ({ page }) => {
  // Feature: 15454a9c9.  The Pixel Strings tab estimates the frame rate the
  // strings allow: a port clocks about 800 RGB pixels at 40 fps, so the port
  // with the most pixels on it (nulls included) sets the ceiling.
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('first', 0, 800)], [vstring('second', 2400, 400)])));
  await openStrings(page);
  const fps = page.locator('#pixelStringMaxFPS');
  await expect(fps).toHaveText(/≈40 fps max \(longest port 1\b/);

  // Port 2 grows to 1000 pixels plus 600 null nodes: 1600 on the wire, 20 fps.
  await row(page, 1).locator('input.vsPixelCount').fill('1000');
  await row(page, 1).locator('input.vsStartNulls').fill('600');
  await row(page, 1).locator('input.vsStartNulls').dispatchEvent('change');
  await expect(fps).toHaveText(/≈20 fps max \(longest port 2\b/);

  // And shrinks to 100: port 1 is the longest again.
  await row(page, 1).locator('input.vsPixelCount').fill('100');
  await row(page, 1).locator('input.vsStartNulls').fill('0');
  await row(page, 1).locator('input.vsStartNulls').dispatchEvent('change');
  await expect(fps).toHaveText(/≈40 fps max \(longest port 1\b/);
});

test('F2 on the Strings tab starts the next string after the selected one, and stays on the page', async ({ page }) => {
  // Regression: 033380eed.  The page bound its own keydown handler for F2
  // (set the next string's start channel) beside the global one, which sends
  // F2 to Settings: both ran, and the page navigated away right after
  // filling in the channel.  Off the Strings tab, F2 still opens Settings.
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('first', 0, 50)], [vstring('second', 0, 50)])));
  await openStrings(page);
  await row(page, 0).locator('td.vsPortLabel').dispatchEvent('mousedown');
  await page.keyboard.press('F2');
  await expect(row(page, 1).locator('input.vsStartChannel')).toHaveValue('151');
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname, 'F2 left the page').toBe('/channeloutputs.php');
  await expect(row(page, 1)).toHaveClass(/selectedEntry/);

  // The control: on another tab F2 is the global Settings key.  This player
  // shows only the Strings tab, so an Other outputs one is added.
  await page.locator('[data-bs-toggle="dropdown"]').filter({ hasText: 'Add Output Group' }).click();
  await page.locator('#addOutputCategoryMenu a.dropdown-item').first().click();
  await page.locator('[id^="tab-other-"][id$="-tab"]').first().click();
  await page.keyboard.press('F2');
  await expect(page).toHaveURL(/settings\.php/);
});

test('saving the strings turns test mode off', async ({ page, request }) => {
  // Feature: 05cc45f5c.  Saving an output config ends a running test pattern.
  writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('first', 0, 50)], [vstring('second', 150, 50)])));
  await openStrings(page);
  const t = await request.post('/api/command', { data: { command: 'Test Start', args: ['1000', 'RGB Cycle', '1-300', 'R-G-B'] } });
  expect(t.ok()).toBe(true);
  try {
    await expect.poll(async () => (await (await request.get('/api/testmode')).json()).enabled).toBe(1);
    await row(page, 1).locator('input.vsDescription').fill('second-saved');
    await saveAndWait(page, request, (c) => c.channelOutputs[0].outputs[1].virtualStrings[0].description === 'second-saved');
    await expect.poll(async () => (await (await request.get('/api/testmode')).json()).enabled, { timeout: 10_000 }).toBe(0);
  } finally {
    await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  }
});

test('Import Strings takes a model\'s pixel count from xLights\' named node-count attributes, or an old parm2', async ({ page, request }) => {
  // Regression: 6b0b4e34f.  The import read the pixel count from the parm2
  // attribute, which current xLights no longer writes (it has per-type names
  // such as NodesPerString), so a current layout imported 0-pixel strings.
  const XML = `${MEDIA}/upload/xlights_rgbeffects.xml`;
  const savedXml = readFile(XML);
  writeFile(XML, `<?xml version="1.0" encoding="UTF-8"?>
<xrgb><models>
<model name="fpp-tests tree" DisplayAs="Tree" Tree="Tree" TreeDegrees="360" StringCount="1" NodesPerString="50" StartChannel="1">
  <ControllerConnection Port="1" Protocol="ws2811"/></model>
<model name="fpp-tests arch" DisplayAs="Arches" parm1="1" parm2="30" parm3="1" StartChannel="151">
  <ControllerConnection Port="2" Protocol="ws2811"/></model>
</models></xrgb>`);
  try {
    writeFile(CONFIG, JSON.stringify(stringsConfig([vstring('', 0, 0)], [vstring('', 0, 0)])));
    await openStrings(page);
    await page.locator('#stringTab input[value="Import Strings"]').click();
    await expect(row(page, 0).locator('input.vsPixelCount')).toHaveValue('50');
    await expect(row(page, 1).locator('input.vsPixelCount')).toHaveValue('30');
    await expect(row(page, 0).locator('input.vsDescription')).toHaveValue('fpp-tests tree');
    // And what is saved for the outputs.
    const got = await saveAndWait(page, request, (c) => c.channelOutputs[0].outputs[1].virtualStrings[0].pixelCount === 30);
    expect(got.channelOutputs[0].outputs.map((o: any) => [o.virtualStrings[0].description, o.virtualStrings[0].pixelCount]))
      .toEqual([['fpp-tests tree', 50], ['fpp-tests arch', 30]]);
  } finally {
    putBack(XML, savedXml);
  }
});

test.describe('on a BBShiftString cape', () => {
  // The WS2811 800kHz family, as c5cce457b lists it: every one is driven
  // with the ws2811 bit cell, so each is a name, not a behaviour.
  const WS281X = ['ws2811', 'ws2812', 'ws2812b', 'ws2813', 'ws2815', 'ws2818', 'sk6812', 'sk6813', 'sm16703', 'gs8206',
    'gs8208', 'tm1809', 'tm1812', 'ucs1904', 'ucs2903', 'apa104', 'apa106', 'apa109', 'sk6812rgbw', 'sk6818', 'sm16704',
    'ucs2904', 'ws2814'];

  test('a port\'s protocol list names the WS2811-family parts, and the one picked is saved', async ({ page, request }) => {
    // Feature: c5cce457b.  The dropdown said only "ws2811", leaving someone
    // with SK6812s to work out that it is a WS2811 in disguise.  Parts the
    // ws2811 cell would drive wrongly (the 400kHz ones, sk6822, tm1914) are
    // not in the list.
    writeFile(CAPE_FILE, JSON.stringify({ ...CAPE, driver: 'BBShiftString' }));
    const config = stringsConfig([vstring('first', 0, 50)], [vstring('second', 150, 50)]);
    config.channelOutputs[0].type = 'BBShiftString';
    writeFile(CONFIG, JSON.stringify(config));
    await openStrings(page);
    const protocol = row(page, 0).locator('select.vsProtocol');
    const offered = await protocol.locator('option').evaluateAll((os) => os.map((o: any) => o.value));
    expect(offered).toEqual(expect.arrayContaining(WS281X));
    for (const wrong of ['tm1803', 'tm1804', 'ucs1903', 'sk6822', 'pl9823', 'tm1914']) {
      expect(offered, 'a part the ws2811 cell does not drive').not.toContain(wrong);
    }
    await protocol.selectOption('sk6812');
    const got = await saveAndWait(page, request, (c) => c.channelOutputs[0].outputs[0].protocol === 'sk6812');
    expect(got.channelOutputs[0].type).toBe('BBShiftString');
    await page.reload();
    await page.locator('#stringTab-tab').click();
    await expect(row(page, 0).locator('select.vsProtocol')).toHaveValue('sk6812', { timeout: 15_000 });
  });
});
