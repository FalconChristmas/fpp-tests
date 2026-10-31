import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Which interfaces the header bar lists, and in what order, from the
// interfaces in the status answer, which the test edits (this player has
// one Ethernet port).  The status WebSocket is held open without sending
// anything, so the page keeps polling api/system/status.

type Iface = Record<string, unknown>;

async function openWithInterfaces(page: Page, interfaces: Iface[]) {
  await page.routeWebSocket('**/fppdws', () => {});
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.interfaces = interfaces;
    return route.fulfill({ response, json });
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/index.php');
}

const UP = ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'];
const inet = (local: string) => ({ family: 'inet', local, prefixlen: 24 });
const listed = (page: Page) => page.locator('#header_IPs .ipTooltip').evaluateAll((s) => s.map((e) => e.getAttribute('ifname')));

test('an interface that is up with no address is still listed', async ({ page }) => {
  // Regression: 7e73e5e0b (#1645).  Only addresses were listed, so an
  // interface run without one -- the port driving a ColorLight receiver
  // card, say -- was missing from the header although it was up.
  await openWithInterfaces(page, [
    { ifname: 'eth0', flags: UP, operstate: 'UP', addr_info: [inet('10.0.0.5')] },
    { ifname: 'eth1', flags: UP, operstate: 'UP', addr_info: [] },
  ]);
  await expect.poll(() => listed(page), { timeout: 15_000 }).toEqual(['eth0', 'eth1']);
  await expect(page.locator('#header_IPs .ipTooltip[ifname="eth1"] i.fa-network-wired')).toHaveClass(/text-success/);
});

test('interfaces are listed in name order whatever order they come in', async ({ page }) => {
  // Regression: 8ad07fcfa.  The header listed interfaces in the order the
  // status gave them, which can change from one boot to the next.
  await openWithInterfaces(page, [
    { ifname: 'wlan0', flags: UP, operstate: 'UP', addr_info: [inet('10.1.0.5')],
      wifi: { level: 70, unit: '%', desc: 'good' } },
    { ifname: 'eth1', flags: UP, operstate: 'UP', addr_info: [inet('10.2.0.5')] },
    { ifname: 'eth0', flags: UP, operstate: 'UP', addr_info: [inet('10.0.0.5')] },
  ]);
  await expect.poll(() => listed(page), { timeout: 15_000 }).toEqual(['eth0', 'eth1', 'wlan0']);
});
