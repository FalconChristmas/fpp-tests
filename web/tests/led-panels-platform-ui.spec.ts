import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The LED Panel Matrices tab on a BeagleBone panel cape (BBShiftPanel), or a
// Pi.  The page draws its controls from the platform config.php works out:
// the player claims to be a BeagleBone Black through /etc/fpp/platform, or a
// PocketBeagle2 or a Pi through that and the device tree's model
// (config.php's reads of /proc/device-tree/model and
// /sys/firmware/devicetree/base/model are pointed at files for the length of
// the test; the container has no device tree).  A cape is "detected" by the
// file cape detection leaves in media/tmp/panels.  fppd, already running and
// with no BBShiftPanel driver in Docker, is not affected: what is checked is
// the page and the channeloutputs.json it saves.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
const CAPE = '/home/fpp/media/tmp/panels/FppTestsPanels.json';
const CONFIG = '/opt/fpp/www/config.php';
const DTMODEL = '/tmp/fpp-tests-dtmodel';

const matrix = (id: number, start: number, size: [number, number, number], output = 0, extra: object = {}) => ({
  cfgVersion: 3, type: 'LEDPanelMatrix', subType: 'BBShiftPanel', panelMatrixID: id, enabled: 1, startChannel: start,
  channelCount: size[0] * size[1] * 3, ledPanelsWidth: size[0], ledPanelsHeight: size[1], ledPanelsScan: size[2],
  panelWidth: size[0], panelHeight: size[1], panelScan: size[2], ledPanelsSize: size.join('x'), colorOrder: 'RGB',
  gamma: '2.2', brightness: 10, ledPanelsLayout: '1x1', ledPanelsOutputs: 8, ledPanelsPanelsPerOutput: 16,
  panelColorDepth: 8, invertedData: 0, panelOutputOrder: false, panelOutputBlankRow: false, panelRowAddressType: 0,
  panelType: 0, panelInterleave: '8', panelDataLayout: 0,
  panels: [{ outputNumber: output, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
  ...extra,
});

function writeOutputs(matrices: object[]) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({ channelOutputs: matrices }), OUTPUTS);
}
const saved = (request: APIRequestContext) => request.get('/api/configfile/channeloutputs.json').then((r) => r.json());

function putCape() {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', 'sh',
    JSON.stringify({ name: 'FppTestsPanels', longName: 'fpp-tests panel cape', driver: 'BBShiftPanel',
      defaults: { LEDPanelsConnection: 'BBShiftPanel' }, controls: {}, outputs: Array.from({ length: 8 }, () => ({})) }), CAPE);
}

// A PocketBeagle2: config.php reads the board from /proc/device-tree/model.
// opcache revalidates config.php every few seconds, so wait until the pages
// are drawn for the board asked for.
const PB2 = '"SubPlatform":"BeagleBoard.org PocketBeagle2"';
const PIMODEL = '/tmp/fpp-tests-pimodel';
const drawnWith = async (request: APIRequestContext, text: string) => (await (await request.get('/channeloutputs.php')).text()).includes(text);
async function becomePocketBeagle2(request: APIRequestContext) {
  inPlayer('sh', '-c', `printf '%s' 'BeagleBone 64' > ${PLATFORM} && printf 'BeagleBoard.org PocketBeagle2\\0' > ${DTMODEL} &&
    sed -i 's#"/proc/device-tree/model"#"${DTMODEL}"#' ${CONFIG}`);
  await expect.poll(() => drawnWith(request, PB2), { timeout: 15_000 }).toBe(true);
}
async function becomePi(request: APIRequestContext, model: string) {
  inPlayer('sh', '-c', `printf '%s' 'Raspberry Pi' > ${PLATFORM} && printf '%s\\0' '${model}' > ${PIMODEL} &&
    sed -i 's#"/sys/firmware/devicetree/base/model"#"${PIMODEL}"#' ${CONFIG}`);
  await expect.poll(() => drawnWith(request, `"SubPlatform":"${model}"`), { timeout: 15_000 }).toBe(true);
}
async function restoreConfigPhp(request: APIRequestContext) {
  if (inPlayer('sh', '-c', `grep -c 'fpp-tests-' ${CONFIG} || true`).trim() === '0') return;
  inPlayer('sh', '-c', `sed -i 's#"${DTMODEL}"#"/proc/device-tree/model"#; s#"${PIMODEL}"#"/sys/firmware/devicetree/base/model"#' ${CONFIG}; rm -f ${DTMODEL} ${PIMODEL}`);
  await expect.poll(() => drawnWith(request, 'fpp-tests-'), { timeout: 15_000 }).toBe(false);
}

