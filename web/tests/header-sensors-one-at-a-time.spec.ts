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

test('a wide header shows one sensor at a time and a click rotates to the next', async ({ page }) => {
  // Regression: 5ba9fafd4.  The rule hiding the inactive sensors only applied
  // below 1360px wide, so on a full-width window every sensor showed at once.
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
