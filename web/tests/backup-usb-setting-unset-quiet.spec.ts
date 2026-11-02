import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA } from './settings-file';
import { dropSettings, keepingSettings, setSettingInFile } from './privacy-helpers';

// Regression: 183880caa ("Fix a bunch of warnings in the apache2-error.log").
// A settings backup ends by copying the JSON backups to the chosen USB drive,
// and when no drive is chosen (the normal case: the setting is absent, or
// "none") DoJsonBackupToUSB() wrote "Something went wrong trying to call
// filecopy endpoint ..." to the PHP error log, so every settings backup put an
// error in Apache's log.  (Its read of the absent setting also drew an
// "Undefined array key" warning; the API's error handler swallows that one,
// so only the logged error shows.)

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const LOG = `${MEDIA}/logs/apache2-error.log`;
const LISTED = '/tmp/fpp-tests-backup-usb-unset.backups';

// Earlier tests' backups are set aside: the rotation prunes at 60.
const ASIDE = `${LISTED}.aside`;
test.beforeEach(() => inPlayer('sh', '-c', `mkdir -p ${BACKUPS} && rm -rf ${ASIDE} && mkdir ${ASIDE} && find ${BACKUPS} -mindepth 1 -maxdepth 1 -exec mv {} ${ASIDE}/ \\; && ls ${BACKUPS} > ${LISTED}`));
test.afterEach(() => inPlayer('sh', '-c', `cd ${BACKUPS} && ls | grep -vxF -f ${LISTED} | xargs -r rm -f; rm -f ${LISTED}; find ${ASIDE} -mindepth 1 -maxdepth 1 -exec mv {} ${BACKUPS}/ \\; ; rmdir ${ASIDE}`));

const logged = (pattern: string) =>
  Number(inPlayer('sh', '-c', `grep -c '${pattern}' ${LOG} 2>/dev/null || true`).trim() || 0);

for (const chosen of [undefined, 'none']) {
  test(`a settings backup with the backup drive ${chosen === undefined ? 'never chosen' : `set to '${chosen}'`} logs no error`, async ({ request }) => {
    await keepingSettings(async () => {
      if (chosen === undefined) dropSettings('jsonConfigBackupUSBLocation');
      else setSettingInFile('jsonConfigBackupUSBLocation', chosen);
      const before = logged('DoJsonBackupToUSB');
      const undef = logged('Undefined array key');

      const r = await request.post('/api/backups/configuration', { data: { backup_comment: 'fpp-tests usb unset' } });
      const made = await r.json();
      expect(made.success, JSON.stringify(made)).toBe(true);
      // The control: the backup was written, so the copy-to-drive step ran, and
      // found nothing to copy to.
      expect(made.copied_to_usb).toBe(false);
      await expect.poll(() => inPlayer('sh', '-c', `ls ${BACKUPS} | grep -vxF -f ${LISTED} | wc -l`).trim()).not.toBe('0');

      await new Promise((res) => setTimeout(res, 500));
      const tail = inPlayer('sh', '-c', `tail -4 ${LOG} 2>/dev/null || true`);
      expect(logged('Undefined array key') - undef, tail).toBe(0);
      expect(logged('DoJsonBackupToUSB') - before, tail).toBe(0);
    });
  });
}
