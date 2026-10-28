import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The LED Panel Matrices tab of Channel Outputs, with a ColorLight matrix (the
// panel output any platform offers, the container's included).  The config is
// written straight to media/config/channeloutputs.json, as an older FPP left
// it.  fppd reloads its outputs whenever that file is written, so the matrix
// it builds from what the page saved -- the "LED Panels" model its ColorLight
// output creates -- is the receiving end.  (On eth0 it finds no receiver
// card and says so in a warning; it builds the matrix all the same.)

test.skip(!container, 'writes the channel output config inside the run-web.sh container');

const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';

function writeOutputs(value: unknown) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(value), OUTPUTS);
}

let savedOutputs: string | null = null;

test.beforeEach(() => {
  const out = inPlayer('sh', '-c', `if [ -e ${OUTPUTS} ]; then echo yes; cat ${OUTPUTS}; else echo no; fi`);
  savedOutputs = out.startsWith('yes\n') ? out.slice(4) : null;
});

test.afterEach(async ({ request }) => {
  if (savedOutputs === null) {
    // An empty config first, which fppd reloads to no panel outputs (it
    // ignores the file going away).
    writeOutputs({ channelOutputs: [] });
    await expect.poll(async () => (await panelModel(request)) ?? null, { timeout: 10_000 }).toBeNull();
    inPlayer('rm', '-f', OUTPUTS);
  } else {
    inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  }
  // Leave no test pattern running for the next test.
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

// A 4x2 grid of 32x16 panels as FPP 8.5 saved it: the grid only in panels[]
// (each panel's row and col), no ledPanelsLayout and no cfgVersion.
function preV3Matrix() {
  const panels = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 4; c++) {
      panels.push({ outputNumber: 0, panelNumber: r * 4 + c, colorOrder: '', xOffset: c * 32, yOffset: r * 16,
                    orientation: 'N', row: r, col: c });
    }
  }
  return {
    type: 'LEDPanelMatrix', subType: 'ColorLight5a75', enabled: 1, startChannel: 1, channelCount: 128 * 32 * 3,
    interface: 'eth0', ledPanelsWidth: 32, ledPanelsHeight: 16, ledPanelsScan: 8, colorOrder: 'RGB',
    gamma: '2.2', brightness: 10, ledPanelsOutputs: 24, ledPanelsPanelsPerOutput: 24, panels,
  };
}

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
}

// The same matrix as the page saves it today.
function v3Matrix() {
  const m: Record<string, unknown> = { ...preV3Matrix(), cfgVersion: 3, ledPanelsLayout: '4x2', panelMatrixID: 1 };
  return m;
}

async function savedMatrix(request: APIRequestContext) {
  const c = await (await request.get('/api/configfile/channeloutputs.json')).json();
  return c.channelOutputs.find((o: any) => o.type === 'LEDPanelMatrix');
}

// The model fppd's ColorLight output creates for the matrix it built.
async function panelModel(request: APIRequestContext) {
  return ((await (await request.get('/api/models')).json()) as any[]).find((m) => m.Name === 'LED Panels');
}

// fppd's test mode; null until a test has run.
const testmode = async (request: APIRequestContext) => (await (await request.get('/api/testmode')).json()) ?? {};
// Not in the hidden copy of the header that Zebra_Pin leaves in its place
// once the page scrolls and pins it (each Save in a header is matched so).
const panelSave = (page: Page) => page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');

test('a pre-v3 panel config with its grid only in panels[] opens and saves as its full grid', async ({ page, request }) => {
  // Regression: ca34dd612 (#2686).  A config from FPP 8.5 had no
  // ledPanelsLayout, so the page fell back to the 2x2 default: half of a 4x2
  // matrix was not shown, and Save wrote only the four panels left.
  writeOutputs({ channelOutputs: [preV3Matrix()] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsLayoutCols')).toHaveValue('4');
  await expect(page.locator('#panelMatrix1 .LEDPanelsLayoutRows')).toHaveValue('2');

  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.cfgVersion, { timeout: 15_000 }).toBe(3);
  const m = await savedMatrix(request);
  expect(m.ledPanelsLayout).toBe('4x2');
  const grid = m.panels.map((p: any) => `${p.row},${p.col}`).sort();
  expect(grid).toEqual(['0,0', '0,1', '0,2', '0,3', '1,0', '1,1', '1,2', '1,3']);
  // fppd, reloading the saved config, drives the whole 128x32 matrix.
  await expect.poll(async () => {
    const pm = await panelModel(request);
    return pm ? `${pm.ChannelCount / 3 / pm.StringCount}x${pm.StringCount}` : 'none';
  }, { timeout: 15_000 }).toBe('128x32');
});

test('Save clears the config-upgrade banner once it has upgraded the config', async ({ page, request }) => {
  // Regression: 2a1b6a51a.  The pre-v3 "Configuration Upgrade Required"
  // banner was only ever added: after Save wrote cfgVersion 3 it stayed up
  // until the page was reloaded.
  writeOutputs({ channelOutputs: [preV3Matrix()] });
  await openPanels(page);
  const banner = page.locator('.configUpgradeWarning');
  await expect(banner).toBeVisible();
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.cfgVersion, { timeout: 15_000 }).toBe(3);
  await expect(banner, 'the banner after Save upgraded the config').toHaveCount(0);
  // The receiving end: the page reads the saved config back as current.
  await page.reload();
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveCount(0);
});

