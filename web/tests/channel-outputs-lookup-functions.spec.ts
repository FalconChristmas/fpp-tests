import { test, expect } from './fixtures';

// The Channel Outputs page (channeloutputs.php) sets its lookup tables up when
// it loads, with two helpers that the LED Panels tab's script defines.

test('the page loads without a script error when the LED Panels script did not define its lookup helpers', async ({ page }) => {
  // Regression: a36d3ef07.  The page called checkAndCorrectMissingChannelLookup
  // and SetDefaultsInChannelOutputsLookup unconditionally; with the LED Panels
  // tab's script not run (it failed to load), the call threw a ReferenceError
  // and the rest of the page's setup never ran.
  // The helpers are renamed in the page the server sends, as a tab script
  // that did not run leaves them undefined.
  await page.route((u) => u.pathname === '/channeloutputs.php', async (route) => {
    const res = await route.fetch();
    const body = (await res.text())
      .replace('function checkAndCorrectMissingChannelLookup()', 'function fppTestsRenamed1()')
      .replace('function SetDefaultsInChannelOutputsLookup()', 'function fppTestsRenamed2()');
    await route.fulfill({ response: res, body });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/channeloutputs.php');
  await page.waitForLoadState('networkidle');
  // The control: the helpers are gone from the page, and its own setup ran.
  expect(await page.evaluate(() => [typeof (window as any).checkAndCorrectMissingChannelLookup, typeof (window as any).SetDefaultsInChannelOutputsLookup, typeof (window as any).channelOutputsLookup]))
    .toEqual(['undefined', 'undefined', 'object']);
  expect(errors).toEqual([]);
});
