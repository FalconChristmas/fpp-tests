import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// What a File Copy copies, from the Backup page's choices to the rsync calls
// copy_settings_to_storage.sh makes, and what it reports back.  The player
// has no rsync, so a stand-in in /usr/local/bin (which sudo's secure_path
// finds first) logs how the copy script called it and fails as an rsync with
// a partial transfer does (exit 23).  Every copy is a restore from this
// player's own backups folder.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-rsync-stub';
const RSYNC = '/usr/local/bin/rsync';
const LOG = '/tmp/fpp-tests-rsync.log';
const HOLD = '/tmp/fpp-tests-rsync-hold';
const FOLDER = 'fpp-tests-backups-flag';
const SOURCE = `/home/fpp/media/backups/${FOLDER}`;
// The rsync of the folder (its source may be named through the media link,
// and older scripts put no -- before it).
const COPIED = new RegExp(`^rsync .* (-- )?\\S*/backups/${FOLDER}/backups /home/fpp/media$`, 'm');
const FPPD_LOG = '/home/fpp/media/logs/fppd.log';

test.beforeEach(() => {
  const real = inPlayer('sh', '-c', `test -e ${RSYNC} && ! grep -q ${MARK} ${RSYNC} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${RSYNC} is a real program in the player; not replacing it`);
  // HOLD, while it exists, keeps the copy running.
  putFile(RSYNC, `#!/bin/sh\n# ${MARK}\necho "rsync $*" >> ${LOG}\n` +
    `while [ -e ${HOLD} ]; do sleep 0.2; done\nexit 23\n`);
  inPlayer('sh', '-c', `chmod 755 ${RSYNC} && : > ${LOG} && chmod 666 ${LOG} && mkdir -p ${SOURCE}/backups`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `grep -q ${MARK} ${RSYNC} 2>/dev/null && rm -f ${RSYNC}; rm -rf ${LOG} ${HOLD} ${SOURCE}; true`);
});

