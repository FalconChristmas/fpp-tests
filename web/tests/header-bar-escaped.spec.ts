import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The header bar on every page shows the network interfaces and sensors from
// the status answer.  Sensor labels come from the cape's EEPROM and from
// config/sensors.json, interface names and their Wi-Fi fields from the
// system, so each must reach the page as text -- in the header itself and in
// the tooltips, which render their content as HTML.
//
// The status is answered by the test.  The status WebSocket is held open
// without sending anything, so the page keeps polling api/system/status for
// all of it rather than taking the sensors from fppd's own pushes.

const INJECTED = (n: string) => `<u class=fpptestsinj>${n}</u>`;
// Closes the attribute it lands in, if it isn't escaped.
const ATTR = (n: string) => `"><u class=fpptestsinj>${n}</u><i x="`;

const SENSORS = [
  { label: INJECTED('templabel'), value: 45.2, formatted: '45.2', valueType: 'Temperature' },
  { label: INJECTED('voltlabel'), value: 5.1, formatted: INJECTED('voltvalue'), valueType: 'Voltage' },
];

const INTERFACES = [
  {
    ifname: ATTR('wired'), flags: ['BROADCAST', 'UP'], operstate: 'UP',
    addr_info: [{ family: 'inet', local: '10.0.0.5', prefixlen: 24 }],
  },
  {
    ifname: ATTR('wifi'), flags: ['BROADCAST', 'UP'], operstate: 'UP',
    addr_info: [{ family: 'inet', local: '10.0.1.5', prefixlen: 24 }],
    wifi: { level: INJECTED('wifilevel'), unit: '%', desc: ATTR('wifidesc') },
  },
];

async function openWithStatus(page: Page) {
  await page.routeWebSocket('**/fppdws', () => {});
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.sensors = SENSORS;
    json.interfaces = INTERFACES;
    return route.fulfill({ response, json });
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/index.php');
}

test('sensor labels and readings in the header are text', async ({ page }) => {
  // Regression: 77cc90510.  RefreshHeaderBar concatenated each sensor's
  // label and formatted reading into the header spans and into their HTML
  // tooltip.
  await openWithStatus(page);
  const spans = page.locator('#header_sensors .sensorSpan');
  // The control: the header rendered the test's sensors.
  await expect(spans).toHaveCount(2, { timeout: 15_000 });
  await expect(spans.nth(0)).toContainText('<u class=fpptestsinj>templabel</u>');
  await expect(spans.nth(1)).toContainText('<u class=fpptestsinj>voltvalue</u>');
  await expect(page.locator('#header_sensors .fpptestsinj')).toHaveCount(0);

  await page.locator('#header_sensors .sensorSpan:not(.hiddenSensor)').hover();
  const tip = page.locator('.tooltip .tooltip-inner');
  await expect(tip).toContainText('<u class=fpptestsinj>voltlabel</u>');
  await expect(page.locator('.tooltip .fpptestsinj')).toHaveCount(0);
});

test('interface names and Wi-Fi fields in the header are text', async ({ page }) => {
  // Regression: 77cc90510.  RefreshHeaderBar concatenated each
  // interface's name into an attribute and the header text, and the Wi-Fi
  // strength and icon name into the tooltip and the icon's src.
  await openWithStatus(page);
  // The control: the test's interfaces reached the header, as markup or text.
  await expect.poll(() => page.locator('#header_IPs').innerHTML(), { timeout: 15_000 }).toContain('fpptestsinj');
  await expect(page.locator('#header_IPs')).toContainText('"><u class=fpptestsinj>wired</u><i x="');
  await expect(page.locator('#header_IPs')).toContainText('"><u class=fpptestsinj>wifi</u><i x="');
  await expect(page.locator('#header_IPs .fpptestsinj')).toHaveCount(0);
  const spans = page.locator('#header_IPs .ipTooltip');
  await expect(spans).toHaveCount(2);
  // Sorted by the name as rendered: "wifi" before "wired".
  await expect(page.locator('#header_IPs .divIPAddress')).toHaveText([': 10.0.1.5', ': 10.0.0.5']);
  expect(await page.locator('#header_IPs img').getAttribute('src')).toContain('wifidesc');

  await spans.filter({ hasText: 'wifi' }).hover();
  const tip = page.locator('.tooltip .tooltip-inner');
  await expect(tip).toContainText('<u class=fpptestsinj>wifilevel</u>');
  await expect(page.locator('.tooltip .fpptestsinj')).toHaveCount(0);
});
