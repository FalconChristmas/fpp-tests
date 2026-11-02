import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The panel size list on a BeagleBone-family board offers the 1/32 and
// 1/64 scan sizes (64x64x32, 128x64) only when the panel cape has the
// fourth address select line (controls.sel4) to drive them.

test.skip(!container, 'changes the platform and php-fpm inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const PANELS = '/home/fpp/media/tmp/panels';
const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
const MODEL = '/tmp/fpp-tests-sel4-model';
const SO = '/tmp/fpp-tests-fakesys.so';

function restartPhpFpm(env: string) {
  inPlayer('sh', '-c',
    'm=$(cat /run/php/php8.4-fpm.pid 2>/dev/null); [ -n "$m" ] && kill -QUIT "$m"; ' +
    'for i in $(seq 50); do pgrep -x php-fpm8.4 > /dev/null || break; sleep 0.1; done; ' +
    `${env} php-fpm8.4 -R && ` +
    'for i in $(seq 50); do [ -S /run/php/php8.4-fpm.sock ] && break; sleep 0.1; done');
}

function cape(controls: object) {
  inPlayer('sh', '-c', `rm -rf ${PANELS} && mkdir -p ${PANELS}`);
  putFile(`${PANELS}/FppTestsPanels.json`, JSON.stringify({
    name: 'FppTestsPanels', longName: 'fpp-tests panel cape', driver: 'LEDscapeMatrix',
    defaults: { LEDPanelsConnection: 'LEDscapeMatrix' }, controls,
    outputs: Array.from({ length: 8 }, () => ({})) }));
}

let saved = { platform: '', outputs: '', panels: '' };
test.beforeAll(() => {
  inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', SO, '/tests/scenarios/fakesys.c', '-ldl');
  putFile(MODEL, 'TI AM335x BeagleBone Black\0');
  restartPhpFpm(`LD_PRELOAD=${SO} FAKESYS=/proc/device-tree/model=${MODEL}:/sys/firmware/devicetree/base/model=${MODEL}`);
});
test.afterAll(() => {
  restartPhpFpm('');
  inPlayer('rm', '-f', SO, MODEL);
});
test.beforeEach(() => {
  saved = {
    platform: inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`),
    outputs: inPlayer('sh', '-c', `cat ${OUTPUTS} 2>/dev/null || true`),
    panels: inPlayer('sh', '-c', `cd ${PANELS} 2>/dev/null && tar cf - . | base64 -w0 || true`),
  };
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > ${PLATFORM}`);
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({ channelOutputs: [{
    cfgVersion: 3, type: 'LEDPanelMatrix', subType: 'LEDscapeMatrix', panelMatrixID: 1, enabled: 1, startChannel: 1,
    channelCount: 1536, ledPanelsWidth: 32, ledPanelsHeight: 16, ledPanelsScan: 8, panelWidth: 32, panelHeight: 16,
    panelScan: 8, ledPanelsSize: '32x16x8', colorOrder: 'RGB', gamma: '2.2', brightness: 10, ledPanelsLayout: '1x1',
    ledPanelsOutputs: 8, ledPanelsPanelsPerOutput: 16, panelColorDepth: 8, invertedData: 0, panelOutputOrder: false,
    panelOutputBlankRow: false, panelRowAddressType: 0, panelType: 0, panelInterleave: '0', panelDataLayout: 0,
    panels: [{ outputNumber: 0, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
  }] }), OUTPUTS);
});
test.afterEach(() => {
  inPlayer('sh', '-c', saved.platform ? `printf '%s' '${saved.platform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  if (saved.outputs) inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', saved.outputs, OUTPUTS);
  else inPlayer('rm', '-f', OUTPUTS);
  inPlayer('sh', '-c', `rm -rf ${PANELS}`);
  if (saved.panels.trim()) inPlayer('sh', '-c', `mkdir -p ${PANELS} && echo "$1" | base64 -d | tar xf - -C ${PANELS}`, 'sh', saved.panels.trim());
});

async function sizes(page: Page): Promise<string[]> {
  await page.goto(`/channeloutputs.php?t=${Date.now()}#tab-LEDPanels`);
  await page.locator('#tab-LEDPanels-tab').click();
  const size = page.locator('#panelMatrix1 .LEDPanelsSize');
  await expect(size).toBeAttached({ timeout: 15_000 });
  return size.locator('option').evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value));
}

test('the 1/32 and 1/64 scan sizes follow the panel cape having a fourth select line, not the board', async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  // Regression: c6f537fd9.  The sizes needing the fourth address line were
  // offered only on a PocketBeagle, so a 64x64 1/32 panel could not be
  // picked on a Beagle whose cape has the line (and was offered on one
  // without it).
  cape({ sel4: {} });
  const withLine = await sizes(page);
  expect(withLine).toContain('64x64x32');
  expect(withLine).toContain('128x64x32');
  expect(withLine).toContain('80x40x20');

  cape({});
  const without = await sizes(page);
  expect(without, 'the control: a cape with no fourth line').toContain('64x64x16');
  expect(without).not.toContain('64x64x32');
  expect(without).not.toContain('128x64x32');
});
