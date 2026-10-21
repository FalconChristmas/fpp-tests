import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The LED Panels tab on a BeagleBone.  The page decides the platform from
// /etc/fpp/platform (config.php), so the test player claims to be one for the
// length of the test; fppd, already running, is not affected.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';

test('a panel that has to fold its rows never sits on interleave "Off"', async ({ page }) => {
  // Regression: 987d5b7d0.  The Panel Interleave dropdown shows only for a
  // panel scanning fewer than half its rows, which is exactly when "Off" is
  // invalid (fppd refuses the output and the panel stays dark), and a saved
  // or default "Off" stayed selected.  On Beagle "Off" is now disabled there
  // and a saved "Off" moves to 8 pixels.
  const saved = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  const savedOutputs = inPlayer('sh', '-c', `cat ${OUTPUTS} 2>/dev/null || true`);
  const matrix = {
    cfgVersion: 3, type: 'LEDPanelMatrix', subType: 'BBShiftPanel', enabled: 1, startChannel: 1,
    channelCount: 6144, ledPanelsWidth: 64, ledPanelsHeight: 32, ledPanelsScan: 8, panelWidth: 64,
    panelHeight: 32, panelScan: 8, ledPanelsSize: '64x32x8', colorOrder: 'RGB', gamma: '2.2',
    brightness: 10, ledPanelsLayout: '1x1', ledPanelsOutputs: 8, ledPanelsPanelsPerOutput: 16,
    panelColorDepth: 8, invertedData: 0, panelOutputOrder: false, panelOutputBlankRow: false,
    panelRowAddressType: 0, panelType: 0, panelInterleave: '0', panelDataLayout: 0,
    panels: [{ outputNumber: 0, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
  };
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > ${PLATFORM} &&
    cat > ${OUTPUTS} <<'EOF'
${JSON.stringify({ channelOutputs: [matrix] })}
EOF`);
  try {
    await page.goto('/channeloutputs.php#tab-LEDPanels');
    await page.locator('#tab-LEDPanels-tab').click();
    const interleave = page.locator('#panelMatrix1 .LEDPanelInterleave');
    await expect(interleave).toBeVisible();
    await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toHaveValue('64x32x8');
    await expect(interleave).toHaveValue('8');
    await expect(interleave.locator("option[value='0']")).toBeDisabled();
    // The size list offers each 1/8 size once.
    const sizes = await page.locator('#panelMatrix1 .LEDPanelsSize option').evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value));
    expect(sizes.filter((v) => v === '64x32x8')).toHaveLength(1);
    expect(sizes.filter((v) => v === '32x32x8')).toHaveLength(1);
  } finally {
    inPlayer('sh', '-c', saved ? `printf '%s' '${saved.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
    inPlayer('sh', '-c', savedOutputs ? `cat > ${OUTPUTS} <<'EOF'\n${savedOutputs}\nEOF` : `rm -f ${OUTPUTS}`);
  }
});
