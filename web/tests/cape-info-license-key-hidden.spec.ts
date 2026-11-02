import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: 51410620c ("Hide License Keys in the UI by default").  The
// Cape Info page printed a signed cape's license key in the clear, so a
// screenshot posted for help gave the key away.  It is masked until the eye
// next to it is clicked, and the eye masks it again.

test.skip(!container, 'seeds files inside the run-web.sh container');

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';
const KEY = 'FPPTST-ABCDEF-123456-GHIJKL-789012';

let saved: string | null = null;
test.beforeEach(() => {
  const out = inPlayer('sh', '-c', `if [ -e ${CAPE_INFO} ]; then echo yes; cat ${CAPE_INFO}; else echo no; fi`);
  saved = out.startsWith('yes\n') ? out.slice(4) : null;
  const info = { id: 'FppTestsHat', name: 'fpp-tests string hat', version: '1.0', serialNumber: 'SN0001',
    provides: ['strings'], verifiedKeyId: 'fp', signed: { licensePorts: '24', licenseKey: KEY } };
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(info), CAPE_INFO);
});
test.afterEach(() => {
  if (saved === null) inPlayer('rm', '-f', CAPE_INFO);
  else inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', saved, CAPE_INFO);
});

test('a signed cape\'s license key is masked until its eye is clicked', async ({ page }) => {
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-signature-tab').click();
  const pane = page.locator('#eeprom-signature');
  // The control: the row is there.
  await expect(pane.getByText('License Key:')).toBeVisible();
  await expect(pane.getByText(KEY)).not.toBeVisible();
  await expect(pane.getByText('******-******-******-******-******')).toBeVisible();

  await page.locator('#keyVisibilityIcon').click();
  await expect(pane.getByText(KEY)).toBeVisible();
  await page.locator('#keyVisibilityIcon').click();
  await expect(pane.getByText(KEY)).not.toBeVisible();
});
