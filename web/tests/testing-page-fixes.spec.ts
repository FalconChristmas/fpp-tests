import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Display Testing (testing.php): which tabs a mode shows, and the channel
// range the test starts with.

test.skip(!container, 'seeds the settings file and media directory inside the run-web.sh container');

const INFO = '/home/fpp/media/fpp-info.json';

let restoreSettings: () => void;
let hadInfo: string | null;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  const out = inPlayer('sh', '-c', `if [ -e ${INFO} ]; then echo yes; base64 ${INFO}; else echo no; fi`);
  hadInfo = out.startsWith('yes\n') ? out.slice(4) : null;
});
test.afterEach(async ({ request }) => {
  restoreSettings();
  if (hadInfo === null) inPlayer('rm', '-f', INFO);
  else inPlayer('sh', '-c', `echo "$1" | base64 -d > ${INFO}`, 'sh', hadInfo);
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

test('the Sequence tab is shown to a player and not to a remote', async ({ page }) => {
  // Regression: a320c9358.  Sequence testing plays a sequence of the
  // player's own, which a remote has none to choose from; the tab was there
  // in every mode.
  await page.goto('/testing.php?player');
  await expect(page.locator('#tab-channels-tab')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#tab-sequence-tab'), 'the control: a player has the tab').toBeVisible();
  await expect(page.locator('#tab-sequence')).toBeAttached();

  setSettingInFile('fppMode', 'remote');
  await page.goto('/testing.php?remote');
  await expect(page.locator('#tab-channels-tab')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#tab-dmx-tab'), 'the other tabs stay').toBeVisible();
  await expect(page.locator('#tab-sequence-tab')).toHaveCount(0);
});

test('the channel range the test starts with comes from the ranges fpp-info.json lists', async ({ page }) => {
  // Regression: 93aa28e92.  An FPP that is told which channel ranges it
  // outputs (channelRanges in fpp-info.json, zero-based "<first>-<last>"
  // pairs) starts the Start and End Channel boxes at the lowest and highest
  // of them, as channel numbers (one-based), not at 1 and the channel
  // maximum; ranges given backwards are put in order.
  inPlayer('sh', '-c', `printf '%s' "$1" > ${INFO} && chmod 644 ${INFO}`, 'sh',
    JSON.stringify({ channelRanges: '100-199,300-399' }));
  await page.goto('/testing.php?ranges');
  const start = page.locator('#testModeStartChannel');
  await expect(start).toHaveValue('101', { timeout: 15_000 });
  await expect(page.locator('#testModeEndChannel')).toHaveValue('400');

  inPlayer('sh', '-c', `printf '%s' "$1" > ${INFO} && chmod 644 ${INFO}`, 'sh',
    JSON.stringify({ channelRanges: '200-100' }));
  await page.goto('/testing.php?backwards');
  await expect(start).toHaveValue('101', { timeout: 15_000 });
  await expect(page.locator('#testModeEndChannel')).toHaveValue('201');

  // The control: with no ranges the box starts at 1.
  inPlayer('rm', '-f', INFO);
  await page.goto('/testing.php?none');
  await expect(start).toHaveValue('1', { timeout: 15_000 });
});
