import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Pixel Strings tab on a Beagle with no pixel cape: the page has no
// cape description to read ports, groups or pins from.

test.skip(!container, 'changes the platform inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const CONFIG = '/home/fpp/media/config/co-bbbStrings.json';

test('the Pixel Strings tab of a Beagle with no pixel cape draws without a script error', async ({ page }) => {
  // Regression: 70f9eb6ad.  Once the cape descriptions were no longer
  // files, KNOWN_CAPES was empty on a player with no cape, and the page
  // took the first cape's name, its outputs, groups and pins from it: script
  // errors that stopped the tab being drawn.
  const had = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null; true`);
  const hadConfig = inPlayer('sh', '-c', `test -e ${CONFIG} && echo yes || echo no`).trim() === 'yes';
  expect(hadConfig, 'no pixel string output was configured').toBe(false);
  inPlayer('sh', '-c', `printf '%s' 'BeagleBone Black' > ${PLATFORM}`);
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto('/channeloutputs.php');
    const tab = page.locator('#stringTab-tab');
    await expect(tab).toHaveText('Pixel Strings', { timeout: 15_000 });
    await tab.click();
    await expect(page.locator('#PixelString_enable')).toBeAttached();
    // Give the page time to draw its table from the (empty) cape list.
    await expect(page.locator('#PixelString')).toBeAttached();
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  } finally {
    if (had === '') inPlayer('rm', '-f', PLATFORM);
    else inPlayer('sh', '-c', `printf '%s' '${had}' > ${PLATFORM}`);
  }
});
