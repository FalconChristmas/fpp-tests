import { test, expect } from './fixtures';
import http from 'http';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// The rest of the streamed pages (long-operations-finish.spec.ts has the update
// pages, Reset Config, packages and Rebuild): each runs a command and prints its
// output as it goes, and without ignore_user_abort() PHP stopped at the first
// line it printed after the browser went away, so whatever the page does after
// the command was never done.  Each test starts the page, hangs up as soon as
// it answers, and checks later that the page finished.
//
// The commands themselves are run through sudo, whose pty (Debian's
// "Defaults use_pty", as on FPP's images) carries them on to the end once PHP
// has gone, so only what the page does after a command can show the bug.  The
// pages that do nothing after their one command (growsd, newpartitionsd,
// formatstorage, installKiosk, runEventScript) are left out: their job finishes
// either way.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// Start a request and hang up once it has started answering.  POST, as the
// pages' own StreamURL() callers ask (the parameters in the query string).
function startAndHangUp(path: string, body = ''): Promise<string> {
  const base = test.info().project.use.baseURL!;
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method: 'POST', agent: false }, (res) => {
      res.once('data', (chunk: Buffer) => {
        req.destroy();
        resolve(chunk.toString());
      });
    });
    req.on('error', (e) => (req.destroyed ? undefined : reject(e)));
    req.setTimeout(60_000, () => req.destroy(new Error('the page never started answering')));
    req.end(body);
  });
}

// A stand-in for a command: prints for three seconds, long after the browser
// has gone, then leaves `done` behind to show it ran to its end.
function slowScript(done: string, extra = '') {
  return `#!/bin/sh
${extra}
rm -f ${done}
i=0
while [ $i -lt 30 ]; do echo "fpp-tests line $i"; sleep 0.1; i=$((i+1)); done
echo done > ${done}
`;
}

// Regression: 9ae5d5675 ("finish a streamed job when the browser disconnects,
// on the remaining pages").  upgradeCapeFirmware.php flags the reboot a new
// cape firmware needs after the flash: with the tab closed, the flash went
// through and the reboot was never asked for.
test('a cape firmware upgrade asks for its reboot after the browser goes', async () => {
  const SCRIPT = '/opt/fpp/scripts/upgradeCapeFirmware';
  const DONE = '/tmp/fpp-tests-capefw.done';
  const FIRMWARE = `${MEDIA}/upload/fpp-tests-firmware.bin`;
  const restore = snapshotSettings();
  inPlayer('cp', '-p', SCRIPT, `${SCRIPT}.fpp-tests-orig`);
  try {
    setSettingInFile('rebootFlag', '0');
    putFile(SCRIPT, slowScript(DONE));
    putFile(FIRMWARE, 'fpp-tests firmware');
    const first = await startAndHangUp('/upgradeCapeFirmware.php?filename=fpp-tests-firmware.bin');
    expect(first).toContain('Upgrading firmware');
    // The control: the flash itself ran to its end.
    await expect.poll(() => exists(DONE), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => settingInFile('rebootFlag'), { timeout: 10_000, message: 'the reboot was never asked for' }).toBe('1');
  } finally {
    inPlayer('mv', '-f', `${SCRIPT}.fpp-tests-orig`, SCRIPT);
    inPlayer('rm', '-f', DONE, FIRMWARE);
    restore();
  }
});

// Regression: 9ae5d5675.  disableKiosk.php runs three commands in turn; with
// the tab closed during the first, the other two (which drop the autologin and
// the kiosk flag) never ran, and the kiosk came back on the next boot.  The
// first command, a sed on .bashrc, is the slow one here: a stand-in sed takes
// that call and hands every other on to the real sed.
test('Disable Kiosk runs all its steps after the browser goes', async () => {
  const SED = '/usr/local/bin/sed';
  const DONE = '/tmp/fpp-tests-kiosk-sed.done';
  const KIOSK = '/etc/fpp/kiosk';
  const hadKiosk = exists(KIOSK);
  putFile(SED, slowScript(DONE, 'case "$*" in *.bashrc*) ;; *) exec /usr/bin/sed "$@" ;; esac'));
  inPlayer('chmod', '755', SED);
  inPlayer('touch', KIOSK);
  try {
    const first = await startAndHangUp('/disableKiosk.php');
    expect(first).toContain('====');
    await expect.poll(() => exists(DONE), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => exists(KIOSK), { timeout: 10_000, message: 'the kiosk flag was left behind' }).toBe(false);
  } finally {
    inPlayer('rm', '-f', SED, DONE);
    if (hadKiosk) inPlayer('touch', KIOSK); else inPlayer('rm', '-f', KIOSK);
  }
});
