import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Cape Info is a page of its own, listed in the Help menu while the cape's
// EEPROM image is present, and the System Upgrade page asks for donations
// except on a cape signed by the FPP project.  What the pages show comes from
// media/tmp/cape-info.json, which cape detection publishes from the EEPROM;
// the tests write it directly.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const EEPROM = `${MEDIA}/tmp/eeprom.bin`;
const VIRTUAL = `${MEDIA}/config/cape-eeprom.bin`;

function writeCape(extra: Record<string, unknown> = {}) {
  const info = { id: 'FppTestsCape', name: 'fpp-tests menu cape', version: '1.0', serialNumber: 'SN0001', ...extra };
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(info), CAPE_INFO);
}

test.afterEach(() => {
  inPlayer('rm', '-f', CAPE_INFO, EEPROM, VIRTUAL);
});

test('the Help menu lists Cape Info only when the cape has an EEPROM image, and it opens the cape page', async ({ page }) => {
  // Regression: b596fd7a8.  Cape Info moved off the About page to a page of
  // its own, reached from the Help menu when there is a cape to describe.
  const entry = page.locator('.navbar .dropdown-menu a[href="cape-info.php"]');
  inPlayer('rm', '-f', EEPROM);
  writeCape();
  await page.goto('/index.php');
  await expect(page.locator('.navbar .dropdown-menu a[href="about.php"]')).toHaveCount(1);
  await expect(entry, 'listed with no EEPROM image').toHaveCount(0);

  inPlayer('sh', '-c', `: > ${EEPROM}`);
  await page.goto('/index.php?eeprom=1');
  await expect(entry).toHaveCount(1);
  await page.locator('#navbarDropdownMenuLinkHelp').click();
  await entry.click();
  await expect(page).toHaveURL(/cape-info\.php$/);
  await expect(page.locator('body')).toContainText('fpp-tests menu cape');
});

test('the Help menu lists Cape Info for a virtual EEPROM in config when there is no detected image', async ({ page }) => {
  // Regression: 80097664d.  The menu looked at config/cape-eeprom.bin only
  // in an else of the BeagleBone branch, so a BeagleBone with no EEPROM image
  // never listed its virtual one.  The fallback now applies on any platform
  // whenever tmp/eeprom.bin is missing; this guards that fallback.
  const entry = page.locator('.navbar .dropdown-menu a[href="cape-info.php"]');
  inPlayer('rm', '-f', EEPROM, VIRTUAL);
  writeCape();
  await page.goto('/index.php');
  await expect(entry, 'the control: listed with no image anywhere').toHaveCount(0);

  inPlayer('sh', '-c', `: > ${VIRTUAL}`);
  await page.goto('/index.php?virtual=1');
  await expect(entry, 'listed for the virtual EEPROM').toHaveCount(1);
});

test('System Upgrade asks for donations unless the cape is signed by the project', async ({ page }) => {
  // Regression: b596fd7a8.  The donate block (moved here from the About page)
  // is left out for a cape whose EEPROM key is the FPP project's ("fp").
  writeCape({ verifiedKeyId: 'ft' });
  await page.goto('/about.php');
  await expect(page.locator('#donateBanner'), 'a cape signed by another key').toHaveCount(1);

  writeCape({ verifiedKeyId: 'fp' });
  await page.goto('/about.php?signed=1');
  await expect(page.locator('#donateBanner')).toHaveCount(0);
});
