import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { inPlayer, container } from './container';

// The Pixel Strings tab on a cape with an expansion board (a cape group of
// type "expansion", as on docs/samples' sample-pi-strings-52): the board's
// Expansion Type (None, Standard, Differential), a receiver choice for each
// four ports of a differential board, and the Falcon receivers a cape's
// driver offers (v4 on either BeagleBone string driver, v5 only on
// BBShiftString with PRU listeners).  What is saved is what fppd drives the
// ports with, so each choice is saved and drawn back.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const PINS = ['P8-08', 'P8-10', 'P8-12', 'P8-14', 'P8-16', 'P8-18', 'P8-20', 'P8-22', 'P8-24', 'P8-26', 'P8-28', 'P8-30'];
// Ports 1-8 an expansion board, 9-12 the cape's own.
const GROUPS = [
  { start: 1, count: 8, type: 'expansion', label: 'Expansion Board #1' },
  { start: 9, count: 4, label: 'String Ports #9-12' },
];
// driver: BBB48String offers Falcon v4; BBShiftString with listeners v5 too.
function cape(name: string, driver: 'BBB48String' | 'BBShiftString', v5: boolean) {
  return {
    name, longName: `fpp-tests ${name}`, driver, numSerial: 0, supportsSmartReceivers: true,
    outputs: PINS.map((pin) => ({ pin })), groups: GROUPS,
    ...(v5 ? { falconV5ListenerConfig: {} } : {}),
  };
}
const V4 = cape('FppTestsExpV4', 'BBB48String', false);
const V5 = cape('FppTestsExpV5', 'BBShiftString', true);

