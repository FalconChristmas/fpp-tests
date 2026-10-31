import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// On a touch screen, fpp.js marks the body has-touch and fpp.css lays a
// page's tabs out as one scrolling row.  Channel Outputs hides the tabs for
// outputs the cape doesn't provide; here the cape (where cape detection
// unpacks it, media/tmp/cape-info.json) provides LED panels only, so the
// E1.31 tab is hidden.

test.skip(!container, 'seeds files inside the run-web.sh container');
test.use({ hasTouch: true });

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';
let saved: string | null = null;

test.beforeEach(() => {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', CAPE_INFO);
  saved = out.startsWith('yes\n') ? out.slice(4) : null;
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', 'sh', CAPE_INFO,
    JSON.stringify({ id: 'FppTestsHat', name: 'fpp-tests panel hat', version: '1.0', serialNumber: 'SN0001', provides: ['panels'] }));
});
test.afterEach(() => {
  if (saved === null) inPlayer('rm', '-f', CAPE_INFO);
  else inPlayer('sh', '-c', 'printf "%s" "$2" > "$1"', 'sh', CAPE_INFO, saved);
});

test('on a touch screen the tabs a page hides stay hidden', async ({ page }) => {
  // Regression: a07affd90 (#1524).  The touch layout's display:
  // inline-block for every tab outranked the hidden class, so on a phone or
  // tablet Channel Outputs showed the tabs the cape has no use for.
  await page.goto('/channeloutputs.php');
  await expect(page.locator('body')).toHaveClass(/has-touch/, { timeout: 15_000 });
  // The tab that is wanted is shown, in the touch layout.
  await expect(page.locator('#tab-LEDPanels-LI')).toBeVisible();
  await expect(page.locator('#tab-LEDPanels-LI')).toHaveCSS('display', 'inline-block');
  await expect(page.locator('#tab-e131-LI')).toHaveClass(/hidden/);
  await expect(page.locator('#tab-e131-LI')).toBeHidden();
});
