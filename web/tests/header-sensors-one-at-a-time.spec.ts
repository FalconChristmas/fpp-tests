import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The header bar's sensors take turns: one shows, a click on it rotates to the
// next.  The sensors reach the page in fppd's /fppdws snapshots; this player
// has none, so the test adds them to the snapshots on their way to the page.

async function addSensors(page: Page) {
  const sensor = (label: string, value: number, valueType: string, postfix = '') =>
    ({ label, value, formatted: value.toFixed(1) + postfix, valueType, postfix });
  await page.routeWebSocket('**/fppdws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== 'string') return ws.send(message);
      let msg;
      try {
        msg = JSON.parse(message);
      } catch {
        return ws.send(message);
      }
      if (msg?.type === 'snapshot' && msg.data?.status) {
        msg.data.status.sensors = [sensor('CPU: ', 45.2, 'Temperature'), sensor('Supply: ', 5.1, 'Voltage', 'V')];
      }
      ws.send(JSON.stringify(msg));
    });
  });
}

async function addFanAndTempSensors(page: Page) {
  // Stub matches the fixed backend output:
  // FanSpeed: precision=0, postfix=" RPM" → formatted="1200 RPM"
  // Temperature: no postfix/precision from backend; frontend adds °C in tooltip
  await page.routeWebSocket('**/fppdws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== 'string') return ws.send(message);
      let msg;
      try {
        msg = JSON.parse(message);
      } catch {
        return ws.send(message);
      }
      if (msg?.type === 'snapshot' && msg.data?.status) {
        msg.data.status.sensors = [
          { label: 'Fan1: ', value: 1200, formatted: '1200 RPM', valueType: 'FanSpeed', postfix: ' RPM' },
          { label: 'CPU: ', value: 52.4, formatted: '52.4', valueType: 'Temperature', postfix: '' },
        ];
      }
      ws.send(JSON.stringify(msg));
    });
  });
}

test('a wide header shows one sensor at a time and a click rotates to the next', async ({ page }) => {
  // Also guards a1aadee39: the header shows one sensor; the tooltip half isn't asserted.
  // Regression: 5ba9fafd4.  The rule hiding the inactive sensors only applied
  // below 1360px wide, so on a full-width window every sensor showed at once.
  // Also 7eac62466: the inactive sensors are hidden by a class, not inline
  // styles (red with RotateHeaderSensor back to hide()/show(), which the
  // !important rule overrides).
  await addSensors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/index.php');
  const spans = page.locator('#header_sensors .sensorSpan');
  await expect(spans).toHaveCount(2, { timeout: 15_000 });
  const visible = page.locator('#header_sensors .sensorSpan:visible');
  await expect(visible).toHaveCount(1);
  const first = (await visible.textContent()) ?? '';

  await visible.click();
  await expect(visible).toHaveCount(1);
  await expect(visible).not.toHaveText(first);
});

test('a click on the header sensor saves which one is showing', async ({ page, request }) => {
  // Feature: 61da0c420, so the next page starts on the same one.
  await addSensors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/index.php');
  await expect(page.locator('#header_sensors .sensorSpan')).toHaveCount(2, { timeout: 15_000 });
  try {
    const saved = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('settings/currentHeaderSensor'),
      { timeout: 10_000 });
    await page.locator('#header_sensors .sensorSpan:visible').click();
    await saved;
  } finally {
    await request.put('/api/settings/currentHeaderSensor', { data: '0' });
  }
});

test('header sensor tooltip shows fan RPM as whole number and temperature with °C', async ({ page, request }) => {
  await addFanAndTempSensors(page);
  await request.put('/api/settings/temperatureInF', { data: '0' });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/index.php');
  
  // Header only shows non-FanSpeed sensors (Temperature in this case)
  const spans = page.locator('#header_sensors .sensorSpan');
  await expect(spans).toHaveCount(1, { timeout: 15_000 });

  // Hover the visible sensor (Temperature) to show tooltip with ALL sensors including FanSpeed
  const tempSpan = page.locator('#header_sensors .sensorSpan:visible');
  await tempSpan.hover();
  const tooltip = page.locator('.tooltip-inner');
  await expect(tooltip).toBeVisible();
  
  // Tooltip should contain fan RPM as whole number (no .0)
  await expect(tooltip).toContainText('1200 RPM');
  // Tooltip should contain temperature with °C
  await expect(tooltip).toContainText('°C');
});

test('header sensor tooltip shows fan RPM as whole number and temperature with °F', async ({ page, request }) => {
  await addFanAndTempSensors(page);
  await request.put('/api/settings/temperatureInF', { data: '1' });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/index.php');
  
  const spans = page.locator('#header_sensors .sensorSpan');
  await expect(spans).toHaveCount(1, { timeout: 15_000 });

  const tempSpan = page.locator('#header_sensors .sensorSpan:visible');
  await tempSpan.hover();
  const tooltip = page.locator('.tooltip-inner');
  await expect(tooltip).toBeVisible();
  
  // Tooltip should contain fan RPM as whole number
  await expect(tooltip).toContainText('1200 RPM');
  // Tooltip should contain temperature with °F (52.4°C = 126.32°F)
  await expect(tooltip).toContainText('126.32°F');
});
