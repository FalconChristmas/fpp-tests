import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Backup page's two storage choices: the extra drive JSON settings
// backups are copied to, and the drive on a remote host that a File Copy
// uses.  Both are settings the page saves as they are picked and reads back
// when it loads.  A save or read that fails has to be said, and the "busy"
// spinner taken off: a choice shown on the page that the player never took
// is a backup that goes somewhere else.
// The settings requests are answered by the test, so the player's own
// settings are not touched.

type Answer = { status: number; value?: string };

async function openBackup(page: Page, answers: { get?: Record<string, Answer>; put?: Record<string, Answer> }) {
  const puts: { name: string; body: string }[] = [];
  await page.route((u) => u.pathname.includes('/api/settings/'), (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.replace(/\/$/, '').split('/').pop()!);
    const method = route.request().method();
    if (method === 'GET') {
      const a = answers.get?.[name];
      if (!a) return route.fallback();
      return a.status === 200 ? route.fulfill({ json: { value: a.value } }) : route.fulfill({ status: a.status, body: 'no' });
    }
    puts.push({ name, body: route.request().postData() ?? '' });
    const a = answers.put?.[name];
    return a && a.status !== 200 ? route.fulfill({ status: a.status, body: 'no' }) : route.fulfill({ json: { status: 'OK' } });
  });
  await page.route((u) => u.pathname.includes('copystorage.php'), (route) => route.fulfill({ contentType: 'text/plain', body: 'stub\nDONE\n' }));
  await page.goto('/backup.php');
  return puts;
}

const jsonDrive = (page: Page) => page.locator('#jsonConfigbackup\\.USBDevice');
const jsonDriveBusy = (page: Page) =>
  jsonDrive(page).evaluate((el) => !!el.parentElement!.closest('div')!.classList.contains('fpp-backup-action-loading'));
const remoteDrive = (page: Page) => page.locator('#backup\\.RemoteStorage');
const remoteDriveBusy = (page: Page) =>
  remoteDrive(page).evaluate((el) => !!el.parentElement!.closest('td')!.classList.contains('fpp-backup-action-loading'));

async function pickJsonDrive(page: Page, drive: string) {
  await page.waitForLoadState('networkidle');
  await page.evaluate((d) => {
    const sel = document.getElementById('jsonConfigbackup.USBDevice') as HTMLSelectElement;
    sel.innerHTML = `<option value="none">None</option><option value="${d}">${d}</option>`;
    sel.value = d;
    (window as any).JSONConfigBackupUSBDeviceChanged();
  }, drive);
}

test('a JSON backup drive the player does not save is reported, with no offer to copy backups to it', async ({ page }) => {
  const puts = await openBackup(page, { put: { jsonConfigBackupUSBLocation: { status: 500 } } });
  await pickJsonDrive(page, 'sdz4');

  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Failed to set additional storage location.');
  await expect(dialog.locator('.modal-title')).toHaveText('JSON Configuration Backup Storage Location');
  expect(puts).toEqual([{ name: 'jsonConfigBackupUSBLocation', body: 'sdz4' }]);
  await expect.poll(() => jsonDriveBusy(page)).toBe(false);
  // The copy offer belongs to a drive that was saved.
  await expect(page.locator('#dialog_copyToUsb_Modal')).toHaveCount(0);
});

test('the control: a JSON backup drive that is saved offers the copy, and none says backups stop being copied', async ({ page }) => {
  const puts = await openBackup(page, {});
  await pickJsonDrive(page, 'sdz4');
  await expect(page.locator('#dialog_copyToUsb_Modal')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => jsonDriveBusy(page)).toBe(false);
  await page.waitForTimeout(500);
  await page.click('#dialog_copyToUsb_NoCopy');
  await expect(page.locator('#dialog_copyToUsb_Modal')).toBeHidden();

  await page.evaluate(() => {
    (document.getElementById('jsonConfigbackup.USBDevice') as HTMLSelectElement).value = 'none';
    (window as any).JSONConfigBackupUSBDeviceChanged();
  });
  await expect(page.locator('.jGrowl-notification', { hasText: 'will no longer be copied to an additional storage device' })).toBeVisible();
  expect(puts.map((p) => p.body)).toEqual(['sdz4', 'none']);
  await expect(page.locator('#dialogOKPopup')).toBeHidden();
});

