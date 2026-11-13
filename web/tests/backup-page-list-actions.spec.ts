import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { BACKUPS, exists, putFile } from './settings-file';

// The Backup page's two lists of the settings backups the player keeps:
// "Download Existing Backups", with a download and a delete button for each,
// and "Restore Existing Backups", with a restore button.  The backups here
// are the test's own files among the player's; a restore is answered by the
// test (what the API does with one is backup-api-drive-download-restore.spec.ts
// and the backup-restore-* specs), a delete and a download are the player's.

test.skip(!container, "puts backups among the run-web.sh container's own");

// Named as the player names its own, and taken (backup_taken, which the
// list goes by) a day and two ahead: every settings change (each page's own
// theme reset is one) makes a backup and prunes the oldest beyond sixty,
// which here would be the test's.
const stamp = (hoursAgo: number) => {
  const d = new Date(Date.now() - hoursAgo * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};
const ONE = `fpp-tests-list-backup_v10_${stamp(-48)}.json`;
const TWO = `fpp-tests-list-backup_v10_${stamp(-24)}.json`;
const AHEAD = Math.floor(Date.now() / 1000) + 86400;
const backup = (comment: string, taken = AHEAD) => ({ fpp_backup_version: '10', backup_comment: comment, backup_taken: taken, settings: { system_settings: [{}] } });

test.beforeEach(() => {
  inPlayer('mkdir', '-p', BACKUPS);
  putFile(`${BACKUPS}/${ONE}`, JSON.stringify(backup('fpp-tests list one', AHEAD + 86400)));
  putFile(`${BACKUPS}/${TWO}`, JSON.stringify(backup('fpp-tests list two')));
});
test.afterEach(() => {
  inPlayer('sh', '-c', `rm -f ${BACKUPS}/fpp-tests-list-backup_*`);
});

const downloads = (page: Page) => page.locator('#table-download-existing-backups-content tr');
const restores = (page: Page) => page.locator('#table-restore-existing-backups-content tr');
async function open(page: Page) {
  await page.goto('/backup.php');
  await expect(downloads(page).filter({ hasText: 'fpp-tests list one' })).toHaveCount(1, { timeout: 15_000 });
}

test('each backup is listed in both lists with its time and what was changed, on the SD card', async ({ page }) => {
  await open(page);
  for (const list of [downloads(page), restores(page)]) {
    for (const comment of ['fpp-tests list one', 'fpp-tests list two']) {
      const row = list.filter({ hasText: comment });
      await expect(row).toHaveCount(1);
      await expect(row.locator('td').first()).toHaveText(/\w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} \d{4}/);
      await expect(row.locator('i.fa-sd-card')).toHaveCount(1);
    }
  }
  // Newest first.
  const comments = await downloads(page).locator('td:nth-child(2)').allTextContents();
  expect(comments.indexOf('fpp-tests list one')).toBeLessThan(comments.indexOf('fpp-tests list two'));
  const row = downloads(page).filter({ hasText: 'fpp-tests list one' });
  await expect(row.locator('button.downloadConfigButton')).toHaveCount(1);
  await expect(row.locator('button.deleteConfigButton')).toHaveCount(1);
  await expect(restores(page).filter({ hasText: 'fpp-tests list one' }).locator('button.restoreJsonConfigActionButton')).toHaveCount(1);
});

test("a backup's delete button deletes that file and takes it out of both lists", async ({ page }) => {
  await open(page);
  await downloads(page).filter({ hasText: 'fpp-tests list one' }).locator('button.deleteConfigButton').click();
  await expect(downloads(page).filter({ hasText: 'fpp-tests list one' })).toHaveCount(0);
  await expect(restores(page).filter({ hasText: 'fpp-tests list one' })).toHaveCount(0);
  expect(exists(`${BACKUPS}/${ONE}`)).toBe(false);
  // The other one is still there, listed and on the player.
  await expect(downloads(page).filter({ hasText: 'fpp-tests list two' })).toHaveCount(1);
  await expect(restores(page).filter({ hasText: 'fpp-tests list two' })).toHaveCount(1);
  expect(exists(`${BACKUPS}/${TWO}`)).toBe(true);
});

