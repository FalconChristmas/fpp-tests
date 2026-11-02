import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The virtual EEPROM controls of the Pixel Strings tab on a Beagle: the
// installed one preselected in the list, Install with nothing chosen, and
// Remove Existing.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const EEPROM = `${MEDIA}/config/cape-eeprom.bin`;
const FILES = [PLATFORM, EEPROM, `${MEDIA}/config/co-bbbStrings.json`, `${MEDIA}/config/co-pixelStrings.json`,
  `${MEDIA}/tmp/cape-info.json`];

function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; base64 "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

function putBack(path: string, b64: string | null) {
  if (b64 === null) {
    inPlayer('rm', '-f', path);
  } else {
    inPlayer('sh', '-c', 'echo "$2" | base64 -d > "$1" && chmod 644 "$1"', 'sh', path, b64);
  }
}

let saved: Record<string, string | null> = {};

test.beforeEach(() => {
  saved = {};
  for (const p of FILES) saved[p] = readFile(p);
  inPlayer('sh', '-c', `printf '%s' 'BeagleBone Black' > ${PLATFORM}`);
  // an installed virtual EEPROM (the F4-B cape's) with a string config saved on it
  inPlayer('sh', '-c', `cp /opt/fpp/capes/bbb/F4-B-eeprom.bin ${EEPROM} && chmod 644 ${EEPROM}
    printf '%s' '{"channelOutputs":[]}' > ${MEDIA}/config/co-bbbStrings.json
    printf '%s' '{"channelOutputs":[]}' > ${MEDIA}/config/co-pixelStrings.json
    printf '%s' '{"name":"F4-B","id":"F4-B"}' > ${MEDIA}/tmp/cape-info.json`);
});

test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) putBack(p, content);
});

async function openVirtualEeprom(page: Page) {
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await page.locator('input[value="Change Virtual EEPROM"]').click();
  await expect(page.locator('#virtualEEPROM')).toBeVisible();
}

test('the virtual EEPROM list preselects the one that is installed', async ({ page }) => {
  // Regression: 1d24c9391.  The list opened on the default for the
  // platform, so choosing Install without looking re-flashed another cape
  // over the one in use; it now opens on the installed one.
  await openVirtualEeprom(page);
  const chosen = await page.locator('#virtualEEPROM option:checked').textContent();
  expect(chosen).toBe('F4-B');
});

test('Install with no virtual EEPROM chosen asks for one and installs nothing', async ({ page }) => {
  // Regression: 1d24c9391 (the "-- Choose a Virtual EEPROM --" entry and
  // the check behind it).
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await openVirtualEeprom(page);
  await page.locator('#virtualEEPROM').selectOption('');
  await page.locator('input[value="Install"]').click();
  await expect.poll(() => dialogs.length, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(dialogs[0]).toBe('You must select a Virtual EEPROM from the list.');
  await expect(page.locator('#InstallVirtualEEPROMText')).toHaveCount(0);
});

test('Remove Existing deletes the virtual EEPROM, the string configs and the cape info', async ({ page }) => {
  // Feature: 73340a2af (a way for a user to remove a virtual EEPROM).  The
  // EEPROM image, both strings configs written on it and the cape info
  // cape detection published go; the page reloads.
  page.on('dialog', (d) => { void d.accept(); });
  await openVirtualEeprom(page);
  await page.locator('input[value="Remove Existing"]').click();
  await expect.poll(() => readFile(EEPROM), { timeout: 15_000 }).toBeNull();
  for (const gone of [`${MEDIA}/config/co-bbbStrings.json`, `${MEDIA}/config/co-pixelStrings.json`,
    `${MEDIA}/tmp/cape-info.json`]) {
    expect(readFile(gone), `${gone} was left`).toBeNull();
  }
});

test('with no cape or virtual EEPROM the tab offers to install one and hides the string configuration', async ({ page }) => {
  // Regression: 87fba6b3e.  With no cape EEPROM the tab still drew its
  // Save, Revert and Clone buttons and the string table, for a cape that
  // doesn't exist: saving that wrote a config nothing could use.
  inPlayer('rm', '-f', EEPROM, `${MEDIA}/tmp/cape-info.json`);
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('input[value="Install Virtual EEPROM"]')).toBeVisible();
  await expect(page.locator('#stringTab input[value="Save"]')).toHaveCount(0);
  await expect(page.locator('#stringTab input[value="Revert"]')).toHaveCount(0);
  await expect(page.locator('#divPixelStringData')).toBeHidden();
});

test('with a virtual EEPROM installed the tab shows its Save button and the string table', async ({ page }) => {
  // The control for the spec above: the same page with a cape present.
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('input[value="Change Virtual EEPROM"]')).toBeVisible();
  await expect(page.locator('#stringTab input[value="Save"]')).toHaveCount(1);
  await expect(page.locator('#divPixelStringData')).toBeVisible();
});
