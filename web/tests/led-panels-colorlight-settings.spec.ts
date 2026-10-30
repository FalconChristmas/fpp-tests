import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The ColorLight-only fields of the LED Panels tab: the interface list with
// each interface's speed, the receiver firmware version and the Ethernet link
// check.  fppd reloads its outputs whenever channeloutputs.json is written, so
// what it does with the saved matrix (its warnings for eth0) is the receiving
// end.

test.skip(!container, 'writes the channel output config and stand-ins inside the run-web.sh container');

const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
const ETHTOOL = '/usr/local/bin/ethtool';

function writeOutputs(value: unknown) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(value), OUTPUTS);
}

let savedOutputs: string | null = null;

test.beforeEach(() => {
  const out = inPlayer('sh', '-c', `if [ -e ${OUTPUTS} ]; then echo yes; cat ${OUTPUTS}; else echo no; fi`);
  savedOutputs = out.startsWith('yes\n') ? out.slice(4) : null;
});

test.afterEach(async () => {
  inPlayer('rm', '-f', ETHTOOL);
  if (savedOutputs === null) {
    writeOutputs({ channelOutputs: [] });
    inPlayer('rm', '-f', OUTPUTS);
  } else {
    inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  }
});

// One 32x16 ColorLight panel on eth0, as the page saves it, with the
// firmware left to auto-detect and the link check on.
function matrix(extra: Record<string, unknown> = {}) {
  return {
    cfgVersion: 3, type: 'LEDPanelMatrix', subType: 'ColorLight5a75', panelMatrixID: 1, enabled: 1,
    startChannel: 1, channelCount: 32 * 16 * 3, interface: 'eth0', ledPanelsWidth: 32, ledPanelsHeight: 16,
    ledPanelsScan: 8, panelWidth: 32, panelHeight: 16, panelScan: 8, ledPanelsSize: '32x16x8',
    ledPanelsLayout: '1x1', colorOrder: 'RGB', gamma: '2.2', brightness: 10, ledPanelsOutputs: 24,
    ledPanelsPanelsPerOutput: 24, firmwareVersion: 0, linkCheck: 1,
    panels: [{ outputNumber: 0, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
    ...extra,
  };
}

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
}

async function savedMatrix(request: APIRequestContext) {
  const c = await (await request.get('/api/configfile/channeloutputs.json')).json();
  return c.channelOutputs.find((o: any) => o.type === 'LEDPanelMatrix');
}

const panelSave = (page: Page) => page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');

async function noReceiverWarning(request: APIRequestContext) {
  const status = await (await request.get('/api/fppd/status')).json();
  return (status.warningInfo ?? []).some((w: any) => w.id == 9 && String(w.message).includes('eth0'));
}

test('an interface whose adapter lists no link modes shows its link speed', async ({ page }) => {
  // Regression: 5e186a788.  The speed came only from ethtool's "Supported
  // link modes" (the highest NNNbaseT), which some USB adapters leave as
  // "Not reported": the interface showed as "(0Mbps)".  The stand-in prints
  // what such an adapter prints; sudo finds it first on its secure_path.
  inPlayer('sh', '-c', `cat > ${ETHTOOL} <<'EOF'
#!/bin/sh
cat <<OUT
Settings for $1:
	Supported ports: [ ]
	Supported link modes:   Not reported
	Supported pause frame use: No
	Supports auto-negotiation: Yes
	Advertised link modes:  Not reported
	Speed: 1000Mb/s
	Duplex: Full
	Auto-negotiation: on
	Link detected: yes
OUT
EOF
chmod +x ${ETHTOOL}`);
  writeOutputs({ channelOutputs: [matrix()] });
  await openPanels(page);
  const eth0 = page.locator('#panelMatrix1 .LEDPanelsInterface option[value="eth0"]');
  await expect(eth0).toHaveText('eth0 (1000Mbps)');
});

test('the LED panel notes no longer call v13 receiver firmware incompatible', async ({ page }) => {
  // Regression: 48be459f8.  The notes under the panel layout still said, in
  // red, that 13.x receiver firmware was incompatible with FPP (issue 1849)
  // after d49ad41ed and 6b4377cdb had added v13 support.
  writeOutputs({ channelOutputs: [matrix()] });
  await openPanels(page);
  await expect(page.locator('#tab-LEDPanels')).toContainText('When wiring panels');
  await expect(page.locator('#tab-LEDPanels')).not.toContainText('incompatible with FPP');
  await expect(page.locator('#tab-LEDPanels a[href*="issues/1849"]')).toHaveCount(0);
});

test('the firmware version and link check are saved on the panel, and fppd acts on them', async ({ page, request }) => {
  // Regression: 5b9201737.  The receiver firmware version and the Ethernet
  // link check were global settings; they moved to the ColorLight panel's
  // own fields, which Save writes to the matrix as firmwareVersion and
  // linkCheck.  Without that the saved matrix had neither, fppd went on
  // asking eth0 for receivers, and a reload showed the fields at their
  // defaults.  The receiving end: on Auto Detect fppd finds no receiver card
  // on eth0 and says so (warning 9); forced to v13 it asks none, and the
  // reload the Save causes takes that warning down.
  // (Starting with the link check off: with it on, the failed output never
  // takes its warning down -- scenarios/test_colorlight_init.py's xfail.)
  writeOutputs({ channelOutputs: [matrix({ linkCheck: 0 })] });
  await expect.poll(() => noReceiverWarning(request), { timeout: 15_000 }).toBe(true);
  await openPanels(page);
  const fw = page.locator('#panelMatrix1 .LEDPanelsCLFirmwareVersion');
  const link = page.locator('#panelMatrix1 .LEDPanelsCLLinkCheck');
  await expect(fw).toBeVisible();
  await expect(fw).toHaveValue('0');
  await expect(link).not.toBeChecked();
  await fw.selectOption('13');
  await link.check();
  await panelSave(page).click();
  await expect.poll(async () => (await savedMatrix(request))?.firmwareVersion, { timeout: 15_000 }).toBe(13);
  expect((await savedMatrix(request)).linkCheck).toBe(1);
  await expect.poll(() => noReceiverWarning(request), { timeout: 15_000 }).toBe(false);

  await page.reload();
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
  await expect(fw).toHaveValue('13');
  await expect(link).toBeChecked();
});
