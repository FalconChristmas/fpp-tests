import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';

// The cape EEPROM upgrade page can be given a firmware URL: it downloads the
// file with wget, then hands it to scripts/upgradeCapeFirmware to be flashed.
// wget and that script are stand-ins here (the real one needs a cape); the
// page, the download-size check and the decision to flash are the real ones.

test.skip(!container, 'stands in for wget and the upgrade script inside the run-web.sh container');

const WGET = '/usr/bin/wget';
const SCRIPT = '/opt/fpp/scripts/upgradeCapeFirmware';
const ARGS = '/tmp/fpp-tests-ucf-args';
// A public address, so the page's check of the URL lets it through to wget.
const URL = 'http://8.8.8.8/fpp-tests-firmware.bin';

let restoreSettings: () => void = () => {};
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  inPlayer('sh', '-c', `cp -p ${SCRIPT} ${SCRIPT}.fpp-tests && cp -p ${WGET} ${WGET}.fpp-tests && ` +
    `printf '#!/bin/sh\\necho "$*" > ${ARGS}\\necho stand-in upgrade done\\n' > ${SCRIPT} && chmod 755 ${SCRIPT} && rm -f ${ARGS}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `mv ${SCRIPT}.fpp-tests ${SCRIPT}; mv ${WGET}.fpp-tests ${WGET}; rm -f ${ARGS} /home/fpp/media/tmp/tmp-eeprom.bin`);
  restoreSettings();
});

// wget that "downloads" `bytes` bytes to its -O file, or fails with nothing
// written when bytes is 0.
function stubWget(bytes: number) {
  inPlayer('sh', '-c', `printf '%s\\n' '#!/bin/sh' 'out=; while [ $# -gt 0 ]; do [ "$1" = "-O" ] && out=$2; shift; done' ` +
    `'echo "wget stand-in: ${bytes} bytes"' ${bytes > 0 ? `'head -c ${bytes} /dev/zero > "$out"'` : `'echo "wget: unable to resolve host address" >&2; exit 4'`} ` +
    `> ${WGET} && chmod 755 ${WGET}`);
}

async function upgradeFromUrl(request: import('@playwright/test').APIRequestContext) {
  const r = await request.get('/upgradeCapeFirmware.php?filename=' + encodeURIComponent(URL), { timeout: 90_000 });
  return r.text();
}

test('a firmware download that fails or comes up short is reported and not flashed', async ({ request }) => {
  // Regression: e9b2955c9.  The downloaded file went to the flash script
  // whatever wget left behind (an empty or error-page file), and the page
  // said nothing about the download failing.
  stubWget(10);
  const short = await upgradeFromUrl(request);
  expect(short, 'the page\'s output').toContain('Problems downloading firmware');
  expect(short, 'wget\'s own messages are shown').toContain('wget stand-in: 10 bytes');
  expect(inPlayer('sh', '-c', `cat ${ARGS} 2>/dev/null || true`).trim(), 'a 10-byte file was handed to the flash script').toBe('');

  stubWget(0);
  const none = await upgradeFromUrl(request);
  expect(none).toContain('Problems downloading firmware');
  expect(none).toContain('unable to resolve host address');
  expect(inPlayer('sh', '-c', `cat ${ARGS} 2>/dev/null || true`).trim(), 'nothing was downloaded, yet the flash script ran').toBe('');
});

test('a firmware download of a plausible size is flashed', async ({ request }) => {
  // The control for the test above: with the same stand-ins, a download big
  // enough to be an EEPROM image reaches the flash script and draws no
  // download complaint.
  stubWget(128);
  const body = await upgradeFromUrl(request);
  expect(body).not.toContain('Problems downloading firmware');
  expect(body).toContain('stand-in upgrade done');
  expect(inPlayer('cat', ARGS).trim()).toContain('tmp-eeprom.bin');
});
