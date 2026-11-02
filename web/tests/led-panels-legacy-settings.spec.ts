import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';

// A panel matrix saved without its own layout, by an FPP from before that was
// kept per matrix, is opened with the default layout.

test.skip(!container, 'writes the channel output config inside the run-web.sh container');

const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';

let savedOutputs: string | null = null;
let restoreSettings: () => void = () => {};

test.beforeEach(() => {
  const out = inPlayer('sh', '-c', `if [ -e ${OUTPUTS} ]; then echo yes; cat ${OUTPUTS}; else echo no; fi`);
  savedOutputs = out.startsWith('yes\n') ? out.slice(4) : null;
  restoreSettings = snapshotSettings();
});

test.afterEach(() => {
  restoreSettings();
  if (savedOutputs === null) inPlayer('rm', '-f', OUTPUTS);
  else inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
});

test('a matrix saved with no layout and no panels opens as the default 2x2 layout', async ({ page }) => {
  // Regression: f873067b8.  The page defaulted the matrix's other fields but
  // not ledPanelsLayout (it split "undefined"), so a matrix from before the
  // layout was kept per matrix opened as a 1x1 grid with no layout to save.
  // (The same commit's PHP, which carries the player-wide LEDPanelsLayout and
  // LEDPanelsSize settings over to such a matrix, shows in the page only as
  // the server-drawn selects, which the client then redraws from the saved
  // config, so no test can see it.)
  const m = {
    type: 'LEDPanelMatrix', subType: 'ColorLight5a75', panelMatrixID: 1, enabled: 1, startChannel: 1,
    interface: 'eth0', colorOrder: 'RGB', gamma: '2.2', brightness: 10,
  };
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({ channelOutputs: [m] }), OUTPUTS);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#panelMatrix1 .LEDPanelsLayoutCols')).toHaveValue('2');
  await expect(page.locator('#panelMatrix1 .LEDPanelsLayoutRows')).toHaveValue('2');
});
