import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { FakeHttps } from './fake-https';
import { setSettingInFile, snapshotSettings } from './settings-file';

// An OS image from GitHub, on a player whose Upgrade Source is another FPP on
// the LAN: upgradeOS.php tries that FPP's uploads first and falls back to
// GitHub if the mirror can't give it the image.  Download-only, so nothing is
// applied (see upgrade-os-download.spec.ts); github.com is an HTTPS stand-in.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const UPLOAD = '/home/fpp/media/upload';
const IMAGE = 'fpp-tests-mirror.fppos';
const BODY = Buffer.from('FPPOS-MIRROR-' + 'y'.repeat(3000));
const GITHUB = `https://github.com/FalconChristmas/fpp/releases/download/fpp-tests/${IMAGE}`;
// A mirror whose name does not resolve: it fails at once, every time.
const MIRROR = 'fpp-tests-mirror.invalid';

let fake: FakeHttps;
let restore: () => void = () => {};
test.beforeAll(() => {
  fake = new FakeHttps(['github.com'], { [`/FalconChristmas/fpp/releases/download/fpp-tests/${IMAGE}`]: { b64: BODY.toString('base64') } });
  fake.start();
});
test.afterAll(() => fake.stop());
test.beforeEach(() => {
  restore = snapshotSettings();
  setSettingInFile('UpgradeSource', MIRROR);
});
test.afterEach(() => {
  restore();
  inPlayer('rm', '-f', `${UPLOAD}/${IMAGE}`);
});

async function download(request: any) {
  const r = await request.get(`/upgradeOS.php?os=${encodeURIComponent(GITHUB)}&downloadOnly=1&wrapped=1`, { timeout: 170_000 });
  return r.text() as Promise<string>;
}

test('a GitHub image is asked of the mirror first, and fetched from GitHub when the mirror fails', async ({ request }) => {
  const out = await download(request);
  expect(out).toContain(`Downloading from local FPP mirror ${MIRROR}...`);
  expect(out).toContain(`http://${MIRROR}/api/file/uploads/${IMAGE}`);
  expect(out).toContain('Mirror download failed, falling back to GitHub...');
  expect(out).toContain('Download complete...');
  expect(inPlayer('sh', '-c', `cat ${UPLOAD}/${IMAGE}`)).toBe(BODY.toString());
});

test('an image from anywhere but GitHub is not asked of the mirror', async ({ request }) => {
  const r = await request.get(`/upgradeOS.php?os=${encodeURIComponent(`https://fpp-tests-nowhere.invalid/${IMAGE}`)}&downloadOnly=1&wrapped=1`, { timeout: 170_000 });
  const out = await r.text();
  expect(out).not.toContain(MIRROR);
});

// Each URL gets the full 20 tries meant for a flaky GitHub download, the
// mirror included: a mirror that is switched off (no answer, so each try
// waits out the connect timeout, about two minutes) holds the upgrade up for
// some forty minutes before GitHub is asked.  In FUTURE.md.
test('a mirror that fails is not tried 20 times before GitHub', async ({ request }) => {
  const out = await download(request);
  const mirrorTries = (out.split('Mirror download failed')[0].match(/Running command: sudo wget/g) || []).length;
  expect(mirrorTries).toBeGreaterThan(0);
  test.fail(true, 'the mirror gets the same 20 tries as GitHub (FUTURE.md)');
  expect(mirrorTries).toBeLessThan(20);
});