test('a delete the player refuses, or does not answer, is an error and the backup stays listed', async ({ page }) => {
  await open(page);
  const row = downloads(page).filter({ hasText: 'fpp-tests list one' });
  const dialog = page.locator('.modal.show');
  let answer: { status?: number; json: unknown } = { json: { Status: 'Error', Message: 'could not' } };
  await page.route(`**/api/backups/configuration/JsonBackups/${ONE}`, (route) =>
    route.request().method() === 'DELETE' ? route.fulfill(answer) : route.fallback());

  await row.locator('button.deleteConfigButton').click();
  await expect(dialog).toContainText(`Error deleting file "${ONE}": Error`);
  await dialog.getByRole('button', { name: /close/i }).first().click();
  await expect(dialog).toBeHidden();

  answer = { status: 500, json: {} };
  await row.locator('button.deleteConfigButton').click();
  await expect(dialog).toContainText(`Error deleting file: ${ONE}`);
  await expect(row).toHaveCount(1);
  expect(exists(`${BACKUPS}/${ONE}`)).toBe(true);
});

test("a backup's download button downloads that backup, whole, under its own name", async ({ page }) => {
  await open(page);
  const started = page.waitForEvent('download');
  await downloads(page).filter({ hasText: 'fpp-tests list two' }).locator('button.downloadConfigButton').click();
  const download = await started;
  expect(download.suggestedFilename()).toBe(TWO);
  const path = await download.path();
  expect(JSON.parse(require('fs').readFileSync(path, 'utf8'))).toEqual(backup('fpp-tests list two'));
});

test.describe("a backup's restore button", () => {
  async function restoring(page: Page, answer: { status?: number; json: unknown }) {
    const asked: { url: string; body: string | null }[] = [];
    await page.route('**/api/backups/configuration/restore/**', (route) => {
      asked.push({ url: new URL(route.request().url()).pathname, body: route.request().postData() });
      return route.fulfill(answer);
    });
    await open(page);
    return asked;
  }
  const button = (page: Page) => restores(page).filter({ hasText: 'fpp-tests list two' }).locator('button.restoreJsonConfigActionButton');

  test('asks the player to restore that backup, and the area picked above the list', async ({ page }) => {
    const asked = await restoring(page, { json: { Success: true, Message: [] } });
    // The area's own choices, whatever they are: the second one, and its value.
    const area = await page.locator('#restorearea option').nth(1).getAttribute('value');
    await page.selectOption('#restorearea', area!);
    await button(page).click();
    await expect(page.locator('.jGrowl-notification', { hasText: 'Successfully restored selected backup' })).toBeVisible();
    expect(asked).toEqual([{ url: `/api/backups/configuration/restore/JsonBackups/${TWO}`, body: area }]);
    expect(area).not.toBe('');
    // The spinner on the button is taken off again.
    await expect(button(page).locator('i.fpp-backup-action-loading')).toHaveCount(0);
  });

  test('says so when the player reports the restore failed', async ({ page }) => {
    await restoring(page, { json: { Success: false, Message: ['doRestore: nope'] } });
    await button(page).click();
    await expect(page.locator('.jGrowl-notification', { hasText: 'Error occurred restoring selected backup' })).toBeVisible();
    await expect(page.locator('.jGrowl-notification', { hasText: 'Successfully restored' })).toHaveCount(0);
  });

  test('stops its spinner when the player does not answer (the control)', async ({ page }) => {
    const asked = await restoring(page, { status: 500, json: {} });
    await button(page).click();
    await expect.poll(() => asked.length).toBe(1);
    await expect(button(page).locator('i.fpp-backup-action-loading')).toHaveCount(0);
  });

  test('is an error dialog when the player does not answer', async ({ page }) => {
    // The error handler passes DialogError the request's .Message, which a
    // failed request does not have: no dialog opens, and a restore that never
    // happened looks like a button that did nothing.  In FUTURE.md.
    await restoring(page, { status: 500, json: {} });
    await button(page).click();
    await expect(page.locator('.modal.show .modal-title')).toHaveText('Error occurred attempting to restore data');
  });
});

