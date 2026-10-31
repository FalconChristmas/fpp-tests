import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The LED Panel Matrices tab of Channel Outputs, as rewritten for 9.0: one
// tab per matrix, change detection that shows "unsaved changes" when the page
// differs from what is saved, and what Save then writes.  The ColorLight
// output is the panel output the container's fppd builds, so where the page
// saves, the "LED Panels" model fppd makes from channeloutputs.json is the
// receiving end.

test.skip(!container, 'writes the channel output config inside the run-web.sh container');

const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';

function writeOutputs(value: unknown) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(value), OUTPUTS);
}

let savedOutputs: string | null = null;
let pageErrors: string[] = [];

test.beforeEach(({ page }) => {
  const out = inPlayer('sh', '-c', `if [ -e ${OUTPUTS} ]; then echo yes; cat ${OUTPUTS}; else echo no; fi`);
  savedOutputs = out.startsWith('yes\n') ? out.slice(4) : null;
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
});

test.afterEach(async ({ request }) => {
  if (savedOutputs === null) {
    writeOutputs({ channelOutputs: [] });
    await expect.poll(async () => (await panelModel(request)) ?? null, { timeout: 10_000 }).toBeNull();
    inPlayer('rm', '-f', OUTPUTS);
  } else {
    inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  }
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

// A ColorLight matrix as the page saves it today: cols x rows panels of the
// given size, numbered the way Auto Layout numbers them.
function colorlight(size: [number, number, number] = [32, 16, 8], cols = 2, rows = 2, id = 1) {
  const [w, h, s] = size;
  const panels = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      panels.push({ outputNumber: r, panelNumber: cols - c - 1, colorOrder: '', xOffset: c * w, yOffset: r * h,
                    orientation: 'N', row: r, col: c });
    }
  }
  return {
    cfgVersion: 3, type: 'LEDPanelMatrix', subType: 'ColorLight5a75', panelMatrixID: id, enabled: 1, startChannel: 1,
    channelCount: cols * rows * w * h * 3, interface: 'eth0', ledPanelsWidth: w * cols, ledPanelsHeight: h * rows,
    panelWidth: w, panelHeight: h, panelScan: s, ledPanelsSize: size.join('x'), ledPanelsLayout: `${cols}x${rows}`,
    colorOrder: 'RGB', gamma: '2.2', brightness: 10, ledPanelsOutputs: 24, ledPanelsPanelsPerOutput: 24, panels,
  };
}

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toBeAttached({ timeout: 15_000 });
  // The tab's initialisation is a chain of ajax promises; the matrix table is
  // the last thing it draws.
  await expect(page.locator('#panelMatrix1 .LEDPanelOutputNumber_0_0')).toBeAttached({ timeout: 15_000 });
}

async function savedMatrix(request: APIRequestContext, id = 1) {
  const c = await (await request.get('/api/configfile/channeloutputs.json')).json();
  return c.channelOutputs.find((o: any) => o.type === 'LEDPanelMatrix' && Number(o.panelMatrixID ?? 1) === id);
}

async function panelModel(request: APIRequestContext) {
  return ((await (await request.get('/api/models')).json()) as any[]).find((m) => m.Name === 'LED Panels');
}
const modelSize = async (request: APIRequestContext) => {
  const pm = await panelModel(request);
  return pm ? `${pm.ChannelCount / 3 / pm.StringCount}x${pm.StringCount}` : 'none';
};

const panelSave = (page: Page) => page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');
const saveWarning = (page: Page) => page.locator('#SaveChangeWarningLabel:not(.Zebra_Pin_Clone *)');

