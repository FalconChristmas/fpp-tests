import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Pixel Strings: what Clone String refuses, a save the player rejects, and
// removing a virtual string.  The harness is pixel-strings-page.spec.ts's,
// with a four-port cape so there are strings above and below to clone onto.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_FILE = `${STRINGS_DIR}/FppTestsClone.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsClone', longName: 'fpp-tests 4-port string cape', numSerial: 0,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }, { pin: 'P8-12' }, { pin: 'P8-14' }],
  groups: [{ start: 1, count: 4 }],
};
// Any key but the FPP project's own ("fp") licenses every port.
const CAPE_INFO_JSON = {
  id: 'FppTestsClone', name: 'fpp-tests strings', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

function vstring(description: string, startChannel: number, pixelCount: number, extra: Record<string, unknown> = {}) {
  return {
    description, startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
    nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0', ...extra,
  };
}

function stringsConfig(ports: object[][]) {
  return {
    channelOutputs: [{
      type: 'BBB48String', subType: 'FppTestsClone', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: ports.length,
      outputs: ports.map((virtualStrings, portNumber) => ({ portNumber, protocol: 'ws2811', differentialType: 0, virtualStrings })),
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

async function savedConfig(request: APIRequestContext) {
  return (await request.get('/api/channel/output/co-bbbStrings')).json();
}

// The table row of one string: rows carry the port and string in their id.
const row = (page: Page, port: number, str = 0) => page.locator(`#PixelString tr[id$="_Output_0_${port}_${str}"]`);
const save = (page: Page) => page.locator('#stringTab input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');


// Dialogs are answered here: what the clone prompt is told, and every alert
// kept for the test to read.
async function openStrings(page: Page, clones: string | null) {
  const alerts: string[] = [];
  const asked: string[] = [];
  const answer = { clones };
  page.on('dialog', (d) => {
    if (d.type() === 'prompt') {
      asked.push(d.defaultValue());
      return answer.clones === null ? d.dismiss() : d.accept(answer.clones);
    }
    alerts.push(d.message());
    return d.accept();
  });
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  return { alerts, asked, answer };
}

const select = (page: Page, port: number) => row(page, port).locator('td.vsPortLabel').dispatchEvent('mousedown');
const pixels = (page: Page) =>
  page.locator('#PixelString input.vsPixelCount').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

const four = () =>
  stringsConfig([[vstring('Arch 1', 1, 50)], [vstring('', 151, 0)], [vstring('', 151, 0)], [vstring('', 151, 0)]]);

test('Clone String is not offered until a string is selected', async ({ page }) => {
  writeFile(CONFIG, JSON.stringify(four()));
  await openStrings(page, '1');
  await expect(page.locator('#cloneStringButton')).toBeHidden();
  await select(page, 0);
  await expect(page.locator('#cloneStringButton')).toBeVisible();
});

test('Clone String offers the strings below, and refuses more than there are', async ({ page }) => {
  writeFile(CONFIG, JSON.stringify(four()));
  const { alerts, asked } = await openStrings(page, '4');
  await select(page, 0);
  await page.locator('#cloneStringButton').click();
  await expect.poll(() => alerts).toEqual(['Max rows to clone going down is 3']);
  // The prompt starts at every string below the selected one.
  expect(asked).toEqual(['3']);
  expect(await pixels(page)).toEqual(['50', '0', '0', '0']);
  await expect(row(page, 0).locator('input.vsDescription')).toHaveValue('Arch 1');
});

test('a negative count clones upward, and no further than the first string', async ({ page, request }) => {
  const config = stringsConfig([[vstring('', 1, 0)], [vstring('', 1, 0)], [vstring('Arch 1', 301, 50)], [vstring('keep', 900, 20)]]);
  writeFile(CONFIG, JSON.stringify(config));
  const { alerts, answer } = await openStrings(page, '-3');
  await select(page, 2);
  await page.locator('#cloneStringButton').click();
  await expect.poll(() => alerts).toEqual(['Max rows to clone going up is 2']);
  expect(await pixels(page)).toEqual(['0', '0', '50', '20']);

  // The control: two is as far up as it goes, and the string below is left.
  answer.clones = '-2';
  await page.locator('#cloneStringButton').click();
  await expect.poll(() => pixels(page)).toEqual(['50', '50', '50', '20']);
  await expect(row(page, 3).locator('input.vsDescription')).toHaveValue('keep');
  // Each clone is numbered on from the one it came from and starts where
  // the one before it ends, counting from the selected string.  (The page
  // shows channels from 1; the file counts from 0.)
  expect(await page.locator('#PixelString input.vsDescription').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual([
    'Arch 3', 'Arch 2', 'Arch 1', 'keep',
  ]);
  expect(await page.locator('#PixelString input.vsStartChannel').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual([
    '602', '452', '302', '901',
  ]);
  expect(alerts).toEqual(['Max rows to clone going up is 2']);

  await save(page).click();
  await expect.poll(async () => (await savedConfig(request)).channelOutputs[0].outputs[0].virtualStrings[0].pixelCount, { timeout: 15_000 }).toBe(50);
  const outputs = (await savedConfig(request)).channelOutputs[0].outputs;
  expect(outputs.map((o: any) => o.virtualStrings[0].startChannel)).toEqual([601, 451, 301, 900]);
});

test('a dismissed or empty count clones nothing', async ({ page }) => {
  writeFile(CONFIG, JSON.stringify(four()));
  const { alerts, asked } = await openStrings(page, null);
  await select(page, 0);
  await page.locator('#cloneStringButton').click();
  await expect.poll(() => asked).toHaveLength(1);
  expect(await pixels(page)).toEqual(['50', '0', '0', '0']);
  expect(alerts).toEqual([]);
});

test('a clone stops at a port that cannot hold the string, and says which', async ({ page }) => {
  // The FPP project's own key with no licensed ports: every port is held to
  // 50 pixels, so a 60-pixel string cannot be cloned onto the next one.
  writeFile(CAPE_INFO, JSON.stringify({ ...CAPE_INFO_JSON, verifiedKeyId: 'fp' }));
  writeFile(CONFIG, JSON.stringify(stringsConfig([[vstring('Big 1', 1, 60)], [vstring('', 181, 0)], [vstring('', 181, 0)], [vstring('', 181, 0)]])));
  const { alerts } = await openStrings(page, '2');
  await expect(row(page, 1).locator('input.vsPixelCount')).toHaveAttribute('max', '50');
  await select(page, 0);
  await page.locator('#cloneStringButton').click();
  await expect.poll(() => alerts.filter((a) => a.startsWith('ERROR'))).toEqual(['ERROR, port 2 only supports 50 pixels.']);
  expect(await pixels(page)).toEqual(['60', '0', '0', '0']);
});

test('a save the player does not take is reported, and Save can be pressed again', async ({ page, request }) => {
  writeFile(CONFIG, JSON.stringify(four()));
  await openStrings(page, null);
  const before = JSON.stringify(await savedConfig(request));
  let fail = true;
  await page.route(
    (url) => url.pathname.endsWith('/api/channel/output/co-bbbStrings'),
    (route) => (fail && route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'no' }) : route.fallback())
  );
  await row(page, 1).locator('input.vsPixelCount').fill('25');
  await save(page).click();
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Save Failed');
  await expect(dialog.locator('.modal-title')).toHaveText('Save Pixel String Outputs');
  expect(JSON.stringify(await savedConfig(request))).toBe(before);

  // What was typed is still there, and saves once the player answers.
  await dialog.locator('button', { hasText: 'Close' }).click();
  await expect(row(page, 1).locator('input.vsPixelCount')).toHaveValue('25');
  fail = false;
  await save(page).click();
  await expect.poll(async () => (await savedConfig(request)).channelOutputs[0].outputs[1].virtualStrings[0].pixelCount, { timeout: 15_000 }).toBe(25);
});

test('a removed virtual string is gone from the saved port, and the strings around it stay', async ({ page, request }) => {
  writeFile(CONFIG, JSON.stringify(stringsConfig([
    [vstring('a', 1, 10), vstring('b', 31, 10), vstring('c', 61, 10)], [vstring('next', 91, 10)], [vstring('', 121, 0)], [vstring('', 121, 0)],
  ])));
  await openStrings(page, null);
  await expect(row(page, 0, 1).locator('input.vsDescription')).toHaveValue('b');
  await row(page, 0, 1).locator('.circularDeleteButton').click();
  await expect(row(page, 0, 1)).toHaveCount(0);
  await save(page).click();
  await expect.poll(async () => (await savedConfig(request)).channelOutputs[0].outputs[0].virtualStrings.length, { timeout: 15_000 }).toBe(2);
  const outputs = (await savedConfig(request)).channelOutputs[0].outputs;
  expect(outputs[0].virtualStrings.map((v: any) => v.description)).toEqual(['a', 'c']);
  expect(outputs[1].virtualStrings.map((v: any) => v.description)).toEqual(['next']);
});

test('two virtual strings on one port that share channels are both marked, naming the port', async ({ page }) => {
  writeFile(CONFIG, JSON.stringify(stringsConfig([
    [vstring('a', 1, 10), vstring('b', 16, 10)], [vstring('clear', 200, 10)], [vstring('', 300, 0)], [vstring('', 300, 0)],
  ])));
  await openStrings(page, null);
  for (const str of [0, 1]) {
    const start = row(page, 0, str).locator('input.vsStartChannel');
    await expect(start).toHaveClass(/inputWarning/);
    await expect(start).toHaveAttribute('data-bs-original-title', 'Channels for Virtual Strings on output 1 overlap.');
  }
  await expect(row(page, 1).locator('input.vsStartChannel')).not.toHaveClass(/inputWarning/);
  // Moved clear of the first, neither is marked.
  await row(page, 0, 1).locator('input.vsStartChannel').fill('40');
  await expect(row(page, 0, 0).locator('input.vsStartChannel')).not.toHaveClass(/inputWarning/);
  await expect(row(page, 0, 1).locator('input.vsStartChannel')).not.toHaveClass(/inputWarning/);
});