let savedPlatform = '';
let savedOutputs = '';
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  savedOutputs = inPlayer('sh', '-c', `cat ${OUTPUTS} 2>/dev/null || true`);
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > ${PLATFORM}`);
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
});
test.afterEach(async ({ request }) => {
  await restoreConfigPhp(request);
  inPlayer('rm', '-f', CAPE);
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  if (savedOutputs) inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  else inPlayer('rm', '-f', OUTPUTS);
});

async function openPanels(page: Page, id = 1) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php#tab-LEDPanels');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator(`#panelMatrix${id} .LEDPanelsSize`)).toBeAttached({ timeout: 15_000 });
  await expect(page.locator(`#panelMatrix${id} .LEDPanelOutputNumber_0_0`)).toBeAttached({ timeout: 15_000 });
}
const panelSave = (page: Page) => page.locator('input[value="Save"][onclick="SaveLEDPanelsConfig();"]:not(.Zebra_Pin_Clone *)');
const saveWarning = (page: Page) => page.locator('#SaveChangeWarningLabel:not(.Zebra_Pin_Clone *)');

test('on a PocketBeagle2, a PWM panel type hides Color Depth and Output by Row, and is saved', async ({ page, request }) => {
  // Regression: b95a2fb58, 7235bba66, 371c0f1d9.  Picking a PWM panel (FM6363C and the
  // rest manage their own depth and scan order) is meant to hide Color Depth
  // and Output by Row.  RowAddressTypeChanged built its selectors with plain
  // quotes, so "${panelMatrixID}" was never filled in (7235bba66), and the
  // Color Depth selector had spaces typed into its class name (b95a2fb58):
  // either way the controls stayed up.  Save left a panel type or
  // addressing type of 0 out of the config altogether (371c0f1d9).
  putCape();
  await becomePocketBeagle2(request);
  writeOutputs([matrix(1, 1, [64, 32, 16], 0, { panelOutputOrder: true })]);
  await openPanels(page);
  const depth = page.locator('#panelMatrix1 .LEDPanelsColorDepth');
  const byRow = page.locator('#panelMatrix1 .LEDPanelsOutputByRow');
  await expect(depth).toBeVisible();
  await expect(byRow).toBeChecked();
  await page.locator('#panelMatrix1 .LEDPanelsType').selectOption('3');
  await expect(depth).toBeHidden();
  await expect(page.locator('#panelMatrix1 .LEDPanelsColorDepthLabel')).toBeHidden();
  await expect(byRow).toBeHidden();
  await expect(byRow).not.toBeChecked();
  await panelSave(page).click();
  await expect.poll(async () => (await saved(request)).channelOutputs[0].panelType, { timeout: 15_000 }).toBe(3);
  expect((await saved(request)).channelOutputs[0].panelOutputOrder, 'Output by Row, unticked when hidden').toBe(false);
  // and back to a standard panel brings them back
  await page.locator('#panelMatrix1 .LEDPanelsType').selectOption('0');
  await expect(depth).toBeVisible();
  await expect(byRow).toBeVisible();
  // and Standard is saved as 0, not left out (371c0f1d9)
  await panelSave(page).click();
  await expect.poll(async () => (await saved(request)).channelOutputs[0].panelType, { timeout: 15_000 }).toBe(0);
  expect((await saved(request)).channelOutputs[0].panelRowAddressType).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('on a PocketBeagle2, a saved PWM panel opens with Color Depth hidden', async ({ page, request }) => {
  // Regression: 17fd290da.  RowAddressTypeChanged, which hides what a PWM
  // panel does not use, was not run as the matrix was set up.
  putCape();
  await becomePocketBeagle2(request);
  writeOutputs([matrix(1, 1, [64, 32, 16], 0, { panelType: 3 })]);
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsType')).toHaveValue('3');
  await expect(page.locator('#panelMatrix1 .LEDPanelsColorDepth')).toBeHidden();
  await expect(page.locator('#panelMatrix1 .LEDPanelsOutputByRow')).toBeHidden();
});

test('on a PocketBeagle2, the panel addressing type opens as saved and a new one is saved', async ({ page, request }) => {
  // Regression: 34e241ac0.  The Addressing Type <select>'s onchange
  // attribute was missing its closing quote, which swallowed the markup
  // after it.
  putCape();
  await becomePocketBeagle2(request);
  writeOutputs([matrix(1, 1, [64, 32, 16], 0, { panelRowAddressType: 2 })]);
  await openPanels(page);
  const rat = page.locator('#panelMatrix1 .LEDPanelsRowAddressType');
  await expect(rat).toHaveValue('2');
  await rat.selectOption('4');
  await expect(saveWarning(page)).toBeVisible();
  await panelSave(page).click();
  await expect.poll(async () => (await saved(request)).channelOutputs[0].panelRowAddressType, { timeout: 15_000 }).toBe(4);
  expect(pageErrors).toEqual([]);
});

test('a panel scanning half its rows has no interleave to pick, and the setting is hidden, label and all', async ({ page }) => {
  // Regression: e6e2de46d.  The Panel Interleave dropdown was only disabled
  // for a panel that needs no interleave; it is now hidden with its label
  // (whose class the hiding code had misspelt).
  putCape();
  writeOutputs([matrix(1, 1, [32, 16, 8])]);
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toHaveValue('32x16x8');
  await expect(page.locator('#panelMatrix1 .LEDPanelInterleave')).toBeHidden();
  await expect(page.locator('#panelMatrix1 .LEDPanelInterleaveLabel')).toBeHidden();
  // A 1/4 scan one needs it, and it is shown.
  await page.locator('#panelMatrix1 .LEDPanelsSize').selectOption('32x16x4');
  await expect(page.locator('#panelMatrix1 .LEDPanelInterleave')).toBeVisible();
  await expect(page.locator('#panelMatrix1 .LEDPanelInterleaveLabel')).toBeVisible();
});

test('a matrix added to the cape with panels that need no interleave does not show the setting', async ({ page }) => {
  // Regression: e562b5370.  Interleave visibility was worked out on a size
  // change and when the page loaded, not when a matrix was added, so a new
  // matrix of 32x16 1/8 scan panels showed it.
  putCape();
  writeOutputs([]);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php#tab-LEDPanels');
  await page.locator('#tab-LEDPanels-tab').click();
  await page.locator('[onclick="AddPanelMatrixDialog();"]').click();
  const dialog = page.locator('#AddPanelMatrixDialog');
  await page.waitForFunction(() => document.querySelector('#AddPanelMatrixDialog.show'));
  await dialog.locator('#LEDPanelsConnectionSelect').selectOption('BBShiftPanel');
  await dialog.locator('#AddPanelButton').click();
  await expect(page.locator('#panelMatrix1 .LEDPanelOutputNumber_0_0')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toHaveValue('32x16x8');
  await expect(page.locator('#panelMatrix1 .LEDPanelInterleave')).toBeHidden();
  await expect(page.locator('#panelMatrix1 .LEDPanelInterleaveLabel')).toBeHidden();
});

test('a Pi 4 matrix with no GPIO slowdown saved gets the Pi 4 default of 1', async ({ page, request }) => {
  // Regression: 41624ee93.  The default was picked by matching SubPlatform
  // against "Raspberry Pi 4" and the like (59e22b4be), but SubPlatform is
  // the device tree's model ("Raspberry Pi 4 Model B Rev 1.4"), so no case
  // matched and every Pi got 0.
  await becomePi(request, 'Raspberry Pi 4 Model B Rev 1.4');
  const m: any = { ...matrix(1, 1, [64, 32, 16]), subType: 'RGBMatrix', ledPanelsOutputs: 3 };
  delete m.gpioSlowdown;
  writeOutputs([m]);
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsGPIOSlowdown')).toBeVisible();
  await expect(page.locator('#panelMatrix1 .LEDPanelsGPIOSlowdown')).toHaveValue('1');
});

test('Vendor Panel Properties fills in the panel settings a vendor publishes for the cape, and Save writes them', async ({ page, request }) => {
  // Feature: 430cb451c, 94277aa76.  The button lists the vendors in
  // fpp-data's panels/fpp-panels.json and each vendor's panels (430cb451c),
  // shows the panel's link (94277aa76), and Select applies the panel's
  // "all" settings and the ones for this connection.  GitHub is stood in
  // for with routes.
  const INDEX = 'https://raw.githubusercontent.com/FalconChristmas/fpp-data/refs/heads/master/panels/fpp-panels.json';
  const VENDOR = 'https://raw.githubusercontent.com/FalconChristmas/fpp-data/refs/heads/master/panels/fpp-tests-vendor.json';
  await page.route(INDEX, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ vendors: { 'fpp-tests vendor': { url: VENDOR } } }) }));
  await page.route(VENDOR, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { name: 'fpp-tests P4 64x32', url: 'https://example.invalid/p4',
      settings: { all: { panelWidth: 64, panelHeight: 32, panelScan: 16, panelColorOrder: 'RBG' }, BBShiftPanel: { panelType: 1 } } },
  ]) }));
  putCape();
  writeOutputs([matrix(1, 1, [32, 16, 8])]);
  await openPanels(page);
  await page.locator('#panelMatrix1 .vendorPanelSettingsBtn').click();
  const dialog = page.locator('#PanelSelectDialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.selectVendor').selectOption({ label: 'fpp-tests vendor' });
  await expect(dialog.locator('.selectPanel option')).toHaveText(['fpp-tests P4 64x32']);
  await expect(dialog.locator('.vendorPanelURL a')).toHaveAttribute('href', 'https://example.invalid/p4');
  await dialog.getByRole('button', { name: 'Select' }).click();
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toHaveValue('64x32x16');
  await expect(page.locator('#panelMatrix1 .LEDPanelsColorOrder')).toHaveValue('RBG');
  await expect(page.locator('#panelMatrix1 .LEDPanelsType')).toHaveValue('1');
  await expect(saveWarning(page)).toBeVisible();
  await panelSave(page).click();
  await expect.poll(async () => (await saved(request)).channelOutputs[0].ledPanelsSize, { timeout: 15_000 }).toBe('64x32x16');
  const m = (await saved(request)).channelOutputs[0];
  expect([m.panelWidth, m.panelHeight, m.panelScan, m.colorOrder, m.panelType]).toEqual([64, 32, 16, 'RBG', 1]);
  await expect(saveWarning(page), 'the warning once saved').toBeHidden();
});

