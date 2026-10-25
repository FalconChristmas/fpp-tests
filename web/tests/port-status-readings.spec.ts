import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// What the Port Status page (currentmonitor.php) shows for each port, from
// fppd's /api/fppd/ports.  A port reports only what its hardware has: "ma"
// with a current sensor, "status" with an eFuse, "enabled" with an enable
// pin.  The container has no output port pins, so the answer is fppd's, as it
// gives it for those ports, served by a route; fppd's half -- a port with no
// eFuse leaves "status" out -- is scenarios/test_port_status.py.
//
// Regression: 57b3072e5.  The page printed every field whatever the port
// reported: a cape whose ports have only an enable line showed "undefined ma"
// on each port, "NaN ma" totals, an eFuse check for a fuse there isn't (red,
// or green while fppd hard-coded "status": true), and a Count Pixels button
// that could only park the player in test mode with nothing to measure.

async function showPorts(page: Page, ports: object[]) {
  await page.route('**/api/fppd/ports', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ports) }));
  await page.goto('/currentmonitor.php');
  // Drawn from the first answer, a second after load.
  await expect(page.locator('#fppPorts')).toContainText((ports[0] as any).name, { timeout: 15_000 });
}

const port = (n: number, fields: object) => ({ name: `Port ${n}`, row: 1, col: n, ...fields });

test('ports with only an enable line show no current, no fuse status and no Count Pixels', async ({ page }) => {
  await showPorts(page, [port(1, { enabled: true }), port(2, { enabled: false })]);
  const grid = page.locator('#fppPorts');
  await expect(grid).toContainText('Enabled:');
  const text = await grid.innerText();
  expect(text, 'the port grid').not.toContain('undefined');
  expect(text, 'the port grid').not.toContain('NaN');
  expect(text, 'the port grid').not.toContain(' ma');
  expect(text, 'no fuse to report on').not.toContain('Status:');
  await expect(grid.locator('[title="eFuse Normal"], [title="eFuse Triggered"]')).toHaveCount(0);
  // Port 2 is off, and not because a fuse it hasn't got tripped.
  await expect(grid.locator('[title="Port Disabled"]')).toHaveCount(1);
  await expect(page.locator('#btnCountPixels'), 'Count Pixels with nothing to measure').toBeHidden();
  await expect(page.locator('#noCurrentMonitoringNote')).toBeVisible();
});

test('ports with a current sensor and no eFuse show their current and totals, and no fuse status', async ({ page }) => {
  // The shape fppd gives a port with a current sensor and no fuse (what the
  // scenario's simulated ports report).
  await showPorts(page, [port(1, { ma: 120 }), port(2, { ma: 30 })]);
  const grid = page.locator('#fppPorts');
  await expect(grid).toContainText('120 ma');
  await expect(grid).toContainText('Ports 1-2: 150 ma');
  expect(await grid.innerText()).not.toContain('Status:');
  await expect(page.locator('#btnCountPixels')).toBeVisible();
  await expect(page.locator('#noCurrentMonitoringNote')).toBeHidden();
});

test('a port with an eFuse still shows its status: tripped, normal, or just switched off', async ({ page }) => {
  // The control: ports that report a fuse are drawn as they always were.
  await showPorts(page, [
    port(1, { enabled: true, status: true, ma: 50 }),
    port(2, { enabled: false, status: false, ma: 0 }),
    port(3, { enabled: false, status: true, ma: 0 }),
  ]);
  const cell = (n: number) => page.locator(`#fppPorts tr:nth-child(1) td:nth-child(${n})`);
  await expect(cell(1).locator('[title="eFuse Normal"]')).toHaveCount(1);
  await expect(cell(2).locator('[title="eFuse Triggered"]')).toHaveCount(2);
  await expect(cell(3).locator('[title="Port Disabled"]')).toHaveCount(1);
  await expect(cell(3).locator('[title="eFuse Normal"]')).toHaveCount(1);
});
