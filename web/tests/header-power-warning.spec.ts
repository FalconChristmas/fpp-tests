import { test, expect } from './fixtures';

// Regression: 6fa534a38 ("Display a lightning bolt and warning if the
// Raspberry Pi voltage thing triggers").  fppd reports the Pi firmware's
// under-voltage flag as powerBad in its status; the header shows a bolt
// over the board's logo while it is set, and takes it away once it clears.
// (fppd's side reads the firmware mailbox, /dev/vcio, so only a Pi has it;
// here the status the page is handed carries the flag.)

test('the header shows a bolt while fppd reports bad power, and clears it after', async ({ page }) => {
  await page.goto('/index.php');
  const bolt = page.locator('#powerPlaceHolder .fa-bolt');
  // The control: this player's power is fine.
  await expect(page.locator('#powerPlaceHolder')).toHaveCount(1);
  await expect(bolt).toHaveCount(0);

  // Each status the page goes on to receive (pushed or polled) carries the
  // test's flag.
  await page.evaluate(() => {
    const w = window as any;
    const orig = w.parseStatus;
    w.fppTestsPowerBad = true;
    w.parseStatus = function (s: any) { return orig.call(this, { ...s, powerBad: w.fppTestsPowerBad }); };
  });
  await expect(bolt).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => { (window as any).fppTestsPowerBad = false; });
  await expect(bolt).toHaveCount(0, { timeout: 15_000 });
});
