import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The Backup page, and the setup wizard's File Copy restore, since they stopped
// getting every setting in their script (2fac94d9d): the Backup page gets the
// array every page gets, so what it took from the old one must still work, and
// both name the local backups folder from PHP (2cf7e42f8).  The player has no
// rsync, so a stand-in (sudo's secure_path finds /usr/local/bin first) logs
// the copy script's calls, as in file-copy-what-is-copied.spec.ts.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-rsync-stub';
const RSYNC = '/usr/local/bin/rsync';
const LOG = '/tmp/fpp-tests-rsync.log';
const FOLDER = 'fpp-tests-local-copy';
const MEDIA_BACKUPS = '/home/fpp/media/backups';
const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; /^pluginReinstallNeededAfterOS\\s*=/d; ` +
  `s/^rebootFlag\\s*=.*/rebootFlag = "0"/' /home/fpp/media/settings`;

test.beforeEach(() => {
  const real = inPlayer('sh', '-c', `test -e ${RSYNC} && ! grep -q ${MARK} ${RSYNC} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${RSYNC} is a real program in the player; not replacing it`);
  putFile(RSYNC, `#!/bin/sh\n# ${MARK}\necho "rsync $*" >> ${LOG}\nexit 0\n`);
  inPlayer('sh', '-c', `chmod 755 ${RSYNC} && : > ${LOG} && chmod 666 ${LOG} && mkdir -p ${MEDIA_BACKUPS}/${FOLDER}/config`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `${CLEAR}; grep -q ${MARK} ${RSYNC} 2>/dev/null && rm -f ${RSYNC}; rm -rf ${LOG} ${MEDIA_BACKUPS}/${FOLDER}; true`);
});

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

// The real path of the player's backups folder (media is a link to /tmp).
function backupsDir(): string {
  return inPlayer('php', '-r', 'chdir("/opt/fpp/www"); $skipJSsettings = 1; require "config.php"; echo $settings["mediaDirectory"] . "/backups";').trim();
}

test('the Backup page lists the saved backups and makes a new one', async ({ page, request }) => {
  // Regression check for 2fac94d9d: the page works from the ordinary array.
  const comment = `fpp-tests listed ${Date.now()}`;
  const made = await request.post('/api/backups/configuration', { data: comment });
  expect(made.ok()).toBe(true);
  const errors = watchErrors(page);
  await page.goto('/backup.php');
  const rows = page.locator('#table-download-existing-backups-content tr');
  await expect(rows.filter({ hasText: comment })).toHaveCount(1, { timeout: 15_000 });


  // Download Configuration saves a copy here as well as downloading it: a
  // manual backup now heads the list, above the one made above.  (Not by
  // count: the folder keeps only the newest backups, so after a long run the
  // count stays put.)
  const download = page.waitForEvent('download');
  await page.click('button[name="btnDownloadConfig"]');
  expect((await download).suggestedFilename()).toMatch(/^FPP_.*backup_.*\.json$/);
  await page.goto(`/backup.php?fpp-tests=${Date.now()}`);
  const texts = () => rows.allInnerTexts();
  await expect.poll(async () => {
    const t = await texts();
    const ours = t.findIndex((r) => r.includes(comment));
    return ours > 0 && t.slice(0, ours).some((r) => r.includes('User Initiated Manual Backup'));
  }, { timeout: 15_000, message: 'no manual backup above the one this test made' }).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test("the Backup page's File Copy to the local backups folder names the real folder", async ({ page }) => {
  // Check for 2fac94d9d: with the ordinary array the page no longer gets
  // settings['mediaDirectory'] (9ba17bfb5 hid it), which its local storage
  // location was built from; 2fac94d9d has PHP name the folder instead.  (No
  // red: before 2fac94d9d the page got every setting, mediaDirectory too.)
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  await page.selectOption('#backup\\.Direction', 'TOLOCAL');
  await page.fill('#backup\\.Path', FOLDER);
  await page.evaluate(() => {
    for (const box of document.querySelectorAll<HTMLInputElement>('#tab-fileCopy input[type=checkbox][id^="backup."]')) {
      box.checked = box.id === 'backup.Configuration';
    }
  });
  page.on('dialog', (d) => d.accept());
  const started = page.waitForRequest((r) => r.url().includes('copystorage.php'));
  await page.click('#tab-fileCopy input[type=button][value="Copy"]');
  const url = new URL((await started).url());
  expect(url.searchParams.get('direction')).toBe('TOLOCAL');
  expect(url.searchParams.get('storageLocation')).toBe(backupsDir());
  await expect(page.locator('#copyPopup_ModalCloseButton')).toBeEnabled({ timeout: 90_000 });
  // The receiving end: the copy script copied the configuration into the folder.
  expect(inPlayer('cat', LOG)).toMatch(new RegExp(`/backups/${FOLDER}`));
  expect(errors, errors.join('\n')).toEqual([]);
});

test("the setup wizard's restore from the local backups folder names the real folder", async ({ page }) => {
  // Regression: 2cf7e42f8.  initialSetup.php read settings['mediaDirectory'],
  // which the setup page doesn't get (9ba17bfb5), so it asked to confirm a
  // restore "from undefined/backups" and sent that as the storage location.
  test.setTimeout(120_000);
  await page.goto('/initialSetup.php');
  await page.click('#restoreSetupBtn');
  await expect(page.locator('#restoreDialog')).toBeVisible();
  await page.selectOption('#restoreType', 'filecopy');
  await page.selectOption('#fileCopyDirection', 'FROMLOCAL');
  await expect(page.locator(`#fcPathSelect option[value="${FOLDER}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#fcPathSelect', FOLDER);
  for (const box of await page.locator('.fcFlag').all()) {
    if (await box.getAttribute('value') !== 'Configuration') await box.uncheck();
  }
  const where = backupsDir();
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.accept(); });
  const sent = page.waitForRequest((r) => r.url().includes('copystorage.php'));
  await page.click('#fileCopyRestoreBtn');
  const url = new URL((await sent).url());
  expect(asked).toContain(`from ${where}?`);
  expect(url.searchParams.get('storageLocation')).toBe(where);
  await expect(page.locator('#fileCopyPopup_ModalCloseButton')).toBeEnabled({ timeout: 90_000 });
});
