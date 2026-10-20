import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// BeagleBone boards expose no thermal zone, so api/system/status has no
// Temperature sensor, and System Stats' temperature gauge sat at "--" forever.
// Fixed in fpp debd132ef ("fix(www): hide the System Stats temperature gauge
// on boards without a sensor"): the gauge is hidden until a sensor reports.
//
// The sensors are supplied by the test, in the page's status answer.

async function loadWithSensors(page: Page, sensors: object[]) {
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.sensors = sensors;
    return route.fulfill({ response, json });
  });
  const answered = page.waitForResponse((r) => r.url().includes('/api/system/status'));
  await page.goto('/system-stats.php');
  await answered;
  // Let the page apply it.
  await page.waitForTimeout(500);
}

const gauge = (page: Page) => page.locator('.fpp-gauge', { has: page.locator('h5', { hasText: 'Temperature' }) });

test('the temperature gauge is hidden without a temperature sensor', async ({ page }) => {
  await loadWithSensors(page, []);
  await expect(gauge(page)).toHaveCount(1);
  await expect(gauge(page)).toBeHidden();
});

test('the temperature gauge shows with a temperature sensor', async ({ page }) => {
  await loadWithSensors(page, [{ label: 'CPU: ', value: 45.2, formatted: '45.2', valueType: 'Temperature' }]);
  await expect(gauge(page)).toBeVisible();
});
