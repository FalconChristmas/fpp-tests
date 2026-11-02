import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The header bar shows one sensor at a time.  The sensors reach the page in
// fppd's /fppdws snapshots; this player has none, so the test adds three to
// the snapshots on their way to the page.

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
        msg.data.status.sensors = [sensor('CPU: ', 45.2, 'Temperature'), sensor('Supply: ', 5.1, 'Voltage', 'V'),
                                   sensor('Core: ', 1.2, 'Voltage', 'V')];
      }
      ws.send(JSON.stringify(msg));
    });
  });
}

test('with three sensors and the first one chosen, only the first shows when the header is drawn', async ({ page, request }) => {
  // Regression: a1caf0ec3.  The sensor spans were drawn with the class
  // attribute written twice (class="sensorSpan" ... class="hiddenSensor"),
  // of which the browser keeps the first, so none started hidden; the header
  // then hid only the sensor before the chosen one, and with the first one
  // chosen every sensor showed at once.
  const key = '/api/settings/currentHeaderSensor';
  const before = (await (await request.get(key)).json()).value;
  await request.put(key, { data: '0', headers: { 'Content-Type': 'text/plain' } });
  try {
    await addSensors(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/index.php');
    const spans = page.locator('#header_sensors .sensorSpan');
    await expect(spans).toHaveCount(3, { timeout: 15_000 });
    const visible = page.locator('#header_sensors .sensorSpan:visible');
    await expect(visible).toHaveCount(1);
    await expect(visible).toContainText('CPU');
  } finally {
    await request.put(key, { data: String(before ?? '0'), headers: { 'Content-Type': 'text/plain' } });
  }
});
