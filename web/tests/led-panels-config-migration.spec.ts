import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// How the LED Panel Matrices tab reads a channeloutputs.json left by an older
// FPP (or by itself), and what it writes back: matrix numbering, panel size,
// panel orientation, the cfgVersion upgrade.  The config is written straight
// to media/config/channeloutputs.json.  fppd reloads its outputs whenever that
// file is written, so for ColorLight matrices (the panel output the container
// can run) the "LED Panels" model fppd builds from what the page saved is the
// receiving end.

test.skip(!container, 'writes the channel output config inside the run-web.sh container');

const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
const PLATFORM = '/etc/fpp/platform';

function writeOutputs(value: unknown) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(value), OUTPUTS);
}

let savedOutputs: string | null = null;
let savedPlatform: string | null = null;

test.beforeEach(() => {
  const out = inPlayer('sh', '-c', `if [ -e ${OUTPUTS} ]; then echo yes; cat ${OUTPUTS}; else echo no; fi`);
  savedOutputs = out.startsWith('yes\n') ? out.slice(4) : null;
  const plat = inPlayer('sh', '-c', `if [ -e ${PLATFORM} ]; then echo yes; cat ${PLATFORM}; else echo no; fi`);
  savedPlatform = plat.startsWith('yes\n') ? plat.slice(4) : null;
});

test.afterEach(async ({ request }) => {
  if (savedPlatform === null) inPlayer('rm', '-f', PLATFORM);
  else inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedPlatform, PLATFORM);
  if (savedOutputs === null) {
    // An empty config first, which fppd reloads to no panel outputs (it
    // ignores the file going away).
    writeOutputs({ channelOutputs: [] });
    await expect.poll(async () => (await panelModels(request)).length, { timeout: 10_000 }).toBe(0);
    inPlayer('rm', '-f', OUTPUTS);
  } else {
    inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  }
});

type Size = [number, number, number];

// A cols x rows grid of panels, each panel's row and col set, as every FPP
// since 8.x saved panels[].
function grid(cols: number, rows: number, w: number, h: number) {
  const panels = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      panels.push({ outputNumber: r, panelNumber: c, colorOrder: '', xOffset: c * w, yOffset: r * h,
                    orientation: 'N', row: r, col: c });
    }
  }
  return panels;
}

// A ColorLight matrix on eth0, as the page saves one today (cfgVersion 3).
function colorLight(cols: number, rows: number, size: Size, extra: Record<string, unknown> = {}) {
  const [w, h, s] = size;
  return {
    cfgVersion: 3, type: 'LEDPanelMatrix', subType: 'ColorLight5a75', panelMatrixID: 1, enabled: 1,
    startChannel: 1, channelCount: cols * w * rows * h * 3, interface: 'eth0', colorOrder: 'RGB', gamma: '2.2',
    brightness: 10, ledPanelsWidth: w, ledPanelsHeight: h, ledPanelsScan: s, panelWidth: w, panelHeight: h,
    panelScan: s, ledPanelsSize: size.join('x'), ledPanelsLayout: `${cols}x${rows}`, LEDPanelCols: cols,
    LEDPanelRows: rows, ledPanelsOutputs: 24, ledPanelsPanelsPerOutput: 24, invertedData: 0,
    LEDPanelUIFrontView: false, advanced: 0, panels: grid(cols, rows, w, h), ...extra,
  };
}

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
}

async function savedMatrices(request: APIRequestContext) {
  const c = await (await request.get('/api/configfile/channeloutputs.json')).json();
  return (c.channelOutputs as any[]).filter((o) => o.type === 'LEDPanelMatrix');
}

// The models fppd's ColorLight outputs created, as "WxH", by name.
async function panelModels(request: APIRequestContext) {
  const models = (await (await request.get('/api/models')).json()) as any[];
  return models.filter((m) => /^LED Panels/.test(m.Name))
    .map((m) => `${m.Name}=${m.ChannelCount / 3 / m.StringCount}x${m.StringCount}`).sort();
}

