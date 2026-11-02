import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Panel Size list of the LED Panels tab on a Pi (not a BeagleBone).

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
test.afterEach(() => {
  if (savedOutputs === null) {
    writeOutputs({ channelOutputs: [] });
    inPlayer('rm', '-f', OUTPUTS);
  } else {
    inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  }
});

function matrix(subType: string) {
  return {
    cfgVersion: 3, type: 'LEDPanelMatrix', subType, panelMatrixID: 1, enabled: 1,
    startChannel: 1, channelCount: 32 * 16 * 3, interface: 'eth0', ledPanelsWidth: 32, ledPanelsHeight: 16,
    ledPanelsScan: 8, panelWidth: 32, panelHeight: 16, panelScan: 8, ledPanelsSize: '32x16x8',
    ledPanelsLayout: '1x1', colorOrder: 'RGB', gamma: '2.2', brightness: 10, ledPanelsOutputs: 24,
    ledPanelsPanelsPerOutput: 24, firmwareVersion: 0, linkCheck: 1,
    panels: [{ outputNumber: 0, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
  };
}

async function sizes(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
  return page.locator('#panelMatrix1 select.LEDPanelsSize option').evaluateAll(
    (os) => os.map((o: any) => [o.value, (o.textContent ?? '').trim()]));
}

for (const subType of ['ColorLight5a75', 'RGBMatrix']) {
  test(`a ${subType} panel's size list offers 32x16 1/2 scan`, async ({ page }) => {
    // Regression: 55a21930c.  The list stopped at 1/4 scan for 32x16 panels,
    // so a 1/2 scan panel (two scan rows, as many hub75 panels are) could
    // not be chosen on a Pi or ColorLight card.
    writeOutputs({ channelOutputs: [matrix(subType)] });
    const offered = await sizes(page);
    expect(offered).toContainEqual(['32x16x2', '32x16 1/2 Scan']);
    expect(offered, 'the control: the neighbouring sizes').toEqual(expect.arrayContaining([['32x16x8', '32x16 1/8 Scan'], ['32x16x4', '32x16 1/4 Scan']]));
  });
}
