import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer, playerAddress } from './container';
import { MEDIA, SETTINGS } from './settings-file';

// The setup wizard's Restore from Backup dialog restores a File Copy backup,
// not just a JSON one.
//
// Feature: 0c00837bf ("Add File Copy Restore option to Initial Setup restore
// dialog"). The dialog only took a JSON upload, which holds no sequences,
// media or plugins; a player rebuilt from a File Copy backup had to be taken
// through the wizard and then restored from the Backup page. The dialog now
// has a File Copy Restore type that runs the Backup page's copy
// (copystorage.php) from USB, the local backups folder or another player.
//
// Regression: 2ac0bb033 ("... revised 2"). Choosing the other player only
// listed its default folders: the Remote Storage select was never filled
// with that player's drives, so a backup on its USB drive could not be
// picked. A host change now asks the host for its drives.
//
// Also 90efa4726: the wizard and the Backup page share js/fpp-backup-filecopy.js
// for the File Copy lists; the folder list below is filled by that module.
//
// The receiving ends: the copy request is one copystorage.php and the copy
// script take (the script gets past its checks to the copy of the chosen
// area); the drive lookup is one the player's own /api/backups/devices?ip=
// proxy answers. The image has no rsync, so no file is actually copied.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const FOLDER = 'fpp-tests-setup-filecopy';
const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; /^pluginReinstallNeededAfterOS\\s*=/d; ` +
  `s/^rebootFlag\\s*=.*/rebootFlag = "0"/' ${SETTINGS}`;

test.beforeEach(() => {
  inPlayer('sh', '-c', `${CLEAR}; mkdir -p ${MEDIA}/backups/${FOLDER}/config`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `${CLEAR}; rm -rf ${MEDIA}/backups/${FOLDER}`);
});

async function openFileCopyRestore(page: Page) {
  await page.goto('/initialSetup.php');
  await page.click('#restoreSetupBtn');
  await expect(page.locator('#restoreDialog')).toBeVisible();
  await page.selectOption('#restoreType', 'filecopy');
  await expect(page.locator('#fileCopyRestoreBtn')).toBeVisible();
}

test('the setup wizard restores a File Copy backup from the local backups folder', async ({ page }) => {
  test.setTimeout(120_000);
  await openFileCopyRestore(page);
  await page.selectOption('#fileCopyDirection', 'FROMLOCAL');
  // The folder list is the player's own.
  await expect(page.locator(`#fcPathSelect option[value="${FOLDER}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#fcPathSelect', FOLDER);
  for (const box of await page.locator('.fcFlag').all()) {
    if (await box.getAttribute('value') !== 'Configuration') await box.uncheck();
  }
  await expect(page.locator('#fcFlagConfig')).toBeChecked();

  page.once('dialog', (d) => d.accept());
  const sent = page.waitForRequest((r) => r.url().includes('copystorage.php'));
  await page.click('#fileCopyRestoreBtn');
  const url = new URL((await sent).url());
  expect(url.searchParams.get('direction')).toBe('FROMLOCAL');
  expect(url.searchParams.get('path')).toBe(FOLDER);
  expect(url.searchParams.get('flags')).toBe('Configuration');

  // The copy's output streams into the dialog, which can be closed once done.
  await expect(page.locator('#fileCopyPopup_ModalCloseButton')).toBeEnabled({ timeout: 90_000 });
  const out = await page.locator('#fileCopyPopup_Modal textarea').inputValue();
  expect(out, 'the copy script refused the request').not.toMatch(/Invalid/);
  expect(out, 'the copy script did not copy the Configuration area').toContain('Copying Configuration');
});

test("choosing another player lists that player's drives", async ({ page, request }) => {
  const host = playerAddress().ip;
  await openFileCopyRestore(page);
  // A player MultiSync knows; this one, at its own address.
  await page.evaluate((ip) => {
    (window as any).$("#fcHost").append(`<option value="${ip}">fpp-tests-remote</option>`);
  }, host);

  // What the other player answers, for its drives and what is on them.
  const asked: string[] = [];
  await page.route((u) => u.searchParams.get('ip') === host && u.pathname.includes('/api/'), async (route) => {
    const u = new URL(route.request().url());
    asked.push(u.pathname.replace(/^.*\/api\//, ''));
    if (u.pathname.endsWith('/api/backups/devices')) {
      return route.fulfill({ json: [{ name: 'sdz1', vendor: 'fpp-tests', model: 'drive', size: 32 }] });
    }
    if (u.pathname.endsWith('/api/settings/Service_rsync')) {
      return route.fulfill({ json: { name: 'Service_rsync', value: '1' } });
    }
    return route.fulfill({ json: ['/', FOLDER] });
  });

  await page.selectOption('#fileCopyDirection', 'FROMREMOTE');
  await page.selectOption('#fcHost', host);
  await expect(page.locator('#fcRemoteStorage option[value="sdz1"]'), "the other player's drive is not offered")
    .toHaveCount(1, { timeout: 15_000 });
  expect(asked).toContain('backups/devices');

  // The request is one the real endpoint takes: this player's proxy asks the
  // host for its drives and answers with its list.
  const real = await request.get(`/api/backups/devices?ip=${host}`);
  expect(real.status()).toBe(200);
  expect(Array.isArray(await real.json())).toBe(true);
});