test('a JSON backup drive setting that cannot be read is reported when the page loads', async ({ page }) => {
  await openBackup(page, { get: { jsonConfigBackupUSBLocation: { status: 500 } } });
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Failed to read additional storage location.', { timeout: 15_000 });
  await expect(dialog.locator('.modal-title')).toHaveText('JSON Configuration Backup Storage Location');
  await expect.poll(() => jsonDriveBusy(page)).toBe(false);
});

test('a remote storage drive the player does not save is reported, and its folders are not looked up', async ({ page }) => {
  const puts = await openBackup(page, { put: { 'backup.RemoteStorage': { status: 500 } } });
  await page.click('#backups-fileCopy-tab');
  await page.waitForLoadState('networkidle');
  let lookups = 0;
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.includes('/api/settings/') && /backups|remote/i.test(path)) lookups++;
  });
  await page.evaluate(() => {
    const sel = document.getElementById('backup.RemoteStorage') as HTMLSelectElement;
    sel.innerHTML = '<option value="none">Default FPP Storage</option><option value="sdz5" selected>sdz5</option>';
    (window as any).backupRemoteStorageChanged();
  });
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Failed to save Backup Storage');
  await expect(dialog.locator('.modal-title')).toHaveText('Remote Backup Storage');
  expect(puts).toEqual([{ name: 'backup.RemoteStorage', body: 'sdz5' }]);
  await expect.poll(() => remoteDriveBusy(page)).toBe(false);
  expect(await page.locator('.jGrowl-notification', { hasText: 'Remote Backup Storage saved' }).count()).toBe(0);
  await page.waitForTimeout(500);
  expect(lookups, 'no folder lookup for a drive that was not saved').toBe(0);
});

test.describe('once a remote host has listed its drives', () => {
  async function listed(page: Page, saved: Answer) {
    await openBackup(page, { get: { 'backup.RemoteStorage': saved } });
    await page.click('#backups-fileCopy-tab');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      const host = document.getElementById('backup.Host') as HTMLSelectElement | HTMLInputElement;
      if (host instanceof HTMLSelectElement) host.innerHTML = '<option value="192.0.2.77" selected>192.0.2.77</option>';
      host.value = '192.0.2.77';
      const sel = document.getElementById('backup.RemoteStorage') as HTMLSelectElement;
      sel.innerHTML = '<option value="none" selected>Default FPP Storage</option><option value="sdz5">sdz5</option>';
      (window as any).GetBackupRemoteStorageDevice();
    });
  }

  test('the drive saved for it is selected again', async ({ page }) => {
    await listed(page, { status: 200, value: 'sdz5' });
    await expect(remoteDrive(page)).toHaveValue('sdz5');
    await expect(page.locator('.remoteStorageWarning')).toHaveCount(0);
  });

  test('a saved drive the host no longer has is left unselected, with a warning that links to the host', async ({ page }) => {
    await listed(page, { status: 200, value: 'sdq9' });
    const warning = page.locator('.remoteStorageWarning');
    await expect(warning).toContainText('sdq9 is not available');
    await expect(warning.locator('a')).toHaveAttribute('href', 'http://192.0.2.77/settings.php#settings-storage');
    // Not silently moved to a drive that was not chosen.
    await expect(remoteDrive(page)).toHaveValue('none');
  });

  test('a saved drive that cannot be read is reported', async ({ page }) => {
    await listed(page, { status: 500 });
    const dialog = page.locator('#dialogOKPopup');
    await expect(dialog).toContainText('Failed to read remote storage location.');
    await expect(dialog.locator('.modal-title')).toHaveText('Remote Host Backup Storage Location');
    await expect(remoteDrive(page)).toHaveValue('none');
  });
});
