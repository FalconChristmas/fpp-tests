import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { FakeHttps } from './fake-https';

// upgradeOS.php fetches the FPPOS image with wget from the URL it is given,
// resuming and retrying, before it applies anything.  These runs are all
// download-only (?downloadOnly=1), so nothing is applied and nothing reboots;
// the image is served by an HTTPS stand-in the player trusts.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const HOST = 'fpp-tests-os.example';
const UPLOAD = '/home/fpp/media/upload';
const IMAGE = 'fpp-tests-image.fppos';
const BODY = Buffer.from('FPPOS-IMAGE-' + 'x'.repeat(5000));

let fake: FakeHttps;
test.beforeAll(() => {
  fake = new FakeHttps([HOST], { [`/os/${IMAGE}`]: { b64: BODY.toString('base64') } });
  fake.start();
});
test.afterAll(() => {
  fake.stop();
});
test.afterEach(() => {
  inPlayer('sh', '-c', `rm -f ${UPLOAD}/${IMAGE}`);
});

const url = (name: string) => `/upgradeOS.php?os=${encodeURIComponent(`https://${HOST}/os/${name}`)}&downloadOnly=1&wrapped=1`;

test('the image is fetched with wget, over HTTPS, into the uploads directory, and nothing is applied', async ({ request }) => {
  // Feature: de882850e (wget, not PHP's curl, whose OpenSSL was slow on
  // FPP 8.x) and 0fd1be6da.  Also 6a4200b3b: a download-only run that
  // succeeded ended with "FPP UPGRADE FAILED", as nothing was applied.
  const r = await request.get(url(IMAGE), { timeout: 120_000 });
  const out = await r.text();
  expect(out).toContain('Running command: sudo wget -c');
  expect(out).toContain(`https://${HOST}/os/${IMAGE}`);
  expect(out).toContain('Download complete...');
  expect(out).not.toContain('Applying OS image');
  expect(out).not.toContain('FPP UPGRADE FAILED');
  expect(inPlayer('sh', '-c', `wc -c < ${UPLOAD}/${IMAGE}`).trim()).toBe(String(BODY.length));
  expect(fake.requests().filter((q) => q.path === `/os/${IMAGE}`).length).toBeGreaterThan(0);
});

test('a download that keeps failing is tried 20 times, then given up', async ({ request }) => {
  // Feature: c04bf3640 ("20 retries should be more than enough").
  const r = await request.get(url('fpp-tests-missing.fppos'), { timeout: 170_000 });
  const out = await r.text();
  expect((out.match(/Running command: sudo wget/g) || []).length).toBe(20);
  expect(out).toContain('Download aborted!');
  expect(out).toContain('Skipping update');
  expect(out).not.toContain('Download complete');
});
