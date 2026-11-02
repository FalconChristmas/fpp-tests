import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The cape EEPROM readers (signing data, backup) re-bind the kernel's EEPROM
// driver when the recorded EEPROM path has gone, through sudo and the i2c
// bus's new_device file.  A stand-in bash (sudo's secure_path finds
// /usr/local/bin first) logs what it was asked to run.

test.skip(!container, 'seeds files and a stand-in inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const LOC = `${MEDIA}/tmp/eeprom_location.txt`;
const BIN = `${MEDIA}/config/cape-eeprom.bin`;
const BASH = '/usr/local/bin/bash';
const MARK = 'fpp-tests-bash-stub';
const LOG = '/tmp/fpp-tests-bash.log';
const HEADER = 'x'.repeat(58) + '000000';

test.beforeEach(() => {
  const real = inPlayer('sh', '-c', `test -e ${BASH} && ! grep -q ${MARK} ${BASH} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${BASH} is a real program in the player; not replacing it`);
  putFile(BASH, `#!/bin/sh\n# ${MARK}\necho "$*" >> ${LOG}\nexit 0\n`);
  inPlayer('sh', '-c', `chmod 755 ${BASH} && : > ${LOG} && chmod 666 ${LOG}; mkdir -p ${MEDIA}/config ${MEDIA}/tmp && rm -f ${BIN} ${LOC} && printf %s '${HEADER}' > ${BIN}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `grep -q ${MARK} ${BASH} 2>/dev/null && rm -f ${BASH}; rm -f ${BIN} ${LOC} ${LOG}; true`);
});

test('signing re-mounts the EEPROM when the recorded device is missing', async ({ request }) => {
  // Regression: 7396108d3.  A cape whose EEPROM driver had been unbound was
  // unreadable for signing and backup; the reader now asks the i2c bus to
  // create the 24c256 device at 0x50 again before it looks for the file.
  inPlayer('sh', '-c', `printf /sys/bus/i2c/devices/1-0050/eeprom > ${LOC}`);
  const r = await request.get('/api/cape/eeprom/signingData/FPP-TESTS-KEY/12345');
  expect(r.ok(), await r.text()).toBe(true);
  const log = inPlayer('cat', LOG);
  expect(log).toContain("echo '24c256 0x50' > /sys/bus/i2c/devices/i2c-");
  expect(log).toMatch(/\/sys\/bus\/i2c\/devices\/i2c-[12]\/new_device/);
  // And signing still falls back to the virtual EEPROM afterwards.
  const body = await r.json();
  expect(Buffer.from(body.eeprom, 'base64').toString()).toBe(HEADER);
});

test('no re-mount is attempted when there is no recorded EEPROM device', async ({ request }) => {
  // The control: the stand-in only sees a call when the recorded path is a
  // missing i2c device.
  const r = await request.get('/api/cape/eeprom/signingData/FPP-TESTS-KEY/12345');
  expect(r.ok(), await r.text()).toBe(true);
  expect(inPlayer('cat', LOG)).not.toContain('new_device');
});
