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
  // Also bfd950bcb: downloadOnly fetches the image and skips the apply.
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

test('a Download Only is an os-download run of its own, and leaves an old open OS upgrade alone', async ({ request }) => {
  // Regression: c875daaec (#3187).  A Download Only logged its lines as
  // "[os-upgrade <image>]" with no START, under whatever os-upgrade run the
  // log had opened last: an old run whose closing lines were lost read as
  // an OS upgrade in progress for 15 minutes, and Upgrade OS was hidden.
  const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';
  const OLD = 'Pi64-fpp-tests-old_2099-01.fppos';
  const then = new Date(Date.now() - 7200_000).toISOString().replace('T', ' ').slice(0, 19);
  inPlayer('sh', '-c', `mkdir -p /home/fpp/media/logs && printf '%s' "$1" > ${LOG} && touch -d '-2 hours' ${LOG}`, 'sh',
    `${then} [os-upgrade ${OLD}] ===== os-upgrade START: ${OLD} =====\n${then} [os-upgrade ${OLD}] ===== Applying OS image =====\n`);
  const activity = async () => (await request.get('/api/system/updateActivity')).json();
  try {
    expect(await activity(), 'the control: the old run is stale').toMatchObject({ op: 'os-upgrade', stale: true, inProgress: false });
    const out = await (await request.get(url(IMAGE), { timeout: 120_000 })).text();
    expect(out).toContain('Download complete...');
    const log = inPlayer('cat', LOG);
    expect(log).toContain(`[os-download ${IMAGE}] ===== os-download START: ${IMAGE} =====`);
    expect(log).toContain(`[os-download ${IMAGE}] ===== os-download FINISH: ${IMAGE} (rc=0) =====`);
    expect(log, 'the download logged as an OS upgrade').not.toContain(`[os-upgrade ${IMAGE}]`);
    const a = await activity();
    expect(a, JSON.stringify(a)).toMatchObject({ inProgress: false, op: 'os-download', target: IMAGE, kind: 'FPP OS Download', failed: false, stale: false });
  } finally {
    inPlayer('rm', '-f', LOG);
  }
});
