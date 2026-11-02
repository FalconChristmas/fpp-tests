import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// GET /api/cape/eeprom/signingData/:key/:order reads the cape's EEPROM to hand
// to the signing service.  A cape on a board with no EEPROM chip of its own
// (or one the kernel has not bound) is signed through the virtual EEPROM,
// config/cape-eeprom.bin.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const BIN = `${MEDIA}/config/cape-eeprom.bin`;
const LOC = `${MEDIA}/tmp/eeprom_location.txt`;
// 58 bytes of header and a zero-length first section: all the signing data
// reader needs to see.
const HEADER = 'x'.repeat(58) + '000000';

test.beforeEach(() => {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/config ${MEDIA}/tmp && rm -f ${BIN} ${LOC} && printf %s '${HEADER}' > ${BIN}`);
});
test.afterEach(() => {
  inPlayer('rm', '-f', BIN, LOC);
});

test('a virtual EEPROM signs when the recorded EEPROM location is not there', async ({ request }) => {
  // Regression: b0cdea9d6.  Boot records the EEPROM it expected in
  // tmp/eeprom_location.txt; when that device is absent the virtual EEPROM
  // file was only looked at if the location file did not exist at all, so a
  // virtual EEPROM was never found and signing said "Could not locate EEPROM".
  inPlayer('sh', '-c', `printf /sys/bus/i2c/devices/1-0050/eeprom > ${LOC}`);
  const r = await request.get('/api/cape/eeprom/signingData/FPP-TESTS-KEY/12345');
  expect(r.ok(), await r.text()).toBe(true);
  const body = await r.json();
  expect(body, JSON.stringify(body)).not.toHaveProperty('Status');
  // The receiving end of the signing service gets the file's own bytes.
  expect(Buffer.from(body.eeprom, 'base64').toString()).toBe(HEADER);
  expect(body).toMatchObject({ key: 'FPP-TESTS-KEY', orderID: '12345' });
});

test('with no recorded location the virtual EEPROM signs too', async ({ request }) => {
  // The control: the case that already worked.
  const r = await request.get('/api/cape/eeprom/signingData/FPP-TESTS-KEY/12345');
  const body = await r.json();
  expect(Buffer.from(body.eeprom ?? '', 'base64').toString(), JSON.stringify(body)).toBe(HEADER);
});
