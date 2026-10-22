import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

test.skip(!container, 'changes files inside the run-web.sh container');

test('a media directory that is not there is reported as missing, not as a full disk', async ({ request }) => {
  // Regression: 8866f16bd.  disk_free_space() on a missing path warns and
  // returns false, and false < 50000000, so the page printed a PHP warning
  // and then said the media directory was running low on space.  (php-fpm
  // runs as root in the container, so the unwritable case cannot be made.)
  const ROOT = '/opt/fpp/www/media_root.txt';
  const saved = inPlayer('cat', ROOT);
  // Under /proc, so config.php's mkdir cannot create it.
  inPlayer('sh', '-c', `printf '%s' /proc/fpp-tests-missing/media > ${ROOT}`);
  let body = '';
  try {
    body = await (await request.get('/initialSetup.php')).text();
  } finally {
    inPlayer('sh', '-c', `printf '%s' '${saved}' > ${ROOT}`);
  }
  expect(body).toContain('/proc/fpp-tests-missing/media does not');
  expect(body).not.toContain('running low on space');
  expect(body).not.toMatch(/Warning<\/b>:|PHP Warning|disk_free_space/);
  // And the player is back on its own media directory.
  expect(await (await request.get('/index.php')).text()).not.toContain('fpp-tests-missing');
});

test('the kiosk opens the configured URL and turns the DPI output off', async ({ request }) => {
  // Feature: 817897172 (the kiosk makes the first connected non-DPI output
  // primary).  Regression: 1d04161f3 (#2867).  start_kiosk.sh launched chromium on a
  // hardcoded http://localhost/, which overrides the KioskUrl that fppinit
  // writes into chromium's policy; and it left the pixel DPI connector
  // enabled, so X sized its screen to it and the panel showed a corner.
  // X, xrandr and chromium are stubs that record how they were called.
  const STUBS = '/tmp/fpp-tests-kiosk/bin';
  const HOME = '/tmp/fpp-tests-kiosk/home';
  const LOG = '/tmp/fpp-tests-kiosk/calls.log';
  inPlayer('sh', '-c', `rm -rf /tmp/fpp-tests-kiosk && mkdir -p ${STUBS} "${HOME}/.config/chromium/Default" &&
    echo '{"exited_cleanly":false}' > "${HOME}/.config/chromium/Local State" &&
    echo '{"exited_cleanly":false,"exit_type":"Crashed"}' > "${HOME}/.config/chromium/Default/Preferences" &&
    for c in xset setxkbmap; do printf '#!/bin/sh\\nexit 0\\n' > ${STUBS}/$c; done &&
    printf '#!/bin/sh\\nif [ $# -eq 0 ]; then printf "%%s\\\\n" "Screen 0: minimum 8 x 8" "HDMI-A-1 connected 1280x720+0+0" "DPI-1 connected 1920x997+0+0" "HDMI-A-2 disconnected"; else echo "xrandr $*" >> ${LOG}; fi\\n' > ${STUBS}/xrandr &&
    printf '#!/bin/sh\\necho "chromium $*" >> ${LOG}\\n' > ${STUBS}/chromium &&
    chmod +x ${STUBS}/*`);
  const url = 'http://fpp-tests.invalid/kiosk.php?x=1';
  expect((await request.put('/api/settings/KioskUrl', { data: url })).ok()).toBe(true);
  try {
    inPlayer('env', `PATH=${STUBS}:/usr/sbin:/usr/bin:/sbin:/bin`, `HOME=${HOME}`, 'bash', '/opt/fpp/scripts/start_kiosk.sh');
    const calls = inPlayer('cat', LOG).trim().split('\n');
    expect.soft(calls).toContain(`chromium --disable-infobars --kiosk ${url}`);
    // One xrandr call: the panel primary and the DPI connector off together.
    expect.soft(calls.filter((c) => c.startsWith('xrandr'))).toEqual(['xrandr --output HDMI-A-1 --auto --primary --output DPI-1 --off']);
  } finally {
    await request.put('/api/settings/KioskUrl', { data: '' });
    inPlayer('rm', '-rf', '/tmp/fpp-tests-kiosk');
  }
});