function stringsConfig(c: { name: string; driver: string }, ports: Record<number, object> = {}) {
  return {
    channelOutputs: [{
      type: c.driver, subType: c.name, pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: PINS.length,
      outputs: PINS.map((_, n) => ({
        portNumber: n, protocol: 'ws2811', differentialType: 0,
        virtualStrings: [{
          description: `s${n}`, startChannel: n * 30, pixelCount: 10, groupCount: 0, reverse: 0,
          colorOrder: 'RGB', nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
        }],
        ...(ports[n] ?? {}),
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
const FILES = [PLATFORM, CAPE_INFO, CONFIG, `${STRINGS_DIR}/${V4.name}.json`, `${STRINGS_DIR}/${V5.name}.json`];
test.beforeEach(() => {
  saved = {};
  for (const p of FILES) saved[p] = readFile(p);
  writeFile(PLATFORM, 'BeagleBone Black');
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p);
    else writeFile(p, content);
  }
});

// Installs the cape (as the one this player has) and the config.
function useCape(c: ReturnType<typeof cape>, config: object) {
  writeFile(`${STRINGS_DIR}/${c.name}.json`, JSON.stringify(c));
  writeFile(CAPE_INFO, JSON.stringify({
    id: c.name, name: c.name, version: '1.0', serialNumber: 'SN0001', provides: ['strings'], verifiedKeyId: 'ft',
  }));
  writeFile(CONFIG, JSON.stringify(config));
}

let errors: string[] = [];
async function openStrings(page: Page) {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}
test.afterEach(() => {
  expect(errors, 'the page threw').toEqual([]);
});

const save = (page: Page) => page.locator('#stringTab input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');
const ports = async (request: APIRequestContext) =>
  (await (await request.get('/api/channel/output/co-bbbStrings')).json()).channelOutputs[0].outputs;
const options = (page: Page, sel: string) =>
  page.locator(`${sel} option`).evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).textContent!.trim()));
const row = (page: Page, driver: string, port: number) => page.locator(`#${driver}_Output_0_${port}_0`);

test('a Differential expansion board takes a receiver per four ports, and Falcon v4 is saved as 15 + receivers', async ({ page, request }) => {
  useCape(V4, stringsConfig(V4));
  await openStrings(page);
  const type = page.locator('#ExpansionType0');
  await expect(type).toHaveValue('0');
  expect(await options(page, '#ExpansionType0')).toEqual(['None', 'Standard', 'Differential']);
  // A board is not differential until it is set to be.
  await expect(page.locator('#DifferentialType0')).toHaveCount(0);

  await type.selectOption('1');
  // A choice at each four ports of the board (1 and 5), and not past it.
  await expect(page.locator('#DifferentialType0')).toHaveCount(1);
  await expect(page.locator('#DifferentialType4')).toHaveCount(1);
  await expect(page.locator('#DifferentialType8')).toHaveCount(0);
  // BBB48String's receivers: Falcon v4, and no v5 (that needs BBShiftString's listeners).
  expect(await options(page, '#DifferentialType0')).toEqual(['Standard', 'Smart v1', 'Smart v2', 'Falcon v4']);

  await page.locator('#DifferentialType4').selectOption('4');
  await page.locator('#DifferentialCount4').selectOption('2');
  // Receiver B's four ports.
  await expect(page.locator('#PixelString tr[id^="BBB48String_Output_1_"]')).toHaveCount(4);
  await save(page).click();
  await expect.poll(async () => (await ports(request))[4].differentialType, { timeout: 15_000 }).toBe(17);
  const out = await ports(request);
  // The cape's own ports have no receiver choice, so no receiver type.
  expect(out.map((p: any) => p.differentialType)).toEqual([0, 0, 0, 0, 17, 17, 17, 17, undefined, undefined, undefined, undefined]);
  expect(out[0].expansionType).toBe(1);
  // Each of the four ports has its B receiver's strings.
  for (const n of [4, 5, 6, 7]) expect(out[n].virtualStringsB, `port ${n + 1}`).toHaveLength(1);
  // The cape's own ports keep what they had.
  expect(out[8].virtualStrings[0]).toMatchObject({ description: 's8', pixelCount: 10 });

  await openStrings(page);
  await expect(page.locator('#ExpansionType0')).toHaveValue('1');
  await expect(page.locator('#DifferentialType0')).toHaveValue('0');
  await expect(page.locator('#DifferentialType4')).toHaveValue('4');
  await expect(page.locator('#DifferentialCount4')).toHaveValue('2');
  await expect(page.locator('#PixelString tr[id^="ROW_RULER_DIFFERENTIAL_4_"]')).toHaveCount(1);
});

test('Falcon v5 receivers are offered with BBShiftString listeners, saved as 9 + receivers, and drawn back', async ({ page, request }) => {
  useCape(V5, stringsConfig(V5, { 0: { expansionType: 1 } }));
  await openStrings(page);
  expect(await options(page, '#DifferentialType0')).toEqual(['Standard', 'Smart v1', 'Smart v2', 'Falcon v4', 'Falcon v5']);
  await page.locator('#DifferentialType0').selectOption('3');
  // v5 takes up to six receivers, like v2.
  expect(await options(page, '#DifferentialCount0')).toHaveLength(6);
  await page.locator('#DifferentialCount0').selectOption('6');
  await save(page).click();
  await expect.poll(async () => (await ports(request))[0].differentialType, { timeout: 15_000 }).toBe(15);
  expect((await ports(request)).slice(0, 4).map((p: any) => p.virtualStringsF?.length)).toEqual([1, 1, 1, 1]);

  await openStrings(page);
  await expect(page.locator('#DifferentialType0')).toHaveValue('3');
  await expect(page.locator('#DifferentialCount0')).toHaveValue('6');
  await expect(page.locator('#PixelString tr[id^="ROW_RULER_DIFFERENTIAL_0_"]')).toHaveCount(5);
});

test('a Falcon v5 port on a cape without the listeners is drawn as Falcon v4, keeping its receivers', async ({ page }) => {
  // 9 + 2: two v5 receivers, as a cape with listeners saved them.
  useCape(V4, stringsConfig(V4, { 0: { expansionType: 1, differentialType: 11 }, 1: { differentialType: 11 },
    2: { differentialType: 11 }, 3: { differentialType: 11 } }));
  await openStrings(page);
  await expect(page.locator('#DifferentialType0')).toHaveValue('4');
  await expect(page.locator('#DifferentialCount0')).toHaveValue('2');
});

test('an expansion board set to None hides its ports and saves them as no pixels', async ({ page, request }) => {
  useCape(V4, stringsConfig(V4));
  await openStrings(page);
  await page.locator('#ExpansionType0').selectOption('-1');
  for (const n of [0, 7]) await expect(row(page, 'BBB48String', n), `port ${n + 1}`).toBeHidden();
  await expect(row(page, 'BBB48String', 8)).toBeVisible();
  await save(page).click();
  await expect.poll(async () => (await ports(request))[0].expansionType, { timeout: 15_000 }).toBe(-1);
  const out = await ports(request);
  for (let n = 0; n < 8; n++) expect(out[n].virtualStrings[0], `port ${n + 1}`).toMatchObject({ pixelCount: 0, startChannel: 0 });
  expect(out[8].virtualStrings[0]).toMatchObject({ description: 's8', pixelCount: 10 });

  // Drawn back hidden; Standard shows them again.
  await openStrings(page);
  await expect(page.locator('#ExpansionType0')).toHaveValue('-1');
  await expect(row(page, 'BBB48String', 0)).toBeHidden();
  await page.locator('#ExpansionType0').selectOption('0');
  await expect(row(page, 'BBB48String', 0)).toBeVisible();
  await expect(page.locator('#DifferentialType0')).toHaveCount(0);
});

// Drawing a saved config, populatePixelStringOutputs() never leaves the
// board: inExpansion stays set past its last port, so every fourth port after
// it is drawn as differential too (choosing Differential on the page stops at
// the board's count, as the first test shows), and a receiver picked there is
// saved for ports with no receivers.  In FUTURE.md.
test('a saved Differential board is drawn with a receiver choice only on its own ports', async ({ page }) => {
  useCape(V4, stringsConfig(V4, { 0: { expansionType: 1 } }));
  await openStrings(page);
  await expect(page.locator('#DifferentialType0')).toHaveCount(1);
  await expect(page.locator('#DifferentialType4')).toHaveCount(1);
  test.fail(true, 'the cape ports after a Differential board are drawn as differential (FUTURE.md)');
  await expect(page.locator('#DifferentialType8'), "the cape's own ports past the board").toHaveCount(0);
});
