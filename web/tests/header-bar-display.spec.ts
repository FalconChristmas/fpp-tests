import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { keepingSettings, setSettingInFile, dropSettings } from './privacy-helpers';

// What the header bar on every page shows of the player: its interfaces with
// their addresses, its temperature sensors in the unit the user picked, and
// its host description as a tooltip on the host name.
//
// Interfaces and sensors come from the status answer, which the test edits
// (this player has one Ethernet port and no sensors).  The status WebSocket
// is held open without sending anything, so the page keeps polling
// api/system/status for all of it rather than taking the sensors from fppd's
// own pushes.

type Iface = Record<string, unknown>;

const inet = (local: string, prefixlen: number) => ({ family: 'inet', local, prefixlen });

async function openWithStatus(page: Page, edit: { interfaces?: Iface[]; sensors?: unknown[] }) {
  await page.routeWebSocket('**/fppdws', () => {});
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (edit.interfaces) json.interfaces = edit.interfaces;
    if (edit.sensors) json.sensors = edit.sensors;
    return route.fulfill({ response, json });
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/index.php');
}

const ifaceSpan = (page: Page, ifname: string) => page.locator(`#header_IPs .ipTooltip[ifname="${ifname}"]`);

async function tooltipOf(page: Page, ifname: string) {
  await page.mouse.move(0, 600);
  await expect(page.locator('.tooltip')).toHaveCount(0);
  await ifaceSpan(page, ifname).hover();
  const tip = page.locator('.tooltip .tooltip-inner');
  await expect(tip).toHaveCount(1);
  return tip;
}

const UP = ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'];

test("an interface's tooltip gives its address with the prefix length", async ({ page }) => {
  // Regression: 94aecb231.  The header's interface tooltips gave the bare
  // address; the netmask was nowhere in the UI.  Wired, Wi-Fi and tether
  // interfaces each build their own tooltip.
  await openWithStatus(page, {
    interfaces: [
      { ifname: 'eth0', flags: UP, operstate: 'UP', addr_info: [inet('10.0.0.5', 24)] },
      { ifname: 'wlan0', flags: UP, operstate: 'UP', addr_info: [inet('10.1.0.5', 16)],
        wifi: { level: 70, unit: '%', desc: 'good' } },
      { ifname: 'SoftAp0', flags: UP, operstate: 'UP', addr_info: [inet('192.168.8.1', 24)] },
    ],
  });
  await expect(page.locator('#header_IPs .ipTooltip')).toHaveCount(3, { timeout: 15_000 });
  // The header itself keeps the bare address.
  await expect(ifaceSpan(page, 'eth0').locator('.divIPAddress')).toHaveText(': 10.0.0.5');
  await expect(await tooltipOf(page, 'eth0')).toHaveText('IP: 10.0.0.5/24');
  await expect(await tooltipOf(page, 'wlan0')).toContainText('IP: 10.1.0.5/16');
  await expect(await tooltipOf(page, 'SoftAp0')).toHaveText('Tether IP: 192.168.8.1/24');
});

test('an interface with no carrier is left out of the header', async ({ page }) => {
  // Regression: c3a9e9c25 (#2145).  An interface with an address but no
  // cable in (NO-CARRIER) was listed with that address as if it were up.
  await openWithStatus(page, {
    interfaces: [
      { ifname: 'eth0', flags: UP, operstate: 'UP', addr_info: [inet('10.0.0.5', 24)] },
      { ifname: 'eth1', flags: ['NO-CARRIER', 'BROADCAST', 'MULTICAST', 'UP'], operstate: 'DOWN',
        addr_info: [inet('10.0.2.5', 24)] },
    ],
  });
  // The control: the interface with a carrier is listed.
  await expect(ifaceSpan(page, 'eth0')).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(1000);
  await expect(ifaceSpan(page, 'eth1')).toHaveCount(0);
  await expect(page.locator('#header_IPs')).not.toContainText('10.0.2.5');
});

test("Docker's bridge and veth interfaces are left out of the header", async ({ page }) => {
  // Regression: c1e4b418e (#1993).  On a player running Docker, docker0,
  // its br-* bridges and every container's veth* were listed in the header
  // next to the real interfaces.
  await openWithStatus(page, {
    interfaces: [
      { ifname: 'eth0', flags: UP, operstate: 'UP', addr_info: [inet('10.0.0.5', 24)] },
      { ifname: 'docker0', flags: UP, operstate: 'UP', addr_info: [inet('172.17.0.1', 16)] },
      { ifname: 'br-0123456789ab', flags: UP, operstate: 'UP', addr_info: [inet('172.18.0.1', 16)] },
      { ifname: 'veth1a2b3c4', flags: UP, operstate: 'UP', addr_info: [] },
    ],
  });
  // The control: the real interface is listed.
  await expect(ifaceSpan(page, 'eth0')).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(1000);
  await expect(page.locator('#header_IPs .ipTooltip')).toHaveCount(1);
  await expect(page.locator('#header_IPs')).not.toContainText(/docker0|br-|veth/);
});

test('header temperatures follow the Fahrenheit setting', async ({ page }) => {
  // Regression: 944355af8.  The header read the setting through a typo
  // (`typeof setting`), so its temperatures were always in Celsius while
  // the status page's sensor table honoured temperatureInF.
  test.skip(!container, 'sets temperatureInF in the player');
  const sensors = [{ label: 'CPU: ', value: 45.2, formatted: '45.2', valueType: 'Temperature' }];
  await keepingSettings(async () => {
    setSettingInFile('temperatureInF', '1');
    await openWithStatus(page, { sensors });
    const span = page.locator('#header_sensors .sensorSpan');
    await expect(span).toHaveCount(1, { timeout: 15_000 });
    await expect(span).toHaveText('CPU: 113.36°F');

    // The control: in Celsius it reads as reported.
    setSettingInFile('temperatureInF', '0');
    await page.goto('/index.php');
    await expect(span).toHaveText('CPU: 45.2°C', { timeout: 15_000 });
  });
});

test.describe('the host name in the header', () => {
  test.skip(!container, 'edits the settings file in the player');

  test('shows the host description as its tooltip', async ({ page }) => {
    // Feature: f6574cb8b.  The description set in the settings was shown
    // nowhere in the header.
    await keepingSettings(async () => {
      setSettingInFile('HostDescription', 'fpp-tests garage player');
      await page.goto('/index.php');
      const host = page.locator('#header_host');
      await expect(host).toHaveAttribute('data-bs-toggle', 'tooltip');
      await host.hover();
      await expect(page.locator('.tooltip .tooltip-inner')).toHaveText('fpp-tests garage player');
    });
  });

  test('has no tooltip when there is no description', async ({ page }) => {
    // Regression: 7e5294634.  With no HostDescription (the default, unset)
    // or an empty one, the host name still got a tooltip, an empty one.
    await keepingSettings(async () => {
      for (const set of [() => dropSettings('HostDescription'), () => setSettingInFile('HostDescription', '')]) {
        set();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto('/index.php');
        const host = page.locator('#header_host');
        // The control: the header was drawn, with the host name.
        await expect(host.locator('a')).not.toHaveText('');
        await expect(host).not.toHaveAttribute('data-bs-toggle', 'tooltip');
        expect(await host.evaluate((el) => !!(window as any).bootstrap.Tooltip.getInstance(el))).toBe(false);
        await expect(page.locator('.header')).not.toContainText('Undefined array key');
        expect(errors).toEqual([]);
      }
    });
  });
});
