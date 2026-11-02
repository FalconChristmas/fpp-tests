import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The Backup page's "Send Compressed Data" choice, from the checkbox to the
// rsync calls copy_settings_to_storage.sh makes.  The player has no rsync, so
// a stand-in in /usr/local/bin logs how the script called it (the stand-in
// of file-copy-what-is-copied.spec.ts).

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-rsync-stub';
const RSYNC = '/usr/local/bin/rsync';
const LOG = '/tmp/fpp-tests-rsync-compress.log';
const FOLDER = 'fpp-tests-compress';
const SOURCE = `/home/fpp/media/backups/${FOLDER}`;

test.beforeEach(() => {
  const real = inPlayer('sh', '-c', `test -e ${RSYNC} && ! grep -q ${MARK} ${RSYNC} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${RSYNC} is a real program in the player; not replacing it`);
  putFile(RSYNC, `#!/bin/sh\n# ${MARK}\necho "rsync $*" >> ${LOG}\nexit 0\n`);
  inPlayer('sh', '-c', `chmod 755 ${RSYNC} && : > ${LOG} && chmod 666 ${LOG} && mkdir -p ${SOURCE}/sequences`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `grep -q ${MARK} ${RSYNC} 2>/dev/null && rm -f ${RSYNC}; rm -rf ${LOG} ${SOURCE}; true`);
});

function sequencesRsync(): string[] {
  const calls = inPlayer('cat', LOG).split('\n').filter((l) => /\/sequences /.test(l));
  expect(calls, 'the copy ran no rsync of the sequences').toHaveLength(1);
  return calls[0].split(' ');
}

for (const [compress, expected] of [['yes', true], ['no', false]] as const) {
  test(`a copy with compress=${compress} ${expected ? 'asks' : 'does not ask'} rsync for compression`, async ({ request }) => {
    // Regression: a693aa51a.  The script took a new COMPRESS argument (the
    // Send Compressed Data choice) that must put -Dz on the rsyncs of the
    // data that compresses; it is "yes" or "no", and anything else means no.
    const r = await request.get(`/copystorage.php?direction=FROMLOCAL&storageLocation=x&path=${FOLDER}` +
      `&flags=Sequences&delete=no&compress=${compress}`, { timeout: 90_000 });
    expect(r.ok()).toBe(true);
    const argv = sequencesRsync();
    // The control: the rsync ran the way a restore of the folder does.
    expect(argv).toContain('-av');
    expect(argv.includes('-Dz'), argv.join(' ')).toBe(expected);
  });
}

test('the Send Compressed Data checkbox sets compress= on the copy request', async ({ page }) => {
  // Regression: a693aa51a.  PerformCopy() added compress=yes/no to the copy
  // URL from backup.sendCompressed; without it the script never saw the
  // choice.
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  await page.selectOption('#backup\\.Direction', 'FROMLOCAL');
  await expect(page.locator(`#backup\\.PathSelect option[value="${FOLDER}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#backup\\.PathSelect', FOLDER);
  page.on('dialog', (d) => d.accept());
  const seen: Record<string, string | null> = {};
  for (const checked of [true, false]) {
    await page.evaluate((on) => {
      for (const box of document.querySelectorAll<HTMLInputElement>('#tab-fileCopy input[type=checkbox][id^="backup."]')) {
        box.checked = box.id === 'backup.Sequences';
      }
      (document.getElementById('backup.sendCompressed') as HTMLInputElement).checked = on;
    }, checked);
    const started = page.waitForRequest((r) => r.url().includes('copystorage.php'));
    await page.click('#tab-fileCopy input[type=button][value="Copy"]');
    seen[String(checked)] = new URL((await started).url()).searchParams.get('compress');
    await expect(page.locator('#copyPopup_ModalCloseButton')).toBeEnabled({ timeout: 90_000 });
    await page.locator('#copyPopup_ModalCloseButton').click();
    await expect(page.locator('#copyPopup_Modal')).toBeHidden();
  }
  expect(seen).toEqual({ true: 'yes', false: 'no' });
});
