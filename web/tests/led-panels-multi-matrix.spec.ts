import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Several LED panel matrices on one BeagleBone panel cape (BBShiftPanel).
// The player claims to be a BeagleBone for the length of each test
// (config.php reads /etc/fpp/platform); fppd, already running, is not
// affected, and has no BBShiftPanel driver in Docker -- so what is checked
// is the page and the channeloutputs.json it saves, not a panel lit.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
const CAPE = '/home/fpp/media/tmp/panels/FppTestsPanels.json';

const matrix = (id: number, start: number, size: [number, number, number], output: number) => ({
  cfgVersion: 3, type: 'LEDPanelMatrix', subType: 'BBShiftPanel', panelMatrixID: id, enabled: 1, startChannel: start,
  channelCount: size[0] * size[1] * 3, ledPanelsWidth: size[0], ledPanelsHeight: size[1], ledPanelsScan: size[2],
  panelWidth: size[0], panelHeight: size[1], panelScan: size[2], ledPanelsSize: size.join('x'), colorOrder: 'RGB',
  gamma: '2.2', brightness: 10, ledPanelsLayout: '1x1', ledPanelsOutputs: 8, ledPanelsPanelsPerOutput: 16,
  panelColorDepth: 8, invertedData: 0, panelOutputOrder: false, panelOutputBlankRow: false, panelRowAddressType: 0,
  panelType: 0, panelInterleave: '8', panelDataLayout: 0,
  panels: [{ outputNumber: output, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
});

function writeOutputs(matrices: object[]) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({ channelOutputs: matrices }), OUTPUTS);
}
const saved = (request: APIRequestContext) => request.get('/api/configfile/channeloutputs.json').then((r) => r.json());

let savedPlatform = '';
let savedOutputs = '';
test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  savedOutputs = inPlayer('sh', '-c', `cat ${OUTPUTS} 2>/dev/null || true`);
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > ${PLATFORM}`);
});
test.afterEach(() => {
  inPlayer('rm', '-f', CAPE);
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  if (savedOutputs) inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  else inPlayer('rm', '-f', OUTPUTS);
});

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php#tab-LEDPanels');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toBeAttached({ timeout: 15_000 });
}

test('a second matrix on the cape takes its panel settings from the first, and is saved with them', async ({ page, request }) => {
  // Feature: 094520930.  The cape shifts one frame out of all its outputs,
  // so the panel settings belong to the cape: the second matrix hides its
  // Panel Settings box, says where they come from, and is saved with the
  // first one's panel size.
  writeOutputs([matrix(1, 1, [64, 32, 8], 0), matrix(2, 6145, [32, 16, 8], 1)]);
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .divPanelSettingsSection')).not.toHaveClass(/d-none/);
  await expect(page.locator('#panelMatrix2 .divPanelSettingsSection')).toHaveClass(/d-none/);
  await expect(page.locator('#panelMatrix2 .divSharedCapeNote')).toContainText('Panel settings come from Panel Matrix 1');
  await expect(page.locator('#panelMatrix2 .LEDPanelsSize')).toHaveValue('64x32x8');

  await page.locator('input[value="Save"][onclick="SaveLEDPanelsConfig();"]').click();
  await expect.poll(async () => (await saved(request)).channelOutputs.map((m: any) => m.ledPanelsSize), { timeout: 15_000 })
    .toEqual(['64x32x8', '64x32x8']);
  const got = (await saved(request)).channelOutputs;
  expect(got.map((m: any) => [m.panelWidth, m.panelHeight, m.panelScan])).toEqual([[64, 32, 8], [64, 32, 8]]);
  expect(got.map((m: any) => m.startChannel), 'each matrix keeps its own start').toEqual([1, 6145]);
});

test('two matrices on one cape output are flagged and the save is refused', async ({ page, request }) => {
  // Feature: 094520930.  fppd refuses the second matrix outright when two
  // claim the same output, so the page flags it and will not save.
  writeOutputs([matrix(1, 1, [64, 32, 8], 0), matrix(2, 6145, [64, 32, 8], 0)]);
  const before = JSON.stringify(await saved(request));
  await openPanels(page);
  await page.locator('input[value="Save"][onclick="SaveLEDPanelsConfig();"]').click();
  await expect(page.locator('#dialogOKPopup')).toContainText('Two panel matrices are configured to use the same cape output');
  await expect(page.locator('#panelMatrix2 .divLEDPanelOutputConflict')).toContainText('Cape output 1 is used by both Panel Matrix 1 and Panel Matrix 2');
  await page.waitForTimeout(1500);
  expect(JSON.stringify(await saved(request)), 'channeloutputs.json').toBe(before);
});

test('a matrix added to the cape starts past the channels of the one already there', async ({ page }) => {
  // Feature: 094520930.  A new cape matrix inherited nothing and started at
  // channel 1, silently overlaying the first one's channels.
  // The Add dialog offers the cape's driver once a panel cape is detected,
  // which cape detection says in media/tmp/panels.
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', 'sh',
    JSON.stringify({ name: 'FppTestsPanels', longName: 'fpp-tests panel cape', driver: 'BBShiftPanel',
      defaults: { LEDPanelsConnection: 'BBShiftPanel' }, controls: {}, outputs: Array.from({ length: 8 }, () => ({})) }), CAPE);
  writeOutputs([matrix(1, 1, [64, 32, 8], 0)]);
  await openPanels(page);
  await page.locator('[onclick="AddPanelMatrixDialog();"]').click();
  const dialog = page.locator('#AddPanelMatrixDialog');
  await expect(dialog.locator('#LEDPanelsConnectionSelect')).toBeVisible();
  await dialog.locator('#LEDPanelsConnectionSelect').selectOption('BBShiftPanel');
  await dialog.locator('#AddPanelButton').click();
  await expect(page.locator('#panelMatrix2 .LEDPanelsStartChannel')).toHaveValue('6145', { timeout: 10_000 });
  await expect(page.locator('#panelMatrix2 .LEDPanelsSize')).toHaveValue('64x32x8');
});