test('the panel Testing dropdown shows a panel test already running, and Off stops it', async ({ page, request }) => {
  // Regression: be529cdc6 (#2709).  The dropdown always loaded as "Off",
  // whatever panel test fppd was running, and picking "Off" again fired no
  // change event, so the test could not be stopped from the page.
  writeOutputs({ channelOutputs: [v3Matrix()] });
  const r = await request.post('/api/command', {
    data: { command: 'Test Start', args: ['1000', 'Output Specific', 'ColorLight Panels', '5'] },
  });
  expect(r.ok(), await r.text()).toBe(true);
  await expect.poll(async () => (await testmode(request)).enabled, { timeout: 10_000 }).toBeTruthy();
  await openPanels(page);
  const sel = page.locator('#PanelTestPatternType');
  await expect(sel, 'the dropdown over a running Green Fade').toHaveValue('5');
  await sel.selectOption('0');
  await expect.poll(async () => (await testmode(request)).enabled, { timeout: 10_000 }).toBeFalsy();
});

test('Save resets the panel Testing dropdown along with the test it stops', async ({ page, request }) => {
  // Regression: 34b8d31a1.  Save stops any running test, but the dropdown
  // kept showing the pattern, and picking "Off" then did nothing.
  writeOutputs({ channelOutputs: [v3Matrix()] });
  await openPanels(page);
  const sel = page.locator('#PanelTestPatternType');
  await sel.selectOption('4');
  // fppd runs the pattern the page asked for.
  await expect.poll(async () => {
    const t = await testmode(request);
    return t.enabled ? `${t.mode} ${t.outputs} ${t.type}` : 'off';
  }, { timeout: 10_000 }).toBe('Outputs ColorLight Panels 4');
  await panelSave(page).click();
  await expect.poll(async () => (await testmode(request)).enabled, { timeout: 10_000 }).toBeFalsy();
  await expect(sel, 'the dropdown once Save had stopped the test').toHaveValue('0');
});

test('a panel turned with its orientation arrow is saved turned, and stays turned through a reload and Save', async ({ page, request }) => {
  // Coverage: acd4ce0b3 drew the orientation arrows with Font Awesome instead
  // of images and kept the orientation in the icon; the arrows were shown
  // from the back by default, so one click (N to R from the back) is saved
  // as "L", the panel's orientation seen from the front.
  writeOutputs({ channelOutputs: [v3Matrix()] });
  await openPanels(page);
  await page.locator('#panelMatrix1 .LEDPanelOrientation_0_0').click();
  await panelSave(page).click();
  const orientationAt = async (r: number, c: number) =>
    (await savedMatrix(request))?.panels?.find((p: any) => p.row === r && p.col === c)?.orientation;
  await expect.poll(() => orientationAt(0, 0), { timeout: 15_000 }).toBe('L');
  expect(await orientationAt(0, 1), 'the panel next to it').toBe('N');
  // A turned 32x16 panel takes 16 columns, so the next one starts at 16.
  expect((await savedMatrix(request)).panels.find((p: any) => p.row === 0 && p.col === 1).xOffset).toBe(16);

  // Read back by the page: a reload and a Save of what it shows keep it.
  await page.reload();
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
  await page.locator('#panelMatrix1 .LEDPanelOrientation_0_1').click();
  await panelSave(page).click();
  await expect.poll(() => orientationAt(0, 1), { timeout: 15_000 }).toBe('L');
  expect(await orientationAt(0, 0), 'the panel turned before the reload').toBe('L');
});
