import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

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
  // As fppd reports them: a fan at precision 0, a temperature with no unit.
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

// The tooltip lists every sensor, fans included, with the header span's unit
// suffix: the °C case was red before fpp 3183 added it.  The fan reading is
// fppd's "formatted" passed through as is; its whole-number RPM comes from
// Sensors.cpp (precision 0), which this stub can't exercise.
async function tooltipWith(page: Page, request: APIRequestContext, inF: '0' | '1') {
  const before = String((await (await request.get('/api/settings/temperatureInF')).json()).value ?? '0');
  try {
    await request.put('/api/settings/temperatureInF', { data: inF });
    await addFanAndTempSensors(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/index.php');
    // The header leaves fans out, so only the temperature gets a span.
    await expect(page.locator('#header_sensors .sensorSpan')).toHaveCount(1, { timeout: 15_000 });
    await page.locator('#header_sensors .sensorSpan:visible').hover();
    const tooltip = page.locator('.tooltip-inner');
    await expect(tooltip).toBeVisible();
    return (await tooltip.textContent()) ?? '';
  } finally {
    await request.put('/api/settings/temperatureInF', { data: before });
  }
}

test('the header sensor tooltip shows a Celsius temperature with °C, and the fans', async ({ page, request }) => {
  const text = await tooltipWith(page, request, '0');
  expect(text).toContain('52.4°C');
  expect(text).toContain('1200 RPM');
});

test('the header sensor tooltip shows a temperature in °F when the setting asks for it', async ({ page, request }) => {
  const text = await tooltipWith(page, request, '1');
  expect(text).toContain('126.32°F'); // 52.4 °C
  expect(text).toContain('1200 RPM');
});
