import { test, expect } from './fixtures';

// The network page's WiFi scan table built each row as markup, with the SSID
// inside it and inside an inline onclick, and inserted it with .html().  An
// SSID is whatever any access point in radio range broadcasts, and the site
// CSP allows inline script, so a crafted network name ran script on the
// player's origin when someone opened the scan.  The "showing a cached scan"
// note was inserted the same way.  Fixed in fpp b49bc6ea8 ("fix(security):
// render scanned WiFi network names as text").
//
// The test player has no WiFi, so the scan is answered by the test, and the
// scan table and SSID field it fills are added to the page for it.

const IFACE = 'wlan9';
const HOSTILE = '<img src=x onerror=window.__fppTestsSsid=1>';
const QUOTED = "Bob's \"Network\"";

test('scanned network names are shown and selected as text', async ({ page }) => {
  await page.route(`**/api/network/wifi/scan/${IFACE}**`, (route) => route.fulfill({
    json: {
      status: 'Cached',
      message: '<img src=x onerror=window.__fppTestsScanNotice=1>',
      networks: [
        { SSID: HOSTILE, signal: -40, encrypted: true, security: 'WPA2' },
        { SSID: QUOTED, signal: -60, encrypted: false },
      ],
    },
  }));
  await page.goto('/networkconfig.php');
  await page.waitForFunction(() => typeof (window as any).LoadSIDSForInterface === 'function');
  await page.evaluate((iface) => {
    document.body.insertAdjacentHTML('beforeend',
      `<input id="eth_ssid_${iface}"><table><tbody id="wifiNetworksList_${iface}"></tbody></table>`);
    (window as any).LoadSIDSForInterface(iface, iface);
  }, IFACE);

  const rows = page.locator(`#wifiNetworksList_${IFACE} tr.wifi-network-row`);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(HOSTILE);
  await expect(page.locator(`#wifiNetworksList_${IFACE}`)).toContainText('<img src=x onerror=window.__fppTestsScanNotice=1>');
  expect(await page.evaluate(() => [(window as any).__fppTestsSsid, (window as any).__fppTestsScanNotice]))
    .toEqual([undefined, undefined]);

  await rows.nth(1).click();
  await expect(page.locator(`#eth_ssid_${IFACE}`)).toHaveValue(QUOTED);
});
