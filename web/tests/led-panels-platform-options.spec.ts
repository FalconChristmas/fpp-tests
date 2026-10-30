import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Platform-only fields of the LED Panels tab.  The page decides the platform
// from /etc/fpp/platform (config.php), so each test makes the player claim to
// be a Raspberry Pi or a BeagleBone for its length; fppd, already running, is
// not affected (and has no RGBMatrix or PRU panel output in the container).

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';

let savedPlatform = '';
let savedOutputs = '';

test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  savedOutputs = inPlayer('sh', '-c', `cat ${OUTPUTS} 2>/dev/null || true`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  inPlayer('sh', '-c', savedOutputs ? `cat > ${OUTPUTS} <<'EOF'\n${savedOutputs}\nEOF` : `rm -f ${OUTPUTS}`);
});

function claim(platform: string, matrix: Record<string, unknown>) {
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' '${platform}' > ${PLATFORM} &&
    cat > ${OUTPUTS} <<'EOF'
${JSON.stringify({ channelOutputs: [matrix] })}
EOF`);
}

function matrix(subType: string, w: number, h: number, scan: number, extra: Record<string, unknown> = {}) {
  return {
    cfgVersion: 3, type: 'LEDPanelMatrix', subType, panelMatrixID: 1, enabled: 1, startChannel: 1,
    channelCount: w * h * 3, ledPanelsWidth: w, ledPanelsHeight: h, ledPanelsScan: scan, panelWidth: w,
    panelHeight: h, panelScan: scan, ledPanelsSize: `${w}x${h}x${scan}`, colorOrder: 'RGB', gamma: '2.2',
    brightness: 10, ledPanelsLayout: '1x1', ledPanelsOutputs: 8, ledPanelsPanelsPerOutput: 16,
    panelColorDepth: 8, invertedData: 0, panelOutputOrder: false, panelOutputBlankRow: false,
    panelRowAddressType: 0, panelType: 0, panelInterleave: '0', panelDataLayout: 0,
    panels: [{ outputNumber: 0, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
    ...extra,
  };
}

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php#tab-LEDPanels');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
}

async function savedMatrix(request: APIRequestContext) {
  const c = await (await request.get('/api/configfile/channeloutputs.json')).json();
  return c.channelOutputs.find((o: any) => o.type === 'LEDPanelMatrix');
}

const panelSave = (page: Page) => page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');

test('a Raspberry Pi panel matrix saves its LED Panel Type and shows it again', async ({ page, request }) => {
  // Regression: 5e15b0380.  The Pi's rpi-rgb-led-matrix output had no way
  // to drive FM6126A/FM6127 panels, which need their chips initialised and
  // light only one panel otherwise: it added an "LED Panel Type" choice that
  // the page saves as panelType and RGBMatrix hands the library as its
  // panel_type.  (The fppd half needs a Pi with such panels; here the page
  // half: the choice is offered on a Pi, saved, and read back.)
  claim('Raspberry Pi', matrix('RGBMatrix', 32, 16, 8, { wiringPinout: 'regular' }));
  await openPanels(page);
  const type = page.locator('#panelMatrix1 .LEDPanelsType');
  await expect(type).toBeVisible();
  const offered = await type.locator('option').evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).textContent?.trim()));
  expect(offered).toEqual(['Standard', 'FM6126A', 'FM6127']);
  await type.selectOption('1');
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.panelType, { timeout: 15_000 }).toBe(1);

  await page.reload();
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
  await expect(type).toHaveValue('1');
});

test('a Beagle panel offers the 1, 2, 4 and 40 pixel interleaves, plain and Flip Rows', async ({ page }) => {
  // Regression: 177010120.  The Panel Interleave list on a Beagle stopped
  // at 4/8 pixels plain and 8 pixels Flip Rows: no 1, 2 or 40 pixel
  // interleave (nor 4 pixel Flip Rows) could be picked.  fppd builds a
  // handler for each value offered (scenarios/test_panel_interleave_types.py).
  claim('BeagleBone Black', matrix('BBShiftPanel', 64, 32, 8, { panelInterleave: '8' }));
  await openPanels(page);
  const interleave = page.locator('#panelMatrix1 .LEDPanelInterleave');
  await expect(interleave).toBeVisible();
  const values = await interleave.locator('option').evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value));
  for (const v of ['1', '2', '4', '40', '1f', '2f', '4f', '40f']) {
    expect(values, `interleave ${v}`).toContain(v);
  }
});