// Not in the hidden copy of the header that Zebra_Pin leaves in its place
// once the page scrolls and pins it.
const panelSave = (page: Page) => page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');
const saveWarning = (page: Page) => page.locator('#SaveChangeWarningLabel');

async function saveAndWait(page: Page, request: APIRequestContext, done: (m: any[]) => boolean) {
  const before = JSON.stringify(await savedMatrices(request));
  await panelSave(page).click();
  await expect.poll(async () => {
    const m = await savedMatrices(request);
    return JSON.stringify(m) !== before && done(m);
  }, { timeout: 15_000 }).toBe(true);
  return savedMatrices(request);
}

test('pre-v3 matrices saved without a panelMatrixID open in a tab each, and save as matrices 1 and 2', async ({ page, request }) => {
  // Regression: 95f418358.  A config from before the multi-matrix page has no
  // panelMatrixID; the page numbered the tabs it drew with "?? 1" (17927b92a),
  // so every such matrix landed on tab 1, one drawn over the other, and Save
  // wrote back only the one tab -- the other matrix was gone.  (Without an ID
  // matrix 1's W/H selects had no options either: see the test.fail below.)
  const first = colorLight(2, 1, [32, 16, 8]);
  const second = { ...colorLight(1, 1, [32, 16, 8]), startChannel: 2 * 32 * 16 * 3 + 1 };
  for (const m of [first, second] as any[]) {
    delete m.panelMatrixID;
    delete m.cfgVersion;
  }
  writeOutputs({ channelOutputs: [first, second] });
  await openPanels(page);
  await expect(page.locator('#matrixPanelTab1')).toBeVisible();
  await expect(page.locator('#matrixPanelTab2'), 'the second matrix\'s tab').toBeVisible();
  await expect(page.locator('#panelMatrix2 .LEDPanelsLayoutCols')).toHaveValue('1');
  await expect(page.locator('#panelMatrix1 .LEDPanelsLayoutCols')).toHaveValue('2');

  const m = await saveAndWait(page, request, (ms) => ms.every((x) => x.cfgVersion === 3));
  expect(m.map((x) => `${x.panelMatrixID}:${x.ledPanelsLayout}:${x.startChannel}`)).toEqual(['1:2x1:1', '2:1x1:3073']);
  // fppd, reloading the saved config, drives both matrices.
  await expect.poll(() => panelModels(request), { timeout: 15_000 })
    .toEqual(['LED Panels-1=32x16', 'LED Panels=64x16']);
});

