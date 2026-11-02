import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// What the cape signing endpoints do with the EEPROM: GET signingData sends
// the signing service only the EEPROM's real data, and POST signingData
// writes a signed EEPROM back (the virtual EEPROM, config/cape-eeprom.bin),
// keeping a backup of the old one and having the cape detected again.
// (The virtual EEPROM being found at all is cape-signing-virtual-eeprom.spec.ts.)

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const BIN = `${MEDIA}/config/cape-eeprom.bin`;
const LOC = `${MEDIA}/tmp/eeprom_location.txt`;
const DETECT = '/opt/fpp/scripts/detect_cape';
const MARK = '/tmp/fpp-tests-detect-cape-ran';
const pad = (n: number, w = 6) => String(n).padStart(w, '0');
// 58 bytes of header, then sections: a 6 digit length, a 2 digit flag (under
// 50 there is also a 64 byte name), and the data.  A zero length ends them.
const HEADER = 'h'.repeat(58);
const SECTION = pad(10) + '01' + 'n'.repeat(64) + 'd'.repeat(10);
const REAL = HEADER + SECTION + pad(0);
const JUNK = 'z'.repeat(500);

let detect = '';
test.beforeEach(() => {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/config ${MEDIA}/tmp ${MEDIA}/upload && rm -f ${LOC} ${MARK} ${MEDIA}/upload/cape-eeprom-Backup-*`);
  detect = inPlayer('sh', '-c', `cat ${DETECT}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `rm -f ${BIN} ${LOC} ${MARK} ${MEDIA}/upload/cape-eeprom-Backup-*`);
  putFile(DETECT, detect);
  inPlayer('chmod', '755', DETECT);
});

test('only the EEPROM\'s own data goes to the signing service, not the rest of the chip', async ({ request }) => {
  // Regression: d742f009e ("Signing updates": "Parse the EEPROM data to
  // determine length so we only send what is necessary").  The whole 32K was
  // sent, the unused part of the chip with it.
  putFile(BIN, REAL + JUNK);
  const r = await request.get('/api/cape/eeprom/signingData/FPP-TESTS-KEY/12345');
  const body = await r.json();
  expect(body, JSON.stringify(body)).not.toHaveProperty('Status');
  const sent = Buffer.from(body.eeprom, 'base64').toString();
  expect(sent.length).toBe(REAL.length);
  expect(sent).toBe(REAL);
});

test('an EEPROM too short to hold a header is refused', async ({ request }) => {
  // Regression: d742f009e.  Parsing the sections of a file with no header
  // read past the end of it.
  putFile(BIN, 'short');
  const body = await (await request.get('/api/cape/eeprom/signingData/FPP-TESTS-KEY/12345')).json();
  expect(body).toMatchObject({ Status: 'ERROR', Message: 'Invalid EEPROM, length too short.' });
});

test('a signed EEPROM is written back, the old one backed up, and the cape detected again', async ({ request }) => {
  // Regression: d742f009e.  The backup of the old EEPROM is kept (and given
  // to the web user, which the container's root-run web server can't show) and
  // "use detect_cape wrapper" picks up the new EEPROM.
  putFile(BIN, REAL);
  putFile(DETECT, `#!/bin/sh\necho ran > ${MARK}\n`);
  inPlayer('chmod', '755', DETECT);
  const signed = HEADER + pad(0);
  const r = await request.post('/api/cape/eeprom/signingData', {
    data: { key: 'FPP-TESTS-KEY', orderID: '12345', eeprom: Buffer.from(signed).toString('base64') },
  });
  expect(await r.json()).toMatchObject({ Status: 'OK', Message: 'EEPROM Signed.' });
  // The receiving end: the EEPROM now holds what the signing service sent.
  expect(inPlayer('sh', '-c', `head -c ${signed.length} ${BIN}`)).toBe(signed);
  const backup = inPlayer('sh', '-c', `ls ${MEDIA}/upload/cape-eeprom-Backup-*.bin`).trim();
  expect(backup).toMatch(/cape-eeprom-Backup-\d{8}-\d{6}\.bin$/);
  expect(inPlayer('sh', '-c', `head -c ${REAL.length} ${backup}`)).toBe(REAL);
  expect(inPlayer('sh', '-c', `cat ${MARK} 2>/dev/null || true`).trim(), 'detect_cape was run').toBe('ran');
});
