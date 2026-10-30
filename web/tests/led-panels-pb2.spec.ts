import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The LED Panels page on a PocketBeagle2 panel cape.  config.php takes the
// board from /etc/fpp/platform ("BeagleBone 64") and the device tree model
// ("... PocketBeagle2"); the player is a container with no device tree, so
// for the spec's length php-fpm runs with scenarios/fakesys.c
// preloaded, which serves /proc/device-tree/model from a file the test
// writes.  The cape's panel config (media/tmp/panels) says which driver the
// page is drawn for.  fppd, already running, is not affected and has no
// BBShiftPanel driver in Docker: what is checked is the page and the
// channeloutputs.json it saves.

test.skip(!container, 'changes the platform and php-fpm inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
const PANELS = '/home/fpp/media/tmp/panels';
const MODEL = '/tmp/fpp-tests-pb2-model';
const SO = '/tmp/fpp-tests-fakesys.so';

function restartPhpFpm(env: string) {
  inPlayer('sh', '-c',
    'm=$(cat /run/php/php8.4-fpm.pid 2>/dev/null); [ -n "$m" ] && kill -QUIT "$m"; ' +
    'for i in $(seq 50); do pgrep -x php-fpm8.4 > /dev/null || break; sleep 0.1; done; ' +
    `${env} php-fpm8.4 -R && ` +
    'for i in $(seq 50); do [ -S /run/php/php8.4-fpm.sock ] && break; sleep 0.1; done');
}

const matrix = (subType: string, over: object = {}) => ({
  cfgVersion: 3, type: 'LEDPanelMatrix', subType, panelMatrixID: 1, enabled: 1, startChannel: 1,
  channelCount: 6144, ledPanelsWidth: 64, ledPanelsHeight: 32, ledPanelsScan: 16, panelWidth: 64,
  panelHeight: 32, panelScan: 16, ledPanelsSize: '64x32x16', colorOrder: 'RGB', gamma: '2.2',
  brightness: 10, ledPanelsLayout: '1x1', ledPanelsOutputs: 8, ledPanelsPanelsPerOutput: 16,
  panelColorDepth: 8, invertedData: 0, panelOutputOrder: false, panelOutputBlankRow: false,
  panelRowAddressType: 0, panelType: 0, panelInterleave: '0', panelDataLayout: 0,
  panels: [{ outputNumber: 0, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
  ...over,
});

function cape(driver?: string) {
  inPlayer('sh', '-c', `rm -rf ${PANELS} && mkdir -p ${PANELS}`);
  putFile(`${PANELS}/FppTestsScroller.json`, JSON.stringify({
    name: 'FppTestsScroller', longName: 'fpp-tests panel cape', ...(driver ? { driver } : {}),
    defaults: { LEDPanelsConnection: driver ?? 'LEDscapeMatrix' }, controls: {},
    outputs: Array.from({ length: 8 }, () => ({})) }));
}

function writeOutputs(matrices: object[]) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({ channelOutputs: matrices }), OUTPUTS);
}
const saved = (request: APIRequestContext) => request.get('/api/configfile/channeloutputs.json').then((r) => r.json());

let savedPlatform = '';
let savedOutputs = '';
let savedPanels = '';
test.beforeAll(() => {
  inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', SO, '/tests/scenarios/fakesys.c', '-ldl');
  putFile(MODEL, 'BeagleBoard.org PocketBeagle2\0');
  // PHP resolves /proc/device-tree (a link to /sys/firmware/devicetree/base
  // where the kernel has one) before it opens the file: both are served.
  restartPhpFpm(`LD_PRELOAD=${SO} FAKESYS=/proc/device-tree/model=${MODEL}:/sys/firmware/devicetree/base/model=${MODEL}`);
});
test.afterAll(() => {
  restartPhpFpm('');
  inPlayer('rm', '-f', SO, MODEL);
});
test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  savedOutputs = inPlayer('sh', '-c', `cat ${OUTPUTS} 2>/dev/null || true`);
  savedPanels = inPlayer('sh', '-c', `cd ${PANELS} 2>/dev/null && tar cf - . | base64 -w0 || true`);
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone 64' > ${PLATFORM}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  if (savedOutputs) inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  else inPlayer('rm', '-f', OUTPUTS);
  inPlayer('sh', '-c', `rm -rf ${PANELS}`);
  if (savedPanels.trim()) inPlayer('sh', '-c', `mkdir -p ${PANELS} && echo "$1" | base64 -d | tar xf - -C ${PANELS}`, 'sh', savedPanels.trim());
});

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php#tab-LEDPanels');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toBeAttached({ timeout: 15_000 });
}

