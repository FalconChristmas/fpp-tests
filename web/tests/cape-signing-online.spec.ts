import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile, readFile } from './settings-file';
import { FakeHttps } from './fake-https';

// Signing a cape online (POST /api/cape/eeprom/sign/:key/:order, the Cape
// Info page's Sign): the EEPROM's data goes to the signing service with the
// key and order, and the signed EEPROM it answers with is written to the cape
// (the old one backed up first) -- or, if the service can't be reached or
// refuses, what went wrong is said and the EEPROM is left alone.
// api.FalconPlayer.com is an HTTPS stand-in; the EEPROM is the virtual one
// (config/cape-eeprom.bin).  cape-signing-eeprom-data.spec.ts has the offline
// signing packet.

test.skip(!container, 'stands in for the signing service inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const BIN = `${MEDIA}/config/cape-eeprom.bin`;
const LOC = `${MEDIA}/tmp/eeprom_location.txt`;
const DETECT = '/opt/fpp/scripts/detect_cape';
const MARK = '/tmp/fpp-tests-detect-cape-ran';
const SIGN = '/api/fpp/eeprom/sign';
const pad = (n: number, w = 6) => String(n).padStart(w, '0');
const HEADER = 'h'.repeat(58);
const UNSIGNED = HEADER + pad(10) + '01' + 'n'.repeat(64) + 'd'.repeat(10) + pad(0);
const SIGNED = HEADER + pad(10) + '01' + 'n'.repeat(64) + 'd'.repeat(10) + pad(4) + '99' + 'S'.repeat(64) + 'sign' + pad(0);

let fake: FakeHttps;
let detect = '';
test.beforeAll(() => {
  fake = new FakeHttps(['api.FalconPlayer.com', 'api.falconplayer.com']);
  fake.start();
});
test.afterAll(() => fake.stop());
test.beforeEach(() => {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/config ${MEDIA}/tmp ${MEDIA}/upload && rm -f ${LOC} ${MARK} ${MEDIA}/upload/cape-eeprom-Backup-* ${MEDIA}/upload/cape-eeprom-Signed-*`);
  detect = readFile(DETECT);
  putFile(DETECT, `#!/bin/sh\necho ran > ${MARK}\n`);
  inPlayer('chmod', '755', DETECT);
  putFile(BIN, UNSIGNED);
  fake.clearLog();
});
test.afterEach(() => {
  inPlayer('sh', '-c', `rm -f ${BIN} ${LOC} ${MARK} ${MEDIA}/upload/cape-eeprom-Backup-* ${MEDIA}/upload/cape-eeprom-Signed-*`);
  putFile(DETECT, detect);
  inPlayer('chmod', '755', DETECT);
});

async function sign(request: any) {
  const r = await request.post('/api/cape/eeprom/sign/FPP-TESTS-KEY/12345', { timeout: 60_000 });
  return r.json();
}
const eeprom = () => inPlayer('cat', BIN);
const backups = () => inPlayer('sh', '-c', `ls ${MEDIA}/upload/ | grep cape-eeprom- || true`).trim();
const detected = () => inPlayer('sh', '-c', `cat ${MARK} 2>/dev/null || true`).trim();

test("the cape's EEPROM goes to the signing service with the key and order, and what it signs is written to the cape", async ({ request }) => {
  fake.routes({ [SIGN]: { json: { Status: 'OK', eeprom: Buffer.from(SIGNED).toString('base64') } } });
  expect(await sign(request)).toEqual({ Status: 'OK', Message: 'EEPROM Signed.' });

  const [asked] = fake.requests().filter((q) => q.path === SIGN);
  expect(asked.method).toBe('POST');
  const sent = JSON.parse(asked.body);
  expect(sent).toMatchObject({ key: 'FPP-TESTS-KEY' });
  expect(JSON.stringify(sent)).toContain('12345');
  expect(Buffer.from(sent.eeprom, 'base64').toString()).toBe(UNSIGNED);

  expect(eeprom()).toBe(SIGNED);
  // The old one is kept, and the written copy is not left behind.
  expect(backups()).toMatch(/^cape-eeprom-Backup-\d{8}-\d{6}\.bin$/);
  expect(inPlayer('sh', '-c', `cat ${MEDIA}/upload/cape-eeprom-Backup-*.bin`)).toBe(UNSIGNED);
  expect(detected()).toBe('ran');
});

test("the signing service's refusal is passed on, and the EEPROM is left alone", async ({ request }) => {
  fake.routes({ [SIGN]: { json: { Status: 'ERROR', Message: 'fpp-tests: key already used for another cape' } } });
  expect(await sign(request)).toEqual({ Status: 'ERROR', Message: 'fpp-tests: key already used for another cape' });
  expect(eeprom()).toBe(UNSIGNED);
  expect(backups()).toBe('');
  expect(detected()).toBe('');
});

test("a signing service that answers with an error, or can't be reached, is said so, and the EEPROM is left alone", async ({ request }) => {
  fake.routes({ [SIGN]: { status: 502, body: 'Bad Gateway' } });
  expect(await sign(request)).toEqual({ Status: 'ERROR', Message: 'Could not contact signing website https://api.FalconPlayer.com.  RC: 502' });
  fake.down();
  try {
    expect(await sign(request)).toEqual({ Status: 'ERROR', Message: 'Could not contact signing website https://api.FalconPlayer.com.  RC: 0' });
  } finally {
    fake.start();
  }
  expect(eeprom()).toBe(UNSIGNED);
  expect(backups()).toBe('');
});

test('an EEPROM that cannot be read is not sent to be signed', async ({ request }) => {
  putFile(BIN, 'short');
  expect(await sign(request)).toMatchObject({ Status: 'ERROR', Message: 'Invalid EEPROM, length too short.' });
  expect(fake.requests().filter((q) => q.path === SIGN)).toEqual([]);
});

// A reply that says OK but carries no EEPROM (a service fault, a proxy's
// page) is written to the cape as it is: nothing.  dd truncates the virtual
// EEPROM to empty, and the cape comes up as no cape (its strings, panels and
// settings gone) until the backup is put back by hand.  In FUTURE.md.
for (const [what, reply] of [
  ['no EEPROM', { Status: 'OK' }],
  ['an EEPROM that is not base64', { Status: 'OK', eeprom: '%%%' }],
] as const) {
  test(`a "signed" reply with ${what} does not overwrite the cape's EEPROM`, async ({ request }) => {
    fake.routes({ [SIGN]: { json: reply } });
    const got = await sign(request);
    // The control: the reply was taken for a signature.
    expect(backups()).toMatch(/cape-eeprom-Backup-/);
    test.fail(true, 'an empty signed EEPROM is written over the cape (FUTURE.md)');
    expect(eeprom()).toBe(UNSIGNED);
    expect(got.Status).toBe('ERROR');
  });
}