test('the Backups checkbox is offered for every Copy Type, and a restore with it ticked copies the folder', async ({ page }) => {
  // Regression: dddd15a49 (#2800).  The checkbox was shown only for a copy
  // to USB, and GetCopyFlags() sent "Backups" only when its
  // `direction = ... == 'TOUSB'` (an assignment) held, so a restore could
  // never bring the backups folder back.
  test.setTimeout(120_000);
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  const backups = page.locator('#tab-fileCopy .copyBackups').first();
  for (const direction of ['TOUSB', 'FROMUSB', 'TOLOCAL', 'TOREMOTE', 'FROMREMOTE', 'FROMLOCAL']) {
    await page.selectOption('#backup\\.Direction', direction);
    await expect(backups, `the Backups checkbox for ${direction}`).toBeVisible();
  }

  // FROMLOCAL is selected: restore just the Backups folder from FOLDER.
  await expect(page.locator(`#backup\\.PathSelect option[value="${FOLDER}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#backup\\.PathSelect', FOLDER);
  await page.evaluate(() => {
    for (const box of document.querySelectorAll<HTMLInputElement>('#tab-fileCopy input[type=checkbox][id^="backup."]')) {
      box.checked = box.id === 'backup.Backups';
    }
  });
  page.on('dialog', (d) => d.accept());
  const started = page.waitForRequest((r) => r.url().includes('copystorage.php'));
  await page.click('#tab-fileCopy input[type=button][value="Copy"]');
  const url = new URL((await started).url());
  expect(url.searchParams.get('flags')).toBe('Backups');
  await expect(page.locator('#copyPopup_ModalCloseButton')).toBeEnabled({ timeout: 90_000 });
  // The receiving end: the copy script took the flag and copied the folder.
  expect(inPlayer('cat', LOG)).toMatch(COPIED);
});

test("a File Copy whose copy fails says so in fppd.log's FINISH line", async ({ request }) => {
  // Regression: 444e50277.  copystorage.php ran the copy script piped into
  // tee under /bin/sh, with no pipefail, so the status it logged was tee's:
  // "backup FINISH ... (rc=0)" for a copy that had failed.  (The copy
  // script itself only reports a failed rsync in its exit code since later
  // fixes, so this goes red on a revert of the pipefail on today's tree, not
  // on the fix's parent.)
  const r = await request.get(`/copystorage.php?direction=FROMLOCAL&storageLocation=x&path=${FOLDER}` +
    '&flags=Backups&delete=no&compress=no', { timeout: 90_000 });
  expect(r.ok()).toBe(true);
  // The control: the copy ran, and its rsync failed.
  expect(inPlayer('cat', LOG)).toMatch(COPIED);
  const finish = inPlayer('sh', '-c', `grep 'backup FINISH: FROMLOCAL' ${FPPD_LOG} | tail -1`).trim();
  expect(finish).toMatch(/\(rc=23\)$/);
});

// A restore marks the player for a reboot and a boot-time apply; put that back.
const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; /^pluginReinstallNeededAfterOS\\s*=/d; ` +
  `s/^rebootFlag\\s*=.*/rebootFlag = "0"/' /home/fpp/media/settings`;

function rsyncCalls(): string[] {
  return inPlayer('cat', LOG).split('\n').filter((l) => l.startsWith('rsync '));
}

test("a Configuration restore doesn't copy the source's fpp-info.json", async ({ request }) => {
  // Regression: bdb1634d7.  The backed-up fpp-info.json (version, branch,
  // build of the player the backup came from) was copied over this
  // player's own.  The receiving end, rsync, is a stand-in: this checks it
  // is told to leave the file out.  (The fix's other half, setting up the
  // MQTT broker and other services right after the restore, was replaced by
  // 464d2f53e's boot-time BootActions path.)
  try {
    await request.get(`/copystorage.php?direction=FROMLOCAL&storageLocation=x&path=${FOLDER}` +
      '&flags=Configuration&delete=no&compress=no', { timeout: 90_000 });
    const config = rsyncCalls();
    expect(config, 'the copy ran no rsync').toHaveLength(1);
    expect(config[0].split(' ')).toContain('--exclude=fpp-info.json');
  } finally {
    inPlayer('sh', '-c', CLEAR);
  }
});

test("an All restore doesn't bring the source's backups folder across", async ({ request }) => {
  // Regression: 2db3b8395 (#2714), the script half: the "All" rsync
  // excluded music, sequences and videos but not backups/, so a restore
  // re-imported the source's own backups (backups of backups).
  try {
    await request.get(`/copystorage.php?direction=FROMLOCAL&storageLocation=x&path=${FOLDER}` +
      '&flags=All&delete=no&compress=no', { timeout: 90_000 });
    const all = rsyncCalls()[0] ?? '';
    // The control: this is the rsync of the whole media folder.
    expect(all.split(' '), all).toContain('--exclude=music/*');
    expect(all.split(' '), all).toContain('--exclude=backups/*');
  } finally {
    inPlayer('sh', '-c', CLEAR);
  }
});

test("a restore doesn't offer the backups folder's top level, '/', as a backup", async ({ page }) => {
  // Regression: 2db3b8395 (#2714), the page half: the folder list for a
  // restore from this player's backups (and from a remote's) included "/",
  // which is every backup folder at once; restoring it copied them all into
  // the media folder.
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  const listed = page.waitForResponse((r) => /\/api\/backups\/list(\?|$)/.test(r.url()));
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  await page.selectOption('#backup\\.Direction', 'FROMLOCAL');
  const answer = await (await listed).json();
  // The control: the player's own list has the top level in it.
  expect(answer).toContain('/');
  await expect(page.locator(`#backup\\.PathSelect option[value="${FOLDER}"]`)).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#backup\\.PathSelect option[value="/"]')).toHaveCount(0);
});

test("the File Copy dialog's Close button waits for the copy, and waits again on the next one", async ({ page }) => {
  // Regression: cae995121.  The File Copy dialog had no Close button of its
  // own until the copy was done (a bare "Close" input appeared in the body),
  // unlike the other progress dialogs; now its footer button reads "Please
  // Wait", disabled, until the copy finishes, and is reset for each copy.
  // The copy is of Playlists, which every Copy Type has always sent.
  test.setTimeout(120_000);
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  await page.selectOption('#backup\\.Direction', 'FROMLOCAL');
  await expect(page.locator(`#backup\\.PathSelect option[value="${FOLDER}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#backup\\.PathSelect', FOLDER);
  await page.evaluate(() => {
    for (const box of document.querySelectorAll<HTMLInputElement>('#tab-fileCopy input[type=checkbox][id^="backup."]')) {
      box.checked = box.id === 'backup.Playlists';
    }
  });
  page.on('dialog', (d) => d.accept());
  const close = page.locator('#copyPopup_ModalCloseButton');
  for (let run = 0; run < 2; run++) {
    inPlayer('touch', HOLD);
    await page.click('#tab-fileCopy input[type=button][value="Copy"]');
    await expect.poll(() => inPlayer('cat', LOG), { timeout: 30_000 }).toMatch(/^rsync .*\/playlists /m);
    // The copy is running (held in rsync).
    await expect(close, `run ${run + 1}`).toBeDisabled();
    await expect(close).toHaveText('Please Wait');
    inPlayer('rm', '-f', HOLD);
    await expect(close).toBeEnabled({ timeout: 60_000 });
    await expect(close).toHaveText('Close');
    await close.click();
    await expect(page.locator('#copyPopup_Modal')).toBeHidden();
    inPlayer('sh', '-c', `: > ${LOG}`);
  }
});
