import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Port Status page (currentmonitor.php) draws a smart-receiver port --
// fppd's /api/fppd/ports entry with "smartReceivers" true and an object for
// each receiver A to F -- as one cell per receiver under the port's name,
// each with its own enable toggle, eFuse status, pixel count and current.
// The container has no receiver hardware, so fppd's answer is served by a
// route, as port-status-readings.spec.ts does.
//
// Feature: ba45c2a93 ("Start exposing the FalconV5 smart receiver pixel
// counting, current monitoring, and fuse toggling in the UI").  Without the
// smart-receiver branch the port was drawn like a plain one, from fields it
// does not have at the top level: a single cell of "undefined" and NaN, and
// no way to see or switch a receiver.

const receiver = (fields: object) => ({ enabled: true, status: true, ma: 0, ...fields });

const PORTS = [{
  name: 'Port 1', row: 1, col: 1, smartReceivers: true,
  A: receiver({ ma: 120, pixelCount: 50 }),
  B: receiver({ enabled: false, status: false, ma: 0 }),
  C: receiver({ enabled: false, status: true, ma: 0 }),
  D: receiver({ ma: 30 }),
  // E and F not present: a receiver that is not there has no cell.
}];

async function showPorts(page: Page, ports: object[]) {
  await page.route('**/api/fppd/ports', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ports) }));
  await page.goto('/currentmonitor.php');
  await expect(page.locator('#fppPorts')).toContainText('Port 1', { timeout: 15_000 });
}

// The cell for receiver n (1 = A) of the port in column 1.
const cell = (page: Page, n: number) => page.locator(`#fppPorts tr:nth-child(${n}) td:nth-child(1)`);

test('a smart-receiver port is drawn as a cell for each receiver, A to D, with its readings', async ({ page }) => {
  await showPorts(page, PORTS);
  await expect(cell(page, 1)).toContainText('Port 1');
  for (const [i, letter] of ['A', 'B', 'C', 'D'].entries()) {
    await expect(cell(page, i + 1).locator('b', { hasText: `${letter}:` }), `receiver ${letter}`).toHaveCount(1);
  }
  // A: enabled, healthy, with a pixel count and its current.
  await expect(cell(page, 1).locator('[title="Port Enabled"]')).toHaveCount(1);
  await expect(cell(page, 1).locator('[title="eFuse Normal"]')).toHaveCount(1);
  await expect(cell(page, 1)).toContainText('Pixels: 50');
  await expect(cell(page, 1)).toContainText('120 ma');
  // B: off with a tripped fuse. C: just switched off.
  await expect(cell(page, 2).locator('[title="eFuse Triggered"]')).toHaveCount(2);
  await expect(cell(page, 3).locator('[title="Port Disabled"]')).toHaveCount(1);
  await expect(cell(page, 3).locator('[title="eFuse Normal"]')).toHaveCount(1);
  // The receivers that are not there are not drawn, and nothing reads "undefined".
  await expect(page.locator('#fppPorts tr:nth-child(5) td:nth-child(1)')).toBeEmpty();
  expect(await page.locator('#fppPorts').innerText()).not.toMatch(/undefined|NaN/);
  // The totals add up the receivers' current, by bank of four ports.
  await expect(page.locator('#fppPorts')).toContainText('Smart Receiver 1-4A: 120 ma');
  await expect(page.locator('#fppPorts')).toContainText('Smart Receiver 1-4D: 30 ma');
});

test('a smart receiver\'s toggle sends Set Port Status for that receiver', async ({ page }) => {
  const sent: any[] = [];
  await page.route('**/api/command', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: 'OK' } });
  });
  await showPorts(page, PORTS);
  await cell(page, 1).locator('[title="Port Enabled"]').click();
  await cell(page, 3).locator('[title="Port Disabled"]').click();
  await expect.poll(() => sent.length).toBe(2);
  // The receiver is named by its port and letter.
  expect(sent[0]).toEqual({ command: 'Set Port Status', args: ['Port 1A', false] });
  expect(sent[1]).toEqual({ command: 'Set Port Status', args: ['Port 1C', true] });
});
