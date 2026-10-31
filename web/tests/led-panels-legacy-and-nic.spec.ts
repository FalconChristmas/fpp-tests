import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Two behaviours of the LED Panel Matrices tab: a matrix saved before
// matrices were numbered gets a number, and the slow-NIC warning belongs to
// a matrix that is switched on.  Helpers as in led-panels-page-ui.spec.ts.

test.skip(!container, 'writes the channel output config inside the run-web.sh container');

const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
let savedOutputs: string | null = null;

function writeOutputs(value: unknown) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(value), OUTPUTS);
}

test.beforeEach(() => {
  const out = inPlayer('sh', '-c', `if [ -e ${OUTPUTS} ]; then echo yes; cat ${OUTPUTS}; else echo no; fi`);
  savedOutputs = out.startsWith('yes\n') ? out.slice(4) : null;
});
test.afterEach(() => {
  if (savedOutputs === null) inPlayer('rm', '-f', OUTPUTS);
  else inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  inPlayer('rm', '-f', '/usr/local/bin/ethtool');
});

function colorlight(extra: object = {}) {
  const [w, h, s, cols, rows] = [32, 16, 8, 2, 2];
  const panels = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      panels.push({ outputNumber: r, panelNumber: cols - c - 1, colorOrder: '', xOffset: c * w, yOffset: r * h,
                    orientation: 'N', row: r, col: c });
    }
  }
  return {
    cfgVersion: 3, type: 'LEDPanelMatrix', subType: 'ColorLight5a75', panelMatrixID: 1, enabled: 1, startChannel: 1,
    channelCount: cols * rows * w * h * 3, interface: 'eth0', ledPanelsWidth: w * cols, ledPanelsHeight: h * rows,
    panelWidth: w, panelHeight: h, panelScan: s, ledPanelsSize: `${w}x${h}x${s}`, ledPanelsLayout: `${cols}x${rows}`,
    colorOrder: 'RGB', gamma: '2.2', brightness: 10, ledPanelsOutputs: 24, ledPanelsPanelsPerOutput: 24, panels, ...extra,
  };
}

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('#panelMatrix1 .LEDPanelOutputNumber_0_0')).toBeAttached({ timeout: 15_000 });
}

test('a matrix saved with no number is given one, and saved with it', async ({ page, request }) => {
  // Regression: 37ee80188.  Configs from before matrices were numbered had
  // no panelMatrixID, and the page could not tell them apart or keep them.
  const legacy: any = colorlight();
  delete legacy.panelMatrixID;
  writeOutputs({ channelOutputs: [legacy] });
  await openPanels(page);
  await page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => {
    const c = await (await request.get('/api/configfile/channeloutputs.json')).json();
    return Number(c.channelOutputs.find((o: any) => o.type === 'LEDPanelMatrix')?.panelMatrixID);
  }, { timeout: 15_000 }).toBe(1);
});

test('the slow-NIC warning shows only for a matrix that is switched on', async ({ page }) => {
  // Regression: 04c212936.  A switched-off matrix on a 100 Mbps interface
  // was warned about as though it were driving it.
  inPlayer('sh', '-c', `printf '#!/bin/sh\\necho "Supported link modes:   10baseT/Full 100baseT/Full"\\necho "Speed: 100Mb/s"\\n' > /usr/local/bin/ethtool && chmod +x /usr/local/bin/ethtool`);
  writeOutputs({ channelOutputs: [colorlight({ enabled: 0 })] });
  await openPanels(page);
  await expect(page.locator('#panelMatrix1 .LEDPanelsInterface option:checked')).toHaveText(/\(100Mbps\)/);
  const warnings = page.locator('#panelMatrix1 .divLEDPanelWarnings');
  await expect(warnings).not.toContainText('does not support 1000+ Mbps');
  await page.locator('#panelMatrix1 .LEDPanelsEnabled').check();
  await page.locator('#panelMatrix1 .LEDPanelsEnabled').dispatchEvent('change');
  await expect(warnings).toContainText('does not support 1000+ Mbps', { timeout: 5000 });
});
