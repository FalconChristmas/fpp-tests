import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// A File Copy to or from another player (copystorage.php running
// copy_settings_to_storage.sh): the arguments it hands rsync's daemon
// syntax, and what it says when an rsync fails.  The player has no rsync, so
// a stand-in in /usr/local/bin (which sudo's secure_path finds first) logs
// the call and refuses what the real rsync refuses: a second "--" is taken
// as a file name, and "host::path/*" is never expanded by a shell (the
// daemon is asked for a file called "*").  It exits 23 when the flag file
// exists.  The device scenario test_file_copy_remote.py runs the real
// rsync against FPP's own rsyncd.conf.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-rsync-strict-stub';
const RSYNC = '/usr/local/bin/rsync';
const LOG = '/tmp/fpp-tests-rsync-strict.log';
const FAIL = '/tmp/fpp-tests-rsync-strict.fail';
const FOLDER = 'fpp-tests-backups-rsync-rc';

const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; /^pluginReinstallNeededAfterOS\\s*=/d; ` +
  `s/^rebootFlag\\s*=.*/rebootFlag = "0"/' /home/fpp/media/settings`;

const STUB = `#!/bin/sh
# ${MARK}
echo "rsync $*" >> ${LOG}
dd=0
for a in "$@"; do
  case "$a" in
    --) dd=$((dd+1)) ;;
    *::*/\\*) echo "rsync: change_dir \\"/$a\\" (in media) failed" >&2; exit 23 ;;
  esac
done
if [ $dd -gt 1 ]; then echo "rsync: link_stat \\"--\\" failed: No such file or directory" >&2; exit 23; fi
[ -e ${FAIL} ] && exit 23
exit 0
`;

test.beforeEach(() => {
  const real = inPlayer('sh', '-c', `test -e ${RSYNC} && ! grep -q ${MARK} ${RSYNC} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${RSYNC} is a real program in the player; not replacing it`);
  putFile(RSYNC, STUB);
  inPlayer('sh', '-c', `chmod 755 ${RSYNC} && : > ${LOG} && chmod 666 ${LOG} && rm -f ${FAIL}`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `grep -q ${MARK} ${RSYNC} 2>/dev/null && rm -f ${RSYNC}; rm -f ${LOG} ${FAIL}; ` +
    `rm -rf /home/fpp/media/tmp/backups; ${CLEAR}; true`);
});

const restore = async (request: any, flags: string) => (await request.get('/copystorage.php?direction=FROMREMOTE' +
  `&storageLocation=127.0.0.1&path=${FOLDER}&flags=${encodeURIComponent(flags)}&delete=no&compress=no&remoteStorage=none`,
{ timeout: 90_000 })).text();
const calls = () => inPlayer('cat', LOG).split('\n').filter((l) => l.startsWith('rsync '));

test('a Restore From Remote of the configuration and plugins hands rsync directories, not a "*" and a second "--"', async ({ request }) => {
  // Regression: 372cb3a97 (#2907).  The restore ran rsync with
  // "127.0.0.1::media/backups/<folder>/*", which no shell expands for a
  // daemon path (rsync asked the other player for a file called "*" and
  // failed), and with a second "--" before the destination, which rsync
  // took as a file name.  Every File Copy Restore from another player
  // failed.
  const out = await restore(request, 'Configuration Plugins');
  const sent = calls();
  // The control: both items ran their rsync from the other player's folder.
  const src = `127\\.0\\.0\\.1::media/backups/${FOLDER}`;
  expect(sent.filter((l) => new RegExp(` -- ${src}/ /home/fpp/media$`).test(l))).toHaveLength(2);
  expect(sent.some((l) => l.includes("--include=plugin*"))).toBe(true);
  for (const l of sent) {
    expect(l).not.toMatch(/::\S*\/\*/);
    expect(l.match(/ -- /g) ?? []).toHaveLength(1);
  }
  expect(out).not.toContain('BACKUP FAILED');
  expect(out).toContain('BACKUP COMPLETE');
});

test('a File Copy whose rsync fails says the backup failed, not that it is complete', async ({ request }) => {
  // Regression: 372cb3a97 (#2907).  The script ignored rsync's exit code
  // and always ended "BACKUP COMPLETE - All selected items have been
  // successfully copied", so a copy that moved nothing was reported as done
  //.
  inPlayer('sh', '-c', `touch ${FAIL}`);
  const out = await restore(request, 'Playlists');
  // The control: the rsync ran and was the thing that failed.
  expect(calls().filter((l) => l.includes('/playlists '))).toHaveLength(1);
  expect(out).toContain('BACKUP FAILED (rc=23)');
  expect(out).not.toContain('BACKUP COMPLETE');
  expect(out).not.toContain('All selected items have been successfully copied.');
});