test('a cape whose default connection is LEDscape runs the panel test pattern on the BBB panel output', async ({ page, request }) => {
  // Regression: bc891c624.  The cape's default connection was written into
  // the matrix's Connection Type <select> with .text(), which replaced its
  // options instead of choosing one, so the select had no value and the
  // Testing dropdown asked fppd for a pattern on output "".
  // Also 050f33a9a: the test pattern's output type for a LEDscapeMatrix
  // matrix is "BBB Panels" (it was left as the connection's own name).
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', 'sh',
    JSON.stringify({ name: 'FppTestsLEDscape', longName: 'fpp-tests LEDscape cape',
      defaults: { LEDPanelsConnection: 'LEDscapeMatrix' }, controls: {}, outputs: Array.from({ length: 8 }, () => ({})) }), CAPE);
  writeOutputs([matrix(1, 1, [32, 16, 8], 0, { subType: 'LEDscapeMatrix' })]);
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsConnectionSelect')).toHaveValue('LEDscapeMatrix');
  const started = page.waitForRequest((r) => r.url().endsWith('/api/command') && (r.postData() ?? '').includes('Test Start'));
  await page.locator('#PanelTestPatternType').selectOption('4');
  const body = JSON.parse((await started).postData()!);
  expect(body.args.slice(1, 3)).toEqual(['Output Specific', 'BBB Panels']);
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

test('on a PocketBeagle2 the Add Panel Matrix dialog offers the cape, by its driver', async ({ page, request }) => {
  // Regression: 3ca83a7e6.  The dialog offered "Hat/Cap/Cape" only when the
  // platform was exactly "BeagleBone Black", so a PocketBeagle2 ("BeagleBone
  // 64") could only add ColorLight, and a BBB got the old LEDscape driver
  // whatever cape it had.
  putCape();
  await becomePocketBeagle2(request);
  writeOutputs([]);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php#tab-LEDPanels');
  await page.locator('#tab-LEDPanels-tab').click();
  await page.locator('[onclick="AddPanelMatrixDialog();"]').click();
  const dialog = page.locator('#AddPanelMatrixDialog');
  await page.waitForFunction(() => document.querySelector('#AddPanelMatrixDialog.show'));
  await expect(dialog.locator("#LEDPanelsConnectionSelect option[value='BBShiftPanel']")).toHaveText('Hat/Cap/Cape');
  await dialog.locator('#LEDPanelsConnectionSelect').selectOption('BBShiftPanel');
  await dialog.locator('#AddPanelButton').click();
  await expect.poll(async () => (await saved(request)).channelOutputs.map((m: any) => m.subType), { timeout: 15_000 }).toEqual(['BBShiftPanel']);
});

test('a Pi matrix keeps an rpi-rgb-led-matrix multiplexing mapper from the later ones', async ({ page, request }) => {
  // Regression: 711d2beca.  The Pi's Panel Interleave list (the library's
  // multiplexing mappers) stopped at QiangLiQ8 (10), so a panel saved with a
  // later one, P10Outdoor32x16HalfScan (18) here, opened with none chosen
  // and was saved without it.  Page side: Docker has no rpi-rgb-led-matrix.
  await becomePi(request, 'Raspberry Pi 4 Model B Rev 1.4');
  writeOutputs([{ ...matrix(1, 1, [32, 16, 4]), subType: 'RGBMatrix', ledPanelsOutputs: 3, panelInterleave: '18' }]);
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelInterleave')).toHaveValue('18');
  await page.locator('#panelMatrix1 .LEDPanelsBrightness').selectOption('50');
  await panelSave(page).click();
  await expect.poll(async () => (await saved(request)).channelOutputs[0].brightness, { timeout: 15_000 }).toBe(50);
  expect((await saved(request)).channelOutputs[0].panelInterleave).toBe('18');
});

test('on a Beagle, a ColorLight matrix\'s brightness is a percentage and the cape\'s a 1-10 level', async ({ page, request }) => {
  // Regression: 9b83a5cc0.  The Brightness list followed the platform, not
  // the connection type: off a Pi it was BBBMatrix's 1-10 level for
  // ColorLight too, whose output reads a percentage (ColorLight-5a-75.cpp).
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', 'sh',
    JSON.stringify({ name: 'FppTestsLEDscape', longName: 'fpp-tests LEDscape cape',
      defaults: { LEDPanelsConnection: 'LEDscapeMatrix' }, controls: {}, outputs: Array.from({ length: 8 }, () => ({})) }), CAPE);
  writeOutputs([
    matrix(1, 1, [32, 16, 8], 0, { subType: 'ColorLight5a75', interface: 'eth0', brightness: 60 }),
    matrix(2, 1537, [32, 16, 8], 0, { subType: 'LEDscapeMatrix', brightness: 6 }),
  ]);
  await openPanels(page);
  const brightness = (id: number) => page.locator(`#panelMatrix${id} .LEDPanelsBrightness`);
  await expect(brightness(1)).toHaveValue('60');
  await expect(brightness(1).locator('option').first()).toHaveText('100%');
  await expect(brightness(2)).toHaveValue('6');
  await expect(brightness(2).locator('option').first()).toHaveText('10');
  await expect(brightness(2).locator('option')).toHaveCount(10);
  await brightness(1).selectOption('80');
  await panelSave(page).click();
  await expect.poll(async () => (await saved(request)).channelOutputs.map((m: any) => m.brightness), { timeout: 15_000 }).toEqual([80, 6]);
  expect(pageErrors).toEqual([]);
});