test('a ColorLight matrix of 128x64 1/16 scan panels opens as that size and fppd drives it', async ({ page, request }) => {
  // Regression: 08b51e700.  The size list offered 128x64 panels only at 1/32
  // scan, so a 1/16 scan one opened as some other size and Save wrote that.
  writeOutputs({ channelOutputs: [colorlight([128, 64, 16], 1, 1)] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toHaveValue('128x64x16');
  await expect(saveWarning(page), 'unsaved changes on a page just opened').toBeHidden();
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.ledPanelsSize, { timeout: 15_000 }).toBe('128x64x16');
  const m = await savedMatrix(request);
  expect([m.panelWidth, m.panelHeight, m.panelScan]).toEqual([128, 64, 16]);
  await expect.poll(() => modelSize(request), { timeout: 15_000 }).toBe('128x64');
});

test('a ColorLight matrix hides the Connection Type picker, which was chosen when the matrix was added', async ({ page }) => {
  // Regression: 5e93259c8.  The connection is asked for in the Add Panel
  // Matrix dialog; a ColorLight matrix still showed a Connection Type
  // dropdown over it.
  writeOutputs({ channelOutputs: [colorlight()] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsInterface')).toBeVisible();
  await expect(page.locator('#panelMatrix1 .LEDPanelsConnectionSelect')).toBeHidden();
  await expect(page.locator('#panelMatrix1 .LEDPanelsConnectionSelect')).toHaveValue('ColorLight5a75');
});

test('Auto Layout renumbering the panels shows the unsaved changes warning, and Save writes the new numbering', async ({ page, request }) => {
  // Regression: b40dac176.  Auto Layout rewrote every output and panel
  // number but left the "unsaved changes" warning hidden.
  const m = colorlight([32, 16, 8], 2, 2);
  // numbered left to right, the reverse of what Auto Layout does
  m.panels.forEach((p: any) => { p.panelNumber = p.col; });
  writeOutputs({ channelOutputs: [m] });
  await openPanels(page);
  await expect(saveWarning(page)).toBeHidden();
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Y' : undefined));
  await page.locator('#panelMatrix1 input[value="Auto Layout"]').click();
  await expect(page.locator('#panelMatrix1 .LEDPanelPanelNumber_0_0')).toHaveValue('1');
  await expect(saveWarning(page), 'the warning after Auto Layout').toBeVisible();
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.panels?.find((p: any) => p.row === 0 && p.col === 0)?.panelNumber,
    { timeout: 15_000 }).toBe(1);
  await expect(saveWarning(page)).toBeHidden();
  await expect.poll(() => modelSize(request), { timeout: 15_000 }).toBe('64x32');
});

test('changing a control in the Add Panel Matrix dialog is not an unsaved change to the matrix on the page', async ({ page }) => {
  // Regression: 9370f6428.  Change detection listened to every input on the
  // page, so picking a connection in the Add dialog flagged the saved matrix
  // as changed.
  writeOutputs({ channelOutputs: [colorlight()] });
  await openPanels(page);
  await expect(saveWarning(page)).toBeHidden();
  await page.locator('[onclick="AddPanelMatrixDialog();"]').click();
  const sel = page.locator('#AddPanelMatrixDialog #LEDPanelsConnectionSelect');
  await expect(sel).toBeVisible();
  const opts = await sel.locator('option:not([disabled])').evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value));
  await sel.selectOption(opts[opts.length - 1]);
  await sel.selectOption(opts[0]);
  await page.waitForTimeout(500);
  await expect(saveWarning(page)).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test('a page whose only matrix is not Panel Matrix 1 loads without a script error', async ({ page, request }) => {
  // Regression: 7930d9ca2.  The page checks Panel Matrix 1's network
  // interface speed as it loads; with no Panel Matrix 1 there is no
  // interface to read and the check threw.
  writeOutputs({ channelOutputs: [colorlight([32, 16, 8], 2, 2, 2)] });
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix2 .LEDPanelOutputNumber_0_0')).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(500);
  expect(pageErrors).toEqual([]);
});

test('a ColorLight matrix on an interface slower than 1000 Mbps is warned about', async ({ page }) => {
  // Regression: 66c912a57.  WarnIfSlowNIC parsed the interface speed out of
  // the dropdown text but threw the number away (NicSpeed stayed 1000, since
  // 7930d9ca2), so the "does not support 1000+ Mbps" warning never showed.
  // ethtool stands in for a 100 Mbps NIC (the container has none).
  // Also f2a4350cc (the warning added to the page) and 132658102 (the speed
  // written into each interface's option text, which the warning reads).
  inPlayer('sh', '-c', `printf '#!/bin/sh\\necho "Supported link modes:   10baseT/Full 100baseT/Full"\\necho "Speed: 100Mb/s"\\n' > /usr/local/bin/ethtool && chmod +x /usr/local/bin/ethtool`);
  try {
    writeOutputs({ channelOutputs: [colorlight()] });
    await openPanels(page);
    await expect(page.locator('#panelMatrix1 .LEDPanelsInterface option:checked')).toHaveText(/\(100Mbps\)/);
    await expect(page.locator('#panelMatrix1 .divLEDPanelWarnings')).toContainText('does not support 1000+ Mbps', { timeout: 5000 });
  } finally {
    inPlayer('rm', '-f', '/usr/local/bin/ethtool');
  }
});

// Opens the Add Panel Matrix dialog, picks the connection and adds it.
async function addMatrix(page: Page, connection: string) {
  await page.locator('[onclick="AddPanelMatrixDialog();"]').click();
  const dialog = page.locator('#AddPanelMatrixDialog');
  await expect(dialog).toBeVisible();
  await page.waitForFunction(() => document.querySelector('#AddPanelMatrixDialog.show'));
  await dialog.locator('#LEDPanelsConnectionSelect').selectOption(connection);
  await dialog.locator('#AddPanelButton').click();
  await expect(dialog).toBeHidden();
}
const savedIDs = async (request: APIRequestContext) =>
  ((await (await request.get('/api/configfile/channeloutputs.json')).json()).channelOutputs as any[])
    .filter((o) => o.type === 'LEDPanelMatrix').map((o) => Number(o.panelMatrixID)).sort();

test('two matrices added one after the other get the next two tabs, and both are saved', async ({ page, request }) => {
  // Regression: 833d5b4ac.  The new matrix's number was worked out when the
  // dialog was opened, and DoModalDialog then kept the first opening's Add
  // handler for good, so the second Add reused that number and replaced the
  // matrix just added.  (DoModalDialog has rebuilt the buttons on every
  // opening since ea919034f, which hides the bug on its own.)
  writeOutputs({ channelOutputs: [colorlight()] });
  await openPanels(page);
  await addMatrix(page, 'ColorLight5a75');
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([1, 2]);
  await addMatrix(page, 'ColorLight5a75');
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([1, 2, 3]);
  for (const id of [1, 2, 3]) await expect(page.locator(`#matrixPanelTab${id}`)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('a fifth ColorLight matrix is not offered in the Add dialog', async ({ page, request }) => {
  // Regression: de15d8d67.  The Add dialog offered ColorLight however many
  // ColorLight matrices there already were (four is the most).
  writeOutputs({ channelOutputs: [1, 2, 3, 4].map((id) => ({ ...colorlight([32, 16, 8], 2, 2, id), startChannel: 1 + (id - 1) * 6144 })) });
  await openPanels(page);
  await page.locator('[onclick="AddPanelMatrixDialog();"]').click();
  const sel = page.locator('#AddPanelMatrixDialog #LEDPanelsConnectionSelect');
  await expect(sel).toBeVisible();
  const cl = sel.locator("option[value='ColorLight5a75']");
  await expect(cl).toBeDisabled();
  await expect(cl).toContainText('(max number reached)');
  expect(pageErrors).toEqual([]);
});

test('Save writes the matrix layout and the outputs the receiver has, not its column count', async ({ page, request }) => {
  // Regression: e2caa46ec.  Save wrote the number of panel columns as
  // ledPanelsOutputs (2 for a 2x2 matrix on a 24 output ColorLight card) and
  // no LEDPanelRows/LEDPanelCols.
  const m = colorlight([32, 16, 8], 3, 2);
  writeOutputs({ channelOutputs: [m] });
  await openPanels(page);
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.LEDPanelCols, { timeout: 15_000 }).toBe(3);
  const got = await savedMatrix(request);
  expect(got.LEDPanelRows).toBe(2);
  expect(got.ledPanelsOutputs).toBe(24);
  expect(got.ledPanelsLayout).toBe('3x2');
  await expect.poll(() => modelSize(request), { timeout: 15_000 }).toBe('96x32');
});

// The page writes panelMatrixID as the tab's text (a string), and compares
// against what it saved that way.
const asSaved = (m: Record<string, unknown>) => ({ ...m, panelMatrixID: String(m.panelMatrixID) });

test('a change shows the unsaved changes warning, and Save takes it away for good', async ({ page, request }) => {
  // Regression: 1430e7f67, 88ccf3702.  Nothing re-checked for changes once
  // Save had written the config (1430e7f67), and then the re-check ran
  // against a reload of channeloutputs.json still in flight, so it compared
  // with the config from before the Save and put the warning back up
  // (88ccf3702).  (The colour order: brightness is only saved for Pi and
  // Beagle panel outputs.)
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  const colorOrder = page.locator('#panelMatrix1 .LEDPanelsColorOrder');
  await expect(colorOrder).toHaveValue('RGB');
  await colorOrder.selectOption('GRB');
  await expect(saveWarning(page)).toBeVisible();
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.colorOrder, { timeout: 15_000 }).toBe('GRB');
  await page.waitForTimeout(1500);
  await expect(saveWarning(page), 'the warning once Save has written the change').toBeHidden();
});

test('changing a setting and changing it back leaves no unsaved changes warning', async ({ page, request }) => {
  // Regression: 5892ff19a.  Change detection sorted only the top level of
  // the saved and on-page configs, so panels saved in another order, or with
  // their keys in another order, differed from the list the page builds
  // (Auto Layout's, here) though every panel was the same.
  writeOutputs({ channelOutputs: [colorlight()] });
  await openPanels(page);
  // What the page itself saves, then listed column by column with each
  // panel's keys in alphabetical order, as another tool might write it.
  await panelSave(page).click();
  await expect.poll(async () => typeof (await savedMatrix(request))?.panelMatrixID, { timeout: 15_000 }).toBe('string');
  const m = await savedMatrix(request);
  m.panels = [...m.panels].sort((x: any, y: any) => x.col - y.col || x.row - y.row)
    .map((pn: any) => Object.fromEntries(Object.entries(pn).sort(([x], [y]) => x.localeCompare(y))));
  writeOutputs({ channelOutputs: [m] });
  await openPanels(page);
  // Auto Layout rebuilds the panel list, in its own order, with the numbering
  // already saved: nothing has changed.
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Y' : undefined));
  await page.locator('#panelMatrix1 input[value="Auto Layout"]').click();
  await page.waitForTimeout(500);
  await expect(saveWarning(page), 'the warning after an Auto Layout that changed nothing').toBeHidden();
  const colorOrder = page.locator('#panelMatrix1 .LEDPanelsColorOrder');
  await colorOrder.selectOption('GRB');
  await expect(saveWarning(page)).toBeVisible();
  await colorOrder.selectOption('RGB');
  await expect(saveWarning(page), 'the warning once the change is undone').toBeHidden();
  expect(pageErrors).toEqual([]);
});

test('a matrix saved with a numeric panelMatrixID can be edited without a script error', async ({ page }) => {
  // Regression: 8d70bd6c3.  Change detection looks the matrix up in the
  // saved config by the tab's text; one it does not find there (a numeric
  // panelMatrixID, as the page gives a pre-v3 config, or a matrix not yet
  // saved) threw on every change.
  writeOutputs({ channelOutputs: [colorlight()] });
  await openPanels(page);
  await page.locator('#panelMatrix1 .LEDPanelsColorOrder').selectOption('GRB');
  await expect(saveWarning(page)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('a matrix saved with a numeric panelMatrixID shows no unsaved changes once a change is undone', async ({ page, request }) => {
  // Regression: fe4db9e56.  Change detection found the saved matrix by
  // comparing its panelMatrixID with the tab's id, a string, using ===, so
  // a config with a numeric ID (as a pre-v3 upgrade gives) was compared with
  // nothing, and every change, even one undone, left the warning up.
  writeOutputs({ channelOutputs: [colorlight()] });
  await openPanels(page);
  // What the page itself saves, with the ID made a number again.
  await panelSave(page).click();
  await expect.poll(async () => typeof (await savedMatrix(request))?.panelMatrixID, { timeout: 15_000 }).toBe('string');
  writeOutputs({ channelOutputs: [{ ...(await savedMatrix(request)), panelMatrixID: 1 }] });
  await openPanels(page);
  const colorOrder = page.locator('#panelMatrix1 .LEDPanelsColorOrder');
  await colorOrder.selectOption('GRB');
  await expect(saveWarning(page)).toBeVisible();
  await colorOrder.selectOption('RGB');
  await expect(saveWarning(page), 'the warning once the change is undone').toBeHidden();
  expect(pageErrors).toEqual([]);
});

async function removeMatrix(page: Page, id: number) {
  await page.locator(`#matrixPanelTab${id} a`).click();
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Y' : undefined));
  await page.locator(`#panelMatrix${id} input[value="Remove Panel Matrix"]`).click();
  await expect(page.locator(`#matrixPanelTab${id}`)).toBeHidden();
}

test('removing the only matrix and adding a new one works, and fppd drives the new one', async ({ page, request }) => {
  // Regression: 96b333075.  Removing the last matrix picked the next tab to
  // show from an empty list and threw, and the page then could not add one.
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  await removeMatrix(page, 1);
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([]);
  await expect.poll(async () => (await panelModel(request)) ?? null, { timeout: 15_000 }).toBeNull();
  await addMatrix(page, 'ColorLight5a75');
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([1]);
  await expect(page.locator('#matrixPanelTab1')).toBeVisible();
  await expect(page.locator('#panelMatrix1 .LEDPanelOutputNumber_0_0')).toBeAttached();
  // the new matrix's 2x2 32x16 default, driven
  await expect.poll(() => modelSize(request), { timeout: 15_000 }).toBe('64x32');
});

test('removing Panel Matrix 1 shows the matrix that is left', async ({ page, request }) => {
  // Regression: 7bc9d79d2.  The tab to show next was picked only if the
  // matrix list had a length, which a list keyed "panelMatrix2" never has,
  // so the page always fell back to the now empty Panel Matrix 1.
  writeOutputs({ channelOutputs: [asSaved(colorlight()), asSaved({ ...colorlight([32, 16, 8], 2, 2, 2), startChannel: 6145 })] });
  await openPanels(page);
  await removeMatrix(page, 1);
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([2]);
  await expect(page.locator('#panelMatrix2')).toBeVisible();
  await expect(page.locator('#panelMatrix2 .LEDPanelOutputNumber_0_0')).toBeVisible();
  await expect(page.locator('#panelMatrix1')).toBeHidden();
});

test('with no channeloutputs.json at all, a matrix can be added and is saved', async ({ page, request }) => {
  // Regression: d3e68b775.  With no channel output config the page had no
  // matrix lookup to add the first matrix to.
  inPlayer('rm', '-f', OUTPUTS);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await addMatrix(page, 'ColorLight5a75');
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([1]);
  await expect(page.locator('#panelMatrix1 .LEDPanelOutputNumber_0_0')).toBeAttached();
  await expect.poll(() => modelSize(request), { timeout: 15_000 }).toBe('64x32');
});

test('a page with no matrix on show throws no script errors while one is removed and one added', async ({ page, request }) => {
  // Regression: 75620b034.  GetCurrentActiveMatrixPanelID() returned the
  // text of the active tab's first element, and a tab with no matrix holds
  // the "No Panels Defined ..." note, so it returned that sentence; callers
  // built selectors from it and jQuery threw: in Save's done handler once
  // the last matrix was removed (skipping the rest of it), and in the Add
  // dialog's Connection Type onChange.
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  await removeMatrix(page, 1);
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([]);
  await addMatrix(page, 'ColorLight5a75');
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([1]);
  expect(pageErrors).toEqual([]);
});

// The advanced layout's fabric canvas for a matrix: its size, and each
// panel group's place in panel pixels.
const canvasState = (page: Page, id = 1) => page.evaluate((id) => (0, eval)(`(() => {
  const c = AdvancedUIcanvas${id};
  const groups = Object.values(c.panelGroups || {}).map((pg) => [pg.panelNumber, Math.round(pg.group.left / c.uiScale), Math.round(pg.group.top / c.uiScale)]);
  return { width: c.ledPanelCanvas ? c.ledPanelCanvas.getWidth() : 0, height: c.ledPanelCanvas ? c.ledPanelCanvas.getHeight() : 0, scale: c.uiScale, groups };
})()`), id);

// Drags a panel on the canvas the way fabric reports a drag: the group moves
// and 'object:moving' fires.
const movePanel = (page: Page, panelNumber: number, x: number, y: number, id = 1) => page.evaluate(([id, n, x, y]) => (0, eval)(`(() => {
  const c = AdvancedUIcanvas${id};
  const g = c.panelGroups['panel-${n}'].group;
  g.set({ left: ${x} * c.uiScale, top: ${y} * c.uiScale });
  c.ledPanelCanvas.fire('object:moving', { target: g });
})()`), [id, panelNumber, x, y]);

test('Advanced Layout draws the panels on a canvas, a panel dragged there is saved where it was put, and fppd drives the new shape', async ({ page, request }) => {
  // Regression: 6cf9d6776, 6692080eb, e475668d6.  The advanced (free form)
  // layout was rebuilt for multiple matrices in steps: a canvas per matrix
  // (6cf9d6776), switched back on (6692080eb), and the matrix re-opening in
  // advanced mode with its layout (e475668d6).
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  await page.locator('#panelMatrix1 .LEDPanelUIAdvancedLayout').check();
  await expect(page.locator('#panelMatrix1 canvas#ledPanelCanvas1')).toBeVisible();
  await expect(page.locator('#panelMatrix1 .matrixSize')).toHaveText('64x32');
  let st = await canvasState(page);
  expect(st.groups.map((g) => `${g[1]},${g[2]}`).sort()).toEqual(['0,0', '0,16', '32,0', '32,16']);
  // the panel at 32,0 moved right by a panel: a 96x32 matrix with a gap
  const n = st.groups.find((g) => g[1] === 32 && g[2] === 0)![0];
  await movePanel(page, n, 64, 0);
  await expect(page.locator('#panelMatrix1 .matrixSize')).toHaveText('96x32');
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.advanced, { timeout: 15_000 }).toBe(1);
  const m = await savedMatrix(request);
  expect(m.panels.map((pn: any) => `${pn.xOffset},${pn.yOffset}`).sort()).toEqual(['0,0', '0,16', '32,16', '64,0']);
  await expect.poll(() => modelSize(request), { timeout: 15_000 }).toBe('96x32');
  // read back: the page opens in advanced mode with the panel where it was put
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelUIAdvancedLayout')).toBeChecked();
  await expect(page.locator('#panelMatrix1 canvas#ledPanelCanvas1')).toBeVisible();
  st = await canvasState(page);
  expect(st.groups.map((g) => `${g[1]},${g[2]}`).sort()).toEqual(['0,0', '0,16', '32,16', '64,0']);
  expect(pageErrors).toEqual([]);
});

test('the advanced layout canvas follows its size settings, which are saved with the matrix', async ({ page, request }) => {
  // Regression: bb041e025, a673eeafa, 6c68c428b.  The canvas size inputs
  // were page-wide ids (a673eeafa made them per matrix), resizing used the
  // wrong matrix (6c68c428b), and the size was a global setting rather than
  // part of the matrix's config (bb041e025).
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  await page.locator('#panelMatrix1 .LEDPanelUIAdvancedLayout').check();
  const wide = page.locator('#panelMatrix1 .LEDPanelCanvasUIPixelsWide');
  const high = page.locator('#panelMatrix1 .LEDPanelCanvasUIPixelsHigh');
  await expect(wide).toBeVisible();
  let st = await canvasState(page);
  expect(st.width).toBe(Number(await wide.inputValue()) * st.scale);
  expect(st.height).toBe(Number(await high.inputValue()) * st.scale);
  await wide.fill('200');
  await wide.dispatchEvent('change');
  await high.fill('100');
  await high.dispatchEvent('change');
  st = await canvasState(page);
  expect([st.width, st.height]).toEqual([200 * st.scale, 100 * st.scale]);
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.LEDPanelCanvasUIPixelsWide, { timeout: 15_000 }).toBe(200);
  expect((await savedMatrix(request)).LEDPanelCanvasUIPixelsHigh).toBe(100);
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelCanvasUIPixelsWide')).toHaveValue('200');
  st = await canvasState(page);
  expect([st.width, st.height]).toEqual([200 * st.scale, 100 * st.scale]);
});

test('a column added while the advanced layout is off is on its canvas, and Save writes every panel', async ({ page, request }) => {
  // Regression: d3f6a309e.  Save took the panels from the canvas even when
  // the canvas no longer held the matrix's panels (the panel count had just
  // changed), dropping the new ones.
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  const advanced = page.locator('#panelMatrix1 .LEDPanelUIAdvancedLayout');
  await advanced.check();
  await expect(page.locator('#panelMatrix1 .matrixSize')).toHaveText('64x32');
  // the layout is picked in the simple view: out, a third column, back in
  await advanced.uncheck();
  await page.locator('#panelMatrix1 .LEDPanelsLayoutCols').selectOption('3');
  await advanced.check();
  await expect.poll(async () => (await canvasState(page)).groups.length).toBe(6);
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.panels?.length, { timeout: 15_000 }).toBe(6);
  await expect.poll(() => modelSize(request), { timeout: 15_000 }).toBe('96x32');
});

test('a string cape with an enabled ColorLight matrix still shows the LED Panel Matrices tab', async ({ page, request }) => {
  // Regression: f3158e3b9.  The page adds "panels" to what a strings-only
  // cape provides when an LED panel matrix is enabled (it may be a ColorLight
  // output), but looped over a misspelt $channelOutputsi, so the tab stayed
  // hidden.  The cape is the cape-info.json cape detection leaves.
  const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';
  const uiLevel = (await (await request.get('/api/settings/uiLevel')).json())?.value;
  test.skip(uiLevel && uiLevel !== '0', 'a UI level above Basic shows every tab');
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', 'sh',
    JSON.stringify({ id: 'FppTestsStrings', name: 'fpp-tests strings cape', provides: ['strings'] }), CAPE_INFO);
  try {
    writeOutputs({ channelOutputs: [{ ...asSaved(colorlight()), enabled: 0 }] });
    await page.goto('/channeloutputs.php');
    await expect(page.locator('#tab-LEDPanels-LI'), 'the control: a disabled matrix').toHaveClass(/hidden/);
    writeOutputs({ channelOutputs: [asSaved(colorlight())] });
    await page.goto('/channeloutputs.php');
    await expect(page.locator('#tab-LEDPanels-LI')).not.toHaveClass(/hidden/);
    await page.locator('#tab-LEDPanels-tab').click();
    await expect(page.locator('#panelMatrix1 .LEDPanelOutputNumber_0_0')).toBeVisible({ timeout: 15_000 });
  } finally {
    inPlayer('rm', '-f', CAPE_INFO);
  }
});

test('a newly added matrix has its four panels once on the advanced layout canvas, and is saved with four', async ({ page, request }) => {
  // Regression: e475668d6.  Auto Layout, which lays out every new matrix,
  // added its panels to the ones the matrix already had instead of starting
  // afresh, so the canvas and an advanced-layout Save had each panel twice.
  writeOutputs({ channelOutputs: [] });
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await addMatrix(page, 'ColorLight5a75');
  await expect.poll(() => savedIDs(request), { timeout: 15_000 }).toEqual([1]);
  await page.locator('#panelMatrix1 .LEDPanelUIAdvancedLayout').check();
  await expect(page.locator('#panelMatrix1 canvas#ledPanelCanvas1')).toBeVisible();
  expect((await canvasState(page)).groups).toHaveLength(4);
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.advanced, { timeout: 15_000 }).toBe(1);
  expect((await savedMatrix(request)).panels).toHaveLength(4);
  await expect.poll(() => modelSize(request), { timeout: 15_000 }).toBe('64x32');
});

test('typing a matrix name is handled once per edit', async ({ page }) => {
  // Regression: fb1469f1e.  Text fields fire both "input" and "change", and
  // change detection ran for both.  Its log line says how often it ran.
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  const logs: string[] = [];
  page.on('console', (m) => { if (m.text().startsWith('Changed: LEDPanelMatrixName')) logs.push(m.text()); });
  const name = page.locator('#panelMatrix1 .LEDPanelMatrixName');
  await name.fill('Front');
  await name.press('Tab');
  await expect(saveWarning(page)).toBeVisible();
  await page.waitForTimeout(300);
  expect(logs).toEqual(['Changed: LEDPanelMatrixName -> Front']);
});

test('a ColorLight matrix offers all 24 receiver outputs for its panels, whatever output count was saved', async ({ page, request }) => {
  // Regression: e475668d6.  The connection's output count (24 for a
  // ColorLight card) was set under the old LEDPanelOutputs name, which
  // nothing reads, so the panels' Output dropdowns offered the saved
  // ledPanelsOutputs: 2 for a config an earlier Save wrote with the column
  // count there (e2caa46ec).
  // Also 577a800c2: a ColorLight connection has 24 outputs (it had 16).
  writeOutputs({ channelOutputs: [{ ...asSaved(colorlight()), ledPanelsOutputs: 2 }] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelOutputNumber_0_0 option')).toHaveCount(24);
  await page.locator('#panelMatrix1 .LEDPanelOutputNumber_1_1').selectOption('5');
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.panels?.find((pn: any) => pn.row === 1 && pn.col === 1)?.outputNumber,
    { timeout: 15_000 }).toBe(5);
  expect((await savedMatrix(request)).ledPanelsOutputs).toBe(24);
});

test('the matrix pixel and channel counts follow the layout, and the saved channel count is the one fppd takes', async ({ page, request }) => {
  // Regression: c59a2527a.  The counts were worked out from panel size keys
  // the page no longer set (NaN), and the spans showing them were given a
  // value instead of their text.
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsPixelCount')).toHaveText('2048');
  await expect(page.locator('#panelMatrix1 .LEDPanelsChannelCount')).toHaveText('6144');
  await page.locator('#panelMatrix1 .LEDPanelsLayoutCols').selectOption('3');
  await expect(page.locator('#panelMatrix1 .LEDPanelsPixelCount')).toHaveText('3072');
  await expect(page.locator('#panelMatrix1 .LEDPanelsChannelCount')).toHaveText('9216');
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.channelCount, { timeout: 15_000 }).toBe(9216);
  await expect.poll(async () => (await panelModel(request))?.ChannelCount, { timeout: 15_000 }).toBe(9216);
});

test('in advanced layout a selected panel can be given any of the panel numbers its output has, and is saved with it', async ({ page, request }) => {
  // Regression: 30ea8ccc7.  The selected panel's Panel dropdown was filled
  // from a panels-per-output key the page never set, so it had no choices.
  writeOutputs({ channelOutputs: [asSaved(colorlight())] });
  await openPanels(page);
  await page.locator('#panelMatrix1 .LEDPanelUIAdvancedLayout').check();
  await expect(page.locator('#panelMatrix1 .cpPanelNumber option')).toHaveCount(24);
  const st = await canvasState(page);
  const n = st.groups.find((g) => g[1] === 0 && g[2] === 0)![0];
  await page.evaluate((n) => (0, eval)(`(() => { const c = AdvancedUIcanvas1; c.ledPanelCanvas.setActiveObject(c.panelGroups['panel-${n}'].group); c.ledPanelCanvas.fire('selection:created', { target: c.panelGroups['panel-${n}'].group }); })()`), n);
  await page.locator('#panelMatrix1 .cpPanelNumber').selectOption({ value: '9' });
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.panels?.find((pn: any) => pn.xOffset === 0 && pn.yOffset === 0)?.panelNumber,
    { timeout: 15_000 }).toBe(9);
});