test('choosing a PWM panel type hides color depth and output by row, and saves it off', async ({ page, request }) => {
  // Regression: fe96f9ec1.  The Panel Type and Addressing selects call
  // RowAddressTypeChanged() with no matrix id; it looked for
  // #panelMatrixundefined and hid nothing, so a PWM panel (fixed 16 bit
  // depth, its own scan order) kept Color Depth and Output By Row on show,
  // and a ticked Output By Row was saved with it.
  cape('BBShiftPanel');
  writeOutputs([matrix('BBShiftPanel', { panelOutputOrder: true })]);
  await openPanels(page);
  const m = page.locator('#panelMatrix1');
  // the control: the page is drawn for a PocketBeagle2 BBShiftPanel cape
  await expect(m.locator('.LEDPanelsRowAddressType option[value="4"]')).toHaveText('ABC Shift + DE Direct');
  await expect(m.locator('.LEDPanelsType option[value="3"]')).toHaveText('FM6363C');
  await expect(m.locator('.LEDPanelsColorDepth')).toBeVisible();
  await expect(m.locator('.LEDPanelsOutputByRow')).toBeChecked();

  await m.locator('.LEDPanelsType').selectOption('3');
  await expect(m.locator('.LEDPanelsColorDepth')).toBeHidden();
  await expect(m.locator('.LEDPanelsOutputByRow')).toBeHidden();
  await expect(m.locator('.LEDPanelsOutputByRow')).not.toBeChecked();

  await page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => (await saved(request)).channelOutputs[0].panelType, { timeout: 15_000 }).toBe(3);
  expect((await saved(request)).channelOutputs[0].panelOutputOrder, 'panelOutputOrder saved').toBe(false);
});

test('a BBBMatrix panel cape on a PocketBeagle2 is offered no PWM panel types or shift addressing', async ({ page }) => {
  // The behaviour 88a9c40d9 added (the FM6363C addressing option shown
  // only for a BBShiftPanel cape) as it is now: the PWM types moved to the
  // Panel Type select (5f40c8ee2), which a cape without the BBShiftPanel
  // driver doesn't get at all, and its Addressing select offers only what
  // the FalconMatrix firmware does.
  cape();
  writeOutputs([matrix('LEDscapeMatrix')]);
  await openPanels(page);
  const m = page.locator('#panelMatrix1');
  await expect(m.locator('.LEDPanelsRowAddressType option')).toHaveCount(3);
  expect(await m.locator('.LEDPanelsRowAddressType option').evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value)))
    .toEqual(['0', '2', '3']);
  await expect(m.locator('.LEDPanelsType')).toHaveCount(0);
});

test('a PocketBeagle2 is offered the BeagleBone interleaves, the 32 and 40 pixel zig/zags among them, and saves one', async ({ page, request }) => {
  // Regression: d9ee3f404 (its page half: a BeagleBone 64 board is drawn
  // as a Beagle, not only a "BeagleBone Black") and da338f477 (the "32z"
  // and "40z" choices).  Without the first a PocketBeagle2 got the Pi's
  // interleave list; without the second the zig/zags stopped at 16.  What
  // fppd builds from "32z" is checked in
  // scenarios/test_output_panel_interleave.py.
  cape('BBShiftPanel');
  writeOutputs([matrix('BBShiftPanel', { ledPanelsWidth: 64, ledPanelsHeight: 32, ledPanelsScan: 8, panelScan: 8, ledPanelsSize: '64x32x8' })]);
  await openPanels(page);
  const m = page.locator('#panelMatrix1');
  await expect(m.locator('.LEDPanelInterleave option[value="8z"]')).toHaveText('8 Pixels Zig/Zag');
  await expect(m.locator('.LEDPanelInterleave option[value="32z"]')).toHaveText('32 Pixels Zig/Zag');
  await expect(m.locator('.LEDPanelInterleave option[value="40z"]')).toHaveText('40 Pixels Zig/Zag');
  await m.locator('.LEDPanelInterleave').selectOption('32z');
  await page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => (await saved(request)).channelOutputs[0].panelInterleave, { timeout: 15_000 }).toBe('32z');
});

test("a panel cape's driver and name are what a saved matrix gets", async ({ page, request }) => {
  // Regression: 7fc63459c (the page half; CapeUtils::getPanelConfig, its
  // fppd half, is what BBShiftPanel reads the cape's panel config with --
  // scenarios/test_am62x_panels.py on a panel cape).  The cape's
  // media/tmp/panels config names its driver and its name: the matrix is
  // saved with that driver as subType and the name as configName, not the
  // generic Beagle "LEDscapeMatrix" with no config name.  (Its Test
  // Pattern half, "BB64 Panels" for a BBShiftPanel cape, is not checked.)
  cape('BBShiftPanel');
  writeOutputs([matrix('LEDscapeMatrix')]);
  await openPanels(page);
  await page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => (await saved(request)).channelOutputs[0].subType, { timeout: 15_000 }).toBe('BBShiftPanel');
  expect((await saved(request)).channelOutputs[0].configName).toBe('FppTestsScroller');
});