test('a backup on the backup drive is marked as on the drive, and its buttons act on the drive', async ({ page }) => {
  // The list is the test's: one backup, on the drive.
  const NAME = 'fpp-tests-list-drive_v10_20261001000000.json';
  await page.route('**/api/backups/configuration/list', (route) => route.fulfill({ json: [{
    backup_alternative_location: true, backup_filedirectory: '/mnt/tmp/Automatic_Backups/config/backups', backup_filename: NAME,
    backup_comment: 'fpp-tests on the drive', backup_time: 'Thu Oct 01 00:00:00 2026', backup_time_unix: '1790812800', backup_blob_refs: [],
  }] }));
  const asked: string[] = [];
  await page.route('**/api/backups/configuration/**', (route) => {
    const r = route.request();
    if (r.method() === 'GET') return route.fallback();
    asked.push(`${r.method()} ${new URL(r.url()).pathname}`);
    return route.fulfill({ json: r.method() === 'DELETE' ? { Status: 'OK' } : { Success: true } });
  });
  await page.goto('/backup.php');
  const row = downloads(page).filter({ hasText: 'fpp-tests on the drive' });
  await expect(row.locator('i.fa-hdd')).toHaveCount(1);
  await expect(restores(page).filter({ hasText: 'fpp-tests on the drive' }).locator('i.fa-hdd')).toHaveCount(1);

  await restores(page).locator('button.restoreJsonConfigActionButton').click();
  await expect.poll(() => asked).toEqual([`POST /api/backups/configuration/restore/JsonBackupsAlternate/${NAME}`]);
  await row.locator('button.deleteConfigButton').click();
  await expect.poll(() => asked[1]).toBe(`DELETE /api/backups/configuration/JsonBackupsAlternate/${NAME}`);
  await expect(row).toHaveCount(0);
});

test('a list that cannot be read says so in place of the backups', async ({ page }) => {
  await page.route('**/api/backups/configuration/list', (route) => route.fulfill({ status: 500, body: 'no' }));
  await page.goto('/backup.php');
  await expect(downloads(page)).toHaveText(/Error Occured Retreiving Existing Backup List/);
  await expect(downloads(page).locator('button')).toHaveCount(0);
});

test.describe("what a backup says was changed is shown as it is written", () => {
  test('plain text (the control)', async ({ page }) => {
    await open(page);
    await expect(downloads(page).filter({ hasText: 'fpp-tests list one' }).locator('td:nth-child(2)')).toHaveText('fpp-tests list one');
  });

  test('text with markup in it', async ({ page }) => {
    // The comment is put into the row as HTML.  It is whatever the backup
    // file says: a backup brought from another player, or made by a change
    // whose description holds a name (a config file, a plugin).  In FUTURE.md.
    const comment = 'fpp-tests list <u id="fpp-tests-list-markup">marked</u> up';
    putFile(`${BACKUPS}/${ONE}`, JSON.stringify(backup(comment, AHEAD + 86400)));
    await page.goto('/backup.php');
    const cell = downloads(page).filter({ hasText: 'fpp-tests list' }).filter({ hasText: 'marked' }).locator('td:nth-child(2)');
    await expect(cell).toHaveCount(1, { timeout: 15_000 });
    await expect(cell).toHaveText(comment);
    await expect(page.locator('#fpp-tests-list-markup')).toHaveCount(0);
  });
});
