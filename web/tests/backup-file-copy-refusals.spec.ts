import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// What the Backup page's File Copy form refuses to start, and what it warns
// of before a restore.  A restore overwrites the player's files, so the
// confirm is the last thing between a wrong click and that: declined, or
// refused for want of a host or a folder, nothing may reach copystorage.php.
// copystorage.php is stubbed, so no copy runs; backup-file-copy-form.spec.ts
// covers the requests a copy that does start makes.

const FOLDER = 'fpp-tests-refusals';

async function openFileCopy(page: Page) {
  const confirms: string[] = [];
  const copies: URL[] = [];
  const answer = { accept: false };
  page.on('dialog', (d) => {
    confirms.push(d.message());
    return answer.accept ? d.accept() : d.dismiss();
  });
  // The form's boxes are settings: saving them is not what is under test.
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.pathname.includes('copystorage.php'), (route) => {
    copies.push(new URL(route.request().url()));
    return route.fulfill({ contentType: 'text/plain', body: 'stub\nDONE\n' });
  });
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  return { confirms, copies, answer };
}

// A restore from this player's own backups, of Configuration only, with a
// folder to restore from put in the list (none need exist: nothing is copied).
async function restoreFromLocal(page: Page) {
  await page.selectOption('#backup\\.Direction', 'FROMLOCAL');
  // The page fills the folder list once the direction is chosen.
  await page.waitForLoadState('networkidle');
  await page.evaluate((folder) => {
    for (const box of document.querySelectorAll<HTMLInputElement>('#CopyFlagsTable input[type=checkbox]')) box.checked = false;
    (document.getElementById('backup.Configuration') as HTMLInputElement).click();
    const sel = document.getElementById('backup.PathSelect') as HTMLSelectElement;
    sel.innerHTML = `<option value="${folder}" selected>${folder}</option>`;
  }, FOLDER);
  await expect(page.locator('#backupCopyBtn')).toBeEnabled({ timeout: 15_000 });
}

const copy = (page: Page) => page.locator('#backupCopyBtn').click();
// Long enough for a request to have left, had Copy sent one.
const settle = (page: Page) => page.waitForTimeout(750);

test('a copy to a remote host with no host chosen is refused', async ({ page }) => {
  const { copies, confirms } = await openFileCopy(page);
  await page.selectOption('#backup\\.Direction', 'TOREMOTE');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const host = document.getElementById('backup.Host') as HTMLSelectElement | HTMLInputElement;
    if (host instanceof HTMLSelectElement) host.innerHTML = '<option value="" selected></option>';
    host.value = '';
  });
  await copy(page);
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('No host specified');
  await expect(dialog.locator('.modal-title')).toHaveText('Copy Failed');
  await settle(page);
  expect(copies, 'nothing was asked of copystorage.php').toEqual([]);
  expect(confirms).toEqual([]);
  await expect(page.locator('#copyPopup_Modal')).toHaveCount(0);
});

test('a restore with no folder to restore from is refused', async ({ page }) => {
  const { copies, confirms } = await openFileCopy(page);
  await restoreFromLocal(page);
  await page.evaluate(() => {
    (document.getElementById('backup.PathSelect') as HTMLSelectElement).innerHTML = '<option value="" selected></option>';
  });
  await copy(page);
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('No path specified');
  await expect(dialog.locator('.modal-title')).toHaveText('Copy Failed');
  await settle(page);
  expect(copies).toEqual([]);
  // Refused before the confirm: there is nothing to confirm.
  expect(confirms).toEqual([]);
});

test('a restore declined at its confirm copies nothing, and says it was cancelled', async ({ page }) => {
  const { copies, confirms, answer } = await openFileCopy(page);
  await restoreFromLocal(page);
  await copy(page);
  await expect(page.locator('.jGrowl-message', { hasText: 'Restore canceled.' })).toBeVisible();
  expect(confirms).toHaveLength(1);
  // The confirm says what is restored, from where, and what it costs.
  expect(confirms[0]).toMatch(/^Confirm File restore of 'Configuration' from \S+\/backups\?/);
  expect(confirms[0]).toContain('WARNING: This will overwrite any current files with the copies being restored');
  await settle(page);
  expect(copies).toEqual([]);
  await expect(page.locator('#copyPopup_Modal')).toHaveCount(0);

  // The control: confirmed, the same form starts the restore.
  answer.accept = true;
  await copy(page);
  await expect.poll(() => copies.length).toBe(1);
  expect(copies[0].searchParams.get('direction')).toBe('FROMLOCAL');
  expect(copies[0].searchParams.get('path')).toBe(FOLDER);
  expect(copies[0].searchParams.get('flags')).toBe('Configuration');
});

test('a restore that also deletes local files says so in its confirm, and only then asks for the delete', async ({ page }) => {
  const { copies, confirms, answer } = await openFileCopy(page);
  await restoreFromLocal(page);
  const extra = page.locator('#backup\\.DeleteExtra');
  answer.accept = true;

  await extra.uncheck();
  await copy(page);
  await expect.poll(() => copies.length).toBe(1);
  expect(confirms[0]).not.toContain('delete any local files');
  expect(copies[0].searchParams.get('delete')).toBe('no');

  // A fresh page: the copy dialog of the first restore is in the way.
  await page.reload();
  await page.click('#backups-fileCopy-tab');
  await restoreFromLocal(page);
  await extra.check();
  await copy(page);
  await expect.poll(() => copies.length).toBe(2);
  expect(confirms[1]).toContain('and delete any local files which do not exist in the backup.');
  expect(copies[1].searchParams.get('delete')).toBe('yes');
});

test("restoring a backup's network settings warns that the player may move address, unless they are kept", async ({ page }) => {
  const { copies, confirms } = await openFileCopy(page);
  await restoreFromLocal(page);
  const area = page.locator('#backup\\.ConfigArea');
  const keep = page.locator('#backup\\.KeepNetwork');
  const MOVES = "This player takes the backup's network settings (IP address, WiFi) at the next reboot, and may then only be reachable at that address.";

  // Every confirm here is declined: the wording is what is under test.
  await area.selectOption('network');
  await keep.uncheck();
  await copy(page);
  await expect.poll(() => confirms.length).toBe(1);
  expect(confirms[0]).toContain(MOVES);
  expect(confirms[0]).toMatch(/with Configuration's settings area '.+' only\?/);
  expect(confirms[0]).toContain('WARNING: This will overwrite the current settings and files being restored');

  // Kept, this player's network settings are not the backup's to change.
  await keep.check();
  await copy(page);
  await expect.poll(() => confirms.length).toBe(2);
  expect(confirms[1]).not.toContain('only be reachable at that address');

  // An area with no network settings in it has nothing to warn of.
  await keep.uncheck();
  await area.selectOption('show_setup/schedule');
  await copy(page);
  await expect.poll(() => confirms.length).toBe(3);
  expect(confirms[2]).not.toContain('only be reachable at that address');

  await settle(page);
  expect(copies).toEqual([]);
});
