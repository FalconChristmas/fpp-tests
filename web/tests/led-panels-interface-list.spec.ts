import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA } from './settings-file';

// The Interface choice of the LED Panels tab (co-ledPanels.php) lists the
// network interfaces with the speed ethtool reports for each.

test.skip(!container, 'reads the player\'s Apache error log');

const LOG = `${MEDIA}/logs/apache2-error.log`;
const logged = () => Number(inPlayer('sh', '-c', `grep -c 'Undefined variable .SUDO' ${LOG} 2>/dev/null || true`).trim() || 0);

// Regression: a21acf918.  PopulateEthernetInterfaces() used $SUDO without
// declaring it global, so building the list logged "Undefined variable $SUDO"
// to the PHP error log for each interface (and ran ethtool without the sudo
// prefix the rest of the page code uses).
test('the LED Panels interface list is built without a PHP warning', async ({ page }) => {
  const before = logged();
  const res = await page.goto('/channeloutputs.php');
  const body = await res!.text();
  expect(body).not.toMatch(/(Warning|Notice|Deprecated)<\/b>:|Undefined variable/);
  const options = page.locator('#divLEDPanelsTemplate select.LEDPanelsInterface option');
  await expect(options.first()).toBeAttached({ timeout: 15_000 });
  const texts = await options.allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  for (const t of texts) expect(t).toMatch(/^\S+ \(\d*Mbps\)$/);
  await page.waitForTimeout(500);
  expect(logged() - before, inPlayer('sh', '-c', `tail -3 ${LOG} 2>/dev/null || true`)).toBe(0);
});
