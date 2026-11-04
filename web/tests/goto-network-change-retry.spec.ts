import { test, expect, retryGotoOnNetworkChange } from './fixtures';

// The fixture's retry of a page.goto that lost a script to a host network
// change. Playwright can't abort a request with ERR_NETWORK_CHANGED itself, so
// these stand in another error for it.

const STAND_IN = 'net::ERR_CONNECTION_RESET';

test('a page that lost a script to a network change is loaded again', async ({ page }) => {
  retryGotoOnNetworkChange(page, STAND_IN);
  let requests = 0;
  await page.route('**/js/fpp.js*', (route) => (++requests === 1 ? route.abort('connectionreset') : route.continue()));
  await page.goto('/outputprocessors.php');
  expect(requests, 'the second load asked for the script again').toBe(2);
  expect(await page.evaluate(() => typeof (window as any).SetupSelectableTableRow), 'fpp.js ran').toBe('function');
});

test('a script that fails any other way is not retried', async ({ page }) => {
  retryGotoOnNetworkChange(page, STAND_IN);
  let requests = 0;
  await page.route('**/js/fpp.js*', (route) => { requests++; return route.abort('failed'); });
  await page.goto('/outputprocessors.php');
  expect(requests).toBe(1);
  expect(await page.evaluate(() => typeof (window as any).SetupSelectableTableRow)).toBe('undefined');
});

test('it gives up after four loads and leaves the failure to the test', async ({ page }) => {
  retryGotoOnNetworkChange(page, STAND_IN);
  let requests = 0;
  await page.route('**/js/fpp.js*', (route) => { requests++; return route.abort('connectionreset'); });
  await page.goto('/outputprocessors.php');
  expect(requests).toBe(4);
});
