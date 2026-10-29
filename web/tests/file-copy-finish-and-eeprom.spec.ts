import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// A File Copy (copystorage.php running copy_settings_to_storage.sh): what it
// tells the user when it is done, and how it moves the cape EEPROM to and
// from another player.  The player has no rsync, so a stand-in in
// /usr/local/bin (which sudo's secure_path finds first) logs how the copy
// script called it and succeeds.  The device scenario
// test_file_copy_remote.py runs the real rsync against FPP's own rsyncd.conf.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-rsync-ok-stub';
const RSYNC = '/usr/local/bin/rsync';
const LOG = '/tmp/fpp-tests-rsync-ok.log';
const FOLDER = 'fpp-tests-backups-finish';
const SOURCE = `/home/fpp/media/backups/${FOLDER}`;
const EEPROM = '/home/fpp/media/config/cape-eeprom.bin';
const EEPROM_KEEP = '/tmp/fpp-tests-cape-eeprom.keep';

// A restore marks the player for a reboot and a boot-time apply; put that back.
const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; /^pluginReinstallNeededAfterOS\\s*=/d; ` +
  `s/^rebootFlag\\s*=.*/rebootFlag = "0"/' /home/fpp/media/settings`;

test.beforeEach(() => {
  const real = inPlayer('sh', '-c', `test -e ${RSYNC} && ! grep -q ${MARK} ${RSYNC} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${RSYNC} is a real program in the player; not replacing it`);
  putFile(RSYNC, `#!/bin/sh\n# ${MARK}\necho "rsync $*" >> ${LOG}\nexit 0\n`);
  inPlayer('sh', '-c', `chmod 755 ${RSYNC} && : > ${LOG} && chmod 666 ${LOG} && mkdir -p ${SOURCE}/playlists ` +
    `&& rm -f ${EEPROM_KEEP} && if [ -e ${EEPROM} ]; then cp -a ${EEPROM} ${EEPROM_KEEP}; fi`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `grep -q ${MARK} ${RSYNC} 2>/dev/null && rm -f ${RSYNC}; rm -rf ${LOG} ${SOURCE}; ` +
    `if [ -e ${EEPROM_KEEP} ]; then mv -f ${EEPROM_KEEP} ${EEPROM}; else rm -f ${EEPROM}; fi; ` +
    `rm -rf /home/fpp/media/tmp/backups; ${CLEAR}; true`);
});

test('a File Copy whose every item copied ends by saying the backup is complete', async ({ request }) => {
  // Regression: 2405cb5c5 ("Add message to indicate the backup process is
  // complete").  The copy's output just stopped after the last rsync, so
  // whoever watched it could not tell whether it had finished.
  const r = await request.get(`/copystorage.php?direction=FROMLOCAL&storageLocation=x&path=${FOLDER}` +
    '&flags=Playlists&delete=no&compress=no', { timeout: 90_000 });
  const body = await r.text();
  // The control: the copy ran its rsync, which succeeded.
  expect(inPlayer('cat', LOG)).toMatch(new RegExp(`^rsync .*/backups/${FOLDER}/playlists /home/fpp/media$`, 'm'));
  expect(body).toContain('BACKUP COMPLETE');
  expect(body).toContain('All selected items have been successfully copied.');
  expect(body).toContain('Safe to remove storage device if applicable.');
  expect(body).not.toContain('BACKUP FAILED');
});

const copyEeprom = async (request: any, direction: string) => (await request.get(`/copystorage.php?direction=${direction}` +
  `&storageLocation=127.0.0.1&path=${FOLDER}&flags=EEPROM&delete=no&compress=no&remoteStorage=none`,
{ timeout: 90_000 })).text();
const eepromCalls = () => inPlayer('cat', LOG).split('\n').filter((l) => l.includes('cape-eeprom.bin'));

test('a Backup to Remote sends the cape EEPROM to the other player with rsync', async ({ request }) => {
  // Regression: cf08d1cd9 (#2219).  The EEPROM was copied with cp whatever
  // the direction, so a Backup to Remote ran cp onto "<host>::media/...",
  // which is no path on this player, and the file never reached the other
  // player.
  inPlayer('sh', '-c', `mkdir -p /home/fpp/media/config && printf 'fpp-tests eeprom' > ${EEPROM}`);
  const out = await copyEeprom(request, 'TOREMOTE');
  expect(out).not.toContain('cannot create');
  const calls = eepromCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(new RegExp(`^rsync -av .* -- /home/fpp/media/config/cape-eeprom\\.bin ` +
    `127\\.0\\.0\\.1::media/backups/${FOLDER}/config/?$`));
});

test('a Restore From Remote fetches the cape EEPROM from the other player with rsync', async ({ request }) => {
  // Regression: f2d8517ff.  cf08d1cd9 (#2219) meant this direction too, but
  // the copy script first checked `[ -f "$SOURCE/config/cape-eeprom.bin" ]`,
  // and for FROMREMOTE $SOURCE is "<host>::media/backups/<folder>", no path
  // on this player, so it always said "does not exist, nothing to copy" and
  // never ran the rsync.
  const out = await copyEeprom(request, 'FROMREMOTE');
  expect(out).not.toContain('cape-eeprom.bin does not exist, nothing to copy');
  const calls = eepromCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(new RegExp(`^rsync -av .* -- 127\\.0\\.0\\.1::media/backups/${FOLDER}/config/cape-eeprom\\.bin ` +
    `/home/fpp/media/config/?$`));
});
