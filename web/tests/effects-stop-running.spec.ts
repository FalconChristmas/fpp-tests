import { test, expect } from './fixtures';

// The Effects page's Running Effects list: each running effect has a Stop
// button, which sends fppd an Effect Stop for that effect.  The running list
// is the test's (an effect named here is running), and so is the answer to
// the command; what the page asks for is what is checked.

test("a running effect's Stop stops that effect", async ({ page }) => {
  // Regression: c4983917d ("fix for StopEffect() bug").  StopEffect() sent a
  // fixed effect name, "block_driveways", whatever effect was clicked.
  const NAME = 'fpp-tests-running-fx';
  let effects = [{ id: 3, name: NAME }];
  const stops: unknown[] = [];
  await page.route('**/api/fppd/effects', (route) => route.fulfill({ json: { status: 'OK', runningEffects: effects } }));
  await page.route('**/api/command', (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.command !== 'Effect Stop') return route.continue();
    stops.push(body.args);
    effects = [];
    return route.fulfill({ json: { status: 'OK' } });
  });
  await page.goto('/effects.php');
  const row = page.locator('#tblRunningEffectsBody tr', { hasText: NAME });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#divRunningEffects')).toHaveClass(/divRunningEffectsRunning/);
  await row.locator('button', { hasText: 'Stop' }).click();
  await expect.poll(() => stops, { message: 'the Effect Stop the page sent' }).toEqual([[NAME]]);
  await expect(page.locator('#divRunningEffects')).toHaveClass(/divRunningEffectsDisabled/, { timeout: 15_000 });
});
