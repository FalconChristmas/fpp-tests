import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// System Stats lists the fans fppd reads (FanSpeed sensors) in their own
// card, and the temperature gauge reads the Temperature sensor, wherever it
// comes in the list. Added in fpp 1fa7d12ff ("Add fan monitoring to
// system-stats.php"): before it there was no fan card, and the gauge took
// whatever sensor came first -- with a fan listed ahead of the CPU, it
// showed the fan's RPM as degrees.
//
// The sensors are supplied by the test, in the page's status answer; fppd's
// side (the FanSpeed sensors themselves) is scenarios/test_fan_sensors.py.

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
  await page.waitForTimeout(500);
}

test('a fan listed ahead of the CPU temperature gets its own card and leaves the gauge alone', async ({ page }) => {
  await loadWithSensors(page, [
    { label: 'pwmfan: ', value: 2345, formatted: '2345', valueType: 'FanSpeed', postfix: ' RPM' },
    { label: 'CPU: ', value: 45.2, formatted: '45.2', valueType: 'Temperature' },
  ]);
  const fans = page.locator('#fan-data');
  await expect(fans).toBeVisible();
  await expect(fans).toContainText('pwmfan');
  await expect(fans).toContainText('2345 RPM');
  await expect(page.locator('#tempValue')).toHaveText(/^45\D/);
});

test('with no fan the fan card stays hidden', async ({ page }) => {
  await loadWithSensors(page, [{ label: 'CPU: ', value: 45.2, formatted: '45.2', valueType: 'Temperature' }]);
  await expect(page.locator('#fan-data')).toBeHidden();
});
