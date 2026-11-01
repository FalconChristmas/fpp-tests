import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// What the Backup page's File Copy and JSON-backup-drive forms ask
// copystorage.php for.  copystorage.php is stubbed so no copy runs; the
// request the form builds is what is checked (the script behind it is
// covered by the file-copy-*.spec.ts files).

async function openFileCopy(page: Page) {
  // Saving a setting from the form is not what is under test.
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.pathname.includes('copystorage.php'),
    (route) => route.fulfill({ contentType: 'text/plain', body: 'stub\nDONE\n' }));
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
}

async function onlyConfiguration(page: Page) {
  await page.evaluate(() => {
    for (const box of document.querySelectorAll<HTMLInputElement>('#tab-fileCopy input[type=checkbox][id^="backup."]')) {
      box.checked = box.id === 'backup.Configuration';
    }
  });
}

async function startCopy(page: Page) {
  page.on('dialog', (d) => d.accept());
  const started = page.waitForRequest((r) => r.url().includes('copystorage.php'));
  await page.click('#tab-fileCopy input[type=button][value="Copy"]');
  const url = new URL((await started).url());
  // The copy dialog has to be closed before the form can be used again.
  await expect(page.locator('#copyPopup_ModalCloseButton')).toBeEnabled({ timeout: 15_000 });
  await page.click('#copyPopup_ModalCloseButton');
  await expect(page.locator('#copyPopup_Modal')).toBeHidden({ timeout: 10_000 });
  return url;
}

// Regression: 9cb34b100 (FPP File Copy Backup enhancements, #1283).  A backup
// with no path was refused ("No path specified"); it now backs up into the
// root of the drive, and says so in the Path field.  A backslash in a path
// (typed on Windows) is sent as a slash.
test('File Copy with no path goes to the root, and a backslash in the path becomes a slash', async ({ page }) => {
  await openFileCopy(page);
  await page.selectOption('#backup\\.Direction', 'TOLOCAL');
  await onlyConfiguration(page);

  await page.fill('#backup\\.Path', '');
  const empty = await startCopy(page);
  expect(empty.searchParams.get('path'), 'an empty path was not defaulted').toBe('/');
  await expect(page.locator('#backup\\.Path')).toHaveValue('/');

  await page.fill('#backup\\.Path', 'one\\two');
  const slashed = await startCopy(page);
  expect(slashed.searchParams.get('path')).toBe('one/two');
  await expect(page.locator('#backup\\.Path')).toHaveValue('one/two');
});

// Feature: a8af7e309 (the Backup page supports a remote host's storage
// device).  A copy to or from a remote host carries the remote drive picked
// in the Remote Storage list, which copystorage.php hands to the copy script
// to have the remote mount it.
test('a File Copy to a remote host sends the remote storage device picked', async ({ page }) => {
  await openFileCopy(page);
  await page.selectOption('#backup\\.Direction', 'TOREMOTE');
  // The page asks the (absent) remote for its drives, and resets the list
  // when that fails: let that finish before picking one.
  await page.waitForLoadState('networkidle');
  await onlyConfiguration(page);
  await page.evaluate(() => {
    const host = document.getElementById('backup.Host') as HTMLSelectElement;
    host.innerHTML = '<option value="192.0.2.77" selected>192.0.2.77</option>';
    const dev = document.getElementById('backup.RemoteStorage') as HTMLSelectElement;
    dev.innerHTML = '<option value="none">Default FPP Storage</option><option value="sdz5" selected>sdz5</option>';
  });
  await page.fill('#backup\\.Path', 'fpp-tests-remote');
  const url = await startCopy(page);
  expect(url.searchParams.get('direction')).toBe('TOREMOTE');
  expect(url.searchParams.get('storageLocation')).toBe('192.0.2.77');
  expect(url.searchParams.get('remoteStorage'), 'the remote drive was not sent').toBe('sdz5');
});

// Feature: 8251b4fa7.  Choosing a drive for the JSON settings backups offers
// to copy the backups already on the SD card to it; "Yes" asks for them to
// be copied into Automatic_Backups on the drive.
test('choosing a drive for the JSON backups offers to copy the existing ones to it', async ({ page }) => {
  await openFileCopy(page);
  await page.evaluate(() => {
    const sel = document.getElementById('jsonConfigbackup.USBDevice') as HTMLSelectElement;
    sel.innerHTML = '<option value="none">None</option><option value="sdz4">sdz4</option>';
    sel.value = 'sdz4';
    (window as any).JSONConfigBackupUSBDeviceChanged();
  });
  const dialog = page.locator('#dialog_copyToUsb_Modal');
  await expect(dialog, 'no offer to copy the existing backups').toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const asked = page.waitForRequest((r) => r.url().includes('copystorage.php'));
  await page.click('#dialog_copyToUsb_DoCopy');
  const url = new URL((await asked).url());
  expect(url.searchParams.get('direction')).toBe('TOUSB');
  expect(url.searchParams.get('storageLocation')).toBe('sdz4');
  expect(url.searchParams.get('path')).toBe('Automatic_Backups');
  expect(url.searchParams.get('flags')).toBe('JsonBackups');

  // "None" is not a drive to copy to.
  await page.evaluate(() => {
    (document.getElementById('jsonConfigbackup.USBDevice') as HTMLSelectElement).value = 'none';
    (window as any).JSONConfigBackupUSBDeviceChanged();
  });
  await expect(page.locator('#dialog_copyToUsb_Modal')).toBeHidden({ timeout: 10_000 });
});

// Regression: a52c504aa.  copystorage.php passes the remote storage device to
// the copy script as its own argument; a caller that does not send one (the
// older pages and scripts that call it) gets 'none' there.  The command
// shows what the script is handed.  (A path out of the folder, which the
// script refuses, keeps this from copying anything.)
test('copystorage.php hands the copy script "none" when no remote storage is named', async ({ request }) => {
  const out = await (await request.get('/copystorage.php?wrapped=1&direction=TOLOCAL&path=..%2Fconfig&flags=Configuration' +
    '&storageLocation=none', { timeout: 120_000 })).text();
  const command = (out.split('\n').find((l) => l.startsWith('Command:')) ?? out.slice(0, 500)).replace(/&#039;/g, "'");
  expect(command).toMatch(/'TOLOCAL' 'none' 'no' 'no' 'Configuration'/);
});
