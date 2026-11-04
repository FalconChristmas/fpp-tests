import { test, expect } from './fixtures';

// The footer's Stop FPPD / Start FPPD button (btnDaemonControl): its label
// and value follow fppd's state in the status, and ControlFPPD() asks
// api/system/fppd/stop or /start by the value.  fppd keeps running for the
// suite, so the page is shown a status that follows what it asked for, and
// the stop and start themselves are answered here.

test('the footer button stops a running fppd and starts a stopped one', async ({ page }) => {
  // Regression: 2506bd0b5 ("fix fppd daemon stop/start issue").  The label
  // was set but the value ControlFPPD() reads was not, so the button always
  // asked to start fppd: Stop FPPD did nothing.
  let running = true;
  const asked: string[] = [];
  await page.routeWebSocket('**/fppdws', (ws) => ws.close());
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (!running) {
      Object.assign(json, { fppd: 'Not Running', status: 'stopped', status_name: 'stopped' });
    }
    return route.fulfill({ response, json });
  });
  await page.route(/\/api\/system\/fppd\/(stop|start)(\?|$)/, (route) => {
    const what = new URL(route.request().url()).pathname.split('/').pop()!;
    asked.push(what);
    running = what === 'start';
    return route.fulfill({ json: { status: 'OK' } });
  });
  await page.goto('/index.php');
  const button = page.locator('#btnDaemonControl');
  await expect(button).toHaveText('Stop FPPD', { timeout: 30_000 });
  await button.click();
  await expect.poll(() => asked, { message: 'what Stop FPPD asked for' }).toEqual(['stop']);
  await expect(button).toHaveText('Start FPPD', { timeout: 30_000 });
  await button.click();
  await expect.poll(() => asked, { message: 'what Start FPPD asked for' }).toEqual(['stop', 'start']);
  await expect(button).toHaveText('Stop FPPD', { timeout: 30_000 });
});