test('with only matrix 2 saved, the page holds just that matrix and Add Panel Matrix takes number 1', async ({ page, request }) => {
  // Regression: dca5f6b77.  The page ran checkAndCorrectMissingChannelLookup
  // before it had read the saved matrices, found no matrices, and made up a
  // default matrix 1 that then sat next to the saved one: a matrix added
  // after matrix 1 was removed came out as number 3, not 1.
  writeOutputs({ channelOutputs: [colorLight(2, 1, [32, 16, 8], { panelMatrixID: 2 })] });
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#matrixPanelTab2')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#matrixPanelTab1')).toBeHidden();

  await page.locator('[onclick="AddPanelMatrixDialog();"]').click();
  const dlg = page.locator('#AddPanelMatrixDialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('#LEDPanelsConnectionSelect').selectOption('ColorLight5a75');
  await dlg.locator('#AddPanelButton').click();
  await expect(page.locator('#matrixPanelTab1'), 'the added matrix\'s tab').toBeVisible();
  await expect.poll(async () => (await savedMatrices(request)).map((x) => Number(x.panelMatrixID)).sort(), { timeout: 15_000 })
    .toEqual([1, 2]);
});

test('with no matrix 1 saved, the layout W/H selects still offer sizes and Save keeps the layout', async ({ page, request }) => {
  // Regression: 60aac2091.  printLEDPanelLayoutSelect(1) filled the W/H selects of the
  // tab template from readMatrixArrayValue(1, "maxLEDPanels"), which read
  // element [0] of a key-preserving array_filter.  Unless matrix 1 was the
  // first matrix in channeloutputs.json it found nothing, the selects of
  // every tab had no options, and Save wrote ledPanelsLayout "nullxnull"
  // with LEDPanelCols/LEDPanelRows null.
  writeOutputs({ channelOutputs: [colorLight(2, 1, [32, 16, 8], { panelMatrixID: 2 })] });
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await page.locator('#matrixPanelTab2 a').click();
  await expect(page.locator('#panelMatrix2 .LEDPanelsLayoutCols')).toHaveValue('2', { timeout: 5_000 });
  const m = await saveAndWait(page, request, () => true);
  expect(m.map((x) => `${x.panelMatrixID}:${x.ledPanelsLayout}`)).toEqual(['2:2x1']);
});

test('a ColorLight matrix of 80x40 panels opens and saves as 80x40, and fppd drives it so', async ({ page, request }) => {
  // Regression: 901916ee4 (#2236).  The ColorLight-only sizes (48x48 1/6,
  // 80x40 1/10 and 1/20) were offered only when a ".LEDPanelsConnectionType"
  // element read ColorLight5a75, and the page has none: they were never in
  // the list, and a saved 80x40 matrix opened with no size selected.
  writeOutputs({ channelOutputs: [colorLight(2, 1, [80, 40, 10])] });
  await openPanels(page);
  const size = page.locator('#panelMatrix1 .LEDPanelsSize');
  await expect(size).toHaveValue('80x40x10');
  for (const v of ['48x48x6', '80x40x20']) await expect(size.locator(`option[value='${v}']`)).toHaveCount(1);
  await expect(saveWarning(page)).toBeHidden();
  const [m] = await saveAndWait(page, request, () => true);
  expect([m.ledPanelsSize, m.panelWidth, m.panelHeight, m.panelScan]).toEqual(['80x40x10', 80, 40, 10]);
  expect(m.panels.find((p: any) => p.col === 1).xOffset).toBe(80);
  await expect.poll(() => panelModels(request), { timeout: 15_000 }).toEqual(['LED Panels=160x40']);
});

test('a v2 config with its panel size only in panelWidth/Height/Scan keeps that size', async ({ page, request }) => {
  // Regression: ba38a1aa6.  9.x saved the size as panelWidth, panelHeight
  // and panelScan; with no ledPanelsSize the page took the 32x16 1/8 default
  // and then overwrote panelWidth/Height/Scan from it, so the first Save
  // after an upgrade shrank every panel to 32x16.
  const m0: any = colorLight(2, 2, [64, 32, 16], { cfgVersion: 2 });
  delete m0.ledPanelsSize;
  writeOutputs({ channelOutputs: [m0] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toHaveValue('64x32x16');
  const [m] = await saveAndWait(page, request, (ms) => ms[0].cfgVersion === 3);
  expect([m.ledPanelsSize, m.panelWidth, m.panelHeight, m.panelScan]).toEqual(['64x32x16', 64, 32, 16]);
  await expect.poll(() => panelModels(request), { timeout: 15_000 }).toEqual(['LED Panels=128x64']);
});

test('a config with its panel size only in an upper-case LEDPanelsSize keeps that size', async ({ page, request }) => {
  // Regression: 2d43c7d2b.  A matrix carrying the size only as
  // "LEDPanelsSize" (no ledPanelsSize, no panelWidth/Height/Scan) fell to
  // the 32x16 1/8 default.
  const m0: any = colorLight(2, 1, [64, 32, 16], { cfgVersion: 2, LEDPanelsSize: '64x32x16' });
  for (const k of ['ledPanelsSize', 'panelWidth', 'panelHeight', 'panelScan']) delete m0[k];
  writeOutputs({ channelOutputs: [m0] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toHaveValue('64x32x16');
  const [m] = await saveAndWait(page, request, (ms) => ms[0].cfgVersion === 3);
  expect([m.ledPanelsSize, m.panelWidth, m.panelHeight, m.panelScan]).toEqual(['64x32x16', 64, 32, 16]);
  await expect.poll(() => panelModels(request), { timeout: 15_000 }).toEqual(['LED Panels=128x32']);
});

test('on a BeagleBone a v2 config keeps its panel addressing in the size', async ({ page, request }) => {
  // Feature: 2d43c7d2b appends panelAddressing to the size it rebuilds from
  // panelWidth/Height/Scan, so a 32x16 1/4 ABCD panel opens as such.
  // Regression: fc03cd825.  PanelSubtypeChanged then called
  // SetSinglePanelSize, which appended the addressing only if
  // "panelAddressing" was a key of the whole channelOutputsLookup (never),
  // so it set the size back to "32x16x4" and Save wrote the panel without
  // its addressing.  (Beagle only: the
  // addressed sizes are offered on a BeagleBone.  fppd in this tree reads no
  // panelAddressing, so the page and the saved file are all there is.)
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > ${PLATFORM}`);
  const m0: any = colorLight(1, 1, [32, 16, 4], { cfgVersion: 2, subType: 'LEDscapeMatrix', panelAddressing: 1 });
  delete m0.ledPanelsSize;
  delete m0.interface;
  writeOutputs({ channelOutputs: [m0] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toHaveValue('32x16x4x1');
  const [m] = await saveAndWait(page, request, (ms) => ms[0].cfgVersion === 3);
  expect([m.ledPanelsSize, m.panelAddressing]).toEqual(['32x16x4x1', 1]);
});

test('a matrix saved without its output and chain counts gets the defaults, and keeps its panel numbers', async ({ page, request }) => {
  // Regression: 09990ed4d.  The defaults the page fills in were looked up
  // under names nothing set (LEDPanelDefaults.LEDPanelPanelsPerOutput, not
  // LEDPanelsPanelsPerOutput), so a matrix saved without
  // ledPanelsPanelsPerOutput got panel-number selects with no options, and
  // Save wrote every panel's panelNumber as null.
  const m0: any = colorLight(2, 2, [32, 16, 8], { cfgVersion: 2 });
  delete m0.ledPanelsOutputs;
  delete m0.ledPanelsPanelsPerOutput;
  writeOutputs({ channelOutputs: [m0] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelPanelNumber_1_1 option')).toHaveCount(24);
  await expect(page.locator('#panelMatrix1 .LEDPanelPanelNumber_1_1')).toHaveValue('1');
  await expect(page.locator('#panelMatrix1 .LEDPanelOutputNumber_1_1')).toHaveValue('1');
  const [m] = await saveAndWait(page, request, (ms) => ms[0].cfgVersion === 3);
  expect([m.ledPanelsOutputs, m.ledPanelsPanelsPerOutput]).toEqual([24, 24]);
  expect(m.panels.map((p: any) => `${p.row},${p.col}:${p.outputNumber}-${p.panelNumber}`).sort())
    .toEqual(['0,0:0-0', '0,1:0-1', '1,0:1-0', '1,1:1-1']);
  await expect.poll(() => panelModels(request), { timeout: 15_000 }).toEqual(['LED Panels=64x32']);
});

test('a ColorLight matrix shows its brightness', async ({ page }) => {
  // Regression: 2eb7dc208.  The new page hid the Brightness control for
  // ColorLight as well as X11 (the old page showed it for ColorLight, whose
  // receiver card takes a brightness), so it could not be seen or set.
  writeOutputs({ channelOutputs: [colorLight(2, 1, [32, 16, 8], { brightness: 6 })] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsBrightness')).toBeVisible();
  await expect(page.locator('#panelMatrix1 .LEDPanelsBrightness')).toHaveValue('6');
});

test.fail('Save keeps a ColorLight matrix\'s brightness on a player that is neither a Pi nor a Beagle', async ({ page, request }) => {
  // Bug on master: GetLEDPanelConfigFromUI writes config.brightness only
  // when the platform is "Raspberry Pi" or a BeagleBone, though the control
  // is shown for ColorLight everywhere and the ColorLight output reads
  // "brightness" (ColorLight-5a-75.cpp, 0 or missing = full).  On any other
  // player (an x86 Debian install, this container) Save drops it, and the
  // receiver card goes to full brightness.
  writeOutputs({ channelOutputs: [colorLight(2, 1, [32, 16, 8], { brightness: 6 })] });
  await openPanels(page);
  await page.locator('#panelMatrix1 .LEDPanelsBrightness').selectOption('4');
  const [m] = await saveAndWait(page, request, () => true);
  expect(m.brightness).toBe(4);
});

test('the config-upgrade banner names each pre-v3 matrix, and a v3 config shows none', async ({ page }) => {
  // Feature: 917449427.  A matrix saved before cfgVersion 3 is flagged on
  // load with a banner naming it and its version, asking for a Save.
  writeOutputs({ channelOutputs: [colorLight(2, 1, [32, 16, 8], { cfgVersion: 2, LEDPanelMatrixName: 'Wall' })] });
  await openPanels(page);
  const banner = page.locator('.configUpgradeWarning');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Wall (v2)');
  await expect(saveWarning(page)).toBeVisible();

  writeOutputs({ channelOutputs: [colorLight(2, 1, [32, 16, 8])] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsLayoutCols')).toHaveValue('2');
  await expect(banner).toHaveCount(0);
  await expect(saveWarning(page)).toBeHidden();
});

const orientationAt = async (request: APIRequestContext, r: number, c: number) =>
  (await savedMatrices(request))[0]?.panels?.find((p: any) => p.row === r && p.col === c)?.orientation;
const icon = (page: Page, r: number, c: number) => page.locator(`#panelMatrix1 .LEDPanelOrientation_${r}_${c}`);

test('a panel turned once in Front View is saved as the same turn as from the back', async ({ page, request }) => {
  // Regression: a17a826f2.  The arrow turned the same way whichever side the
  // grid was drawn from, so one click in Front View saved the opposite turn
  // ("R") to one click in Back View ("L").
  writeOutputs({ channelOutputs: [colorLight(2, 1, [32, 16, 8], { LEDPanelUIFrontView: true })] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelUIFrontView')).toBeChecked();
  await icon(page, 0, 0).click();
  await expect(icon(page, 0, 0)).toHaveAttribute('data-orientation', 'L');
  await panelSave(page).click();
  await expect.poll(() => orientationAt(request, 0, 0), { timeout: 15_000 }).toBe('L');
  expect(await orientationAt(request, 0, 1)).toBe('N');
});

test('orientation is stored as seen from the front, and drawn mirrored in Back View', async ({ page, request }) => {
  // Regression: 877382683.  The grid drew and saved each arrow as it was
  // drawn, whichever side it was drawn from, so a panel turned in Back View
  // was stored mirrored ("R" for a turn that is "L" from the front).  Now
  // the stored value is the front view, and Back View draws L as R.
  const m0: any = colorLight(2, 1, [32, 16, 8]);
  m0.panels[0].orientation = 'L';
  m0.panels[1].xOffset = 16;
  writeOutputs({ channelOutputs: [m0] });
  await openPanels(page);
  await expect(icon(page, 0, 0)).toHaveAttribute('data-orientation', 'R');
  await expect(icon(page, 0, 1)).toHaveAttribute('data-orientation', 'N');
  await expect(saveWarning(page)).toBeHidden();
  // A Save of what is shown stores it unchanged.
  await saveAndWait(page, request, (ms) => ms[0].LEDPanelCols === 2);
  expect(await orientationAt(request, 0, 0)).toBe('L');
  // fppd: a quarter-turned 32x16 panel is 16 wide, so the matrix is 48x32.
  await expect.poll(() => panelModels(request), { timeout: 15_000 }).toEqual(['LED Panels=48x32']);
});

test('toggling Front View leaves the stored orientation alone', async ({ page, request }) => {
  // Feature: 877382683 mirrors the arrows when Front View is toggled, so
  // the panel shown stays the same panel.  Regression: dd940d5c8.  Since
  // acd4ce0b3 FrontBackViewToggled found the arrows with
  // [class^="LEDPanelOrientation_"], but the Font Awesome icons' class starts
  // "fa fa-xl ...", so nothing was mirrored; GetLEDPanelConfigFromUI then
  // read the Back View arrow (R) as a front-view R, and toggling Front View
  // and saving turned every quarter-turned panel half way round (L <-> R).
  const m0: any = colorLight(2, 1, [32, 16, 8]);
  m0.panels[0].orientation = 'L';
  m0.panels[1].xOffset = 16;
  writeOutputs({ channelOutputs: [m0] });
  await openPanels(page);
  await expect(icon(page, 0, 0)).toHaveAttribute('data-orientation', 'R');
  await page.locator('#panelMatrix1 .LEDPanelUIFrontView').check();
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrices(request))[0]?.LEDPanelUIFrontView, { timeout: 15_000 }).toBe(true);
  expect(await orientationAt(request, 0, 0), 'the turned panel after a Save in Front View').toBe('L');
});

test('turning a panel flags the matrix as needing a Save', async ({ page }) => {
  // Regression: 7634c4052.  The orientation arrows changed the grid without
  // going through the change detection the other controls use, so the
  // "changes need saving" warning never showed for a turned panel.
  writeOutputs({ channelOutputs: [colorLight(2, 1, [32, 16, 8])] });
  await openPanels(page);
  await expect(saveWarning(page)).toBeHidden();
  await icon(page, 0, 1).click();
  await expect(saveWarning(page)).toBeVisible();
});

test('panels saved without an orientation open upright and save as "N"', async ({ page, request }) => {
  // Coverage: 7672b1296 (an arrow for a panel with no orientation was drawn
  // from "images/arrow_undefined.png").
  const m0: any = colorLight(2, 1, [32, 16, 8]);
  for (const p of m0.panels) delete p.orientation;
  writeOutputs({ channelOutputs: [m0] });
  await openPanels(page);
  await expect(icon(page, 0, 0)).toHaveAttribute('data-orientation', 'N');
  await expect(icon(page, 0, 1)).toHaveAttribute('data-orientation', 'N');
  await panelSave(page).click();
  await expect.poll(() => orientationAt(request, 0, 0), { timeout: 15_000 }).toBe('N');
  expect(await orientationAt(request, 0, 1)).toBe('N');
});

test('a ColorLight matrix saved by the page reopens with no unsaved-changes warning', async ({ page, request }) => {
  // Regression: d4a023f18, 0f55d7646.  The page gave every matrix a default
  // wiringPinout (the GPIO pinout of a Pi/Beagle hat) when it loaded or
  // added one; a ColorLight matrix never saves one, so the saved and loaded
  // configs always differed and the warning showed on every visit.
  writeOutputs({ channelOutputs: [] });
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await page.locator('[onclick="AddPanelMatrixDialog();"]').click();
  const dlg = page.locator('#AddPanelMatrixDialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('#LEDPanelsConnectionSelect').selectOption('ColorLight5a75');
  await dlg.locator('#AddPanelButton').click();
  await expect.poll(async () => (await savedMatrices(request)).length, { timeout: 15_000 }).toBe(1);
  expect((await savedMatrices(request))[0].wiringPinout).toBeUndefined();
  await expect(saveWarning(page)).toBeHidden();
  await page.reload();
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toBeVisible({ timeout: 15_000 });
  await expect(saveWarning(page)).toBeHidden();
});
