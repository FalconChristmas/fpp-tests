import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { FakeGitHub, release } from './standin-http';

// GET /api/git/releases/sizes: "<image>,<bytes>" for each of GitHub's release
// images that suit this player.  SD/upgradeOS-part1.sh asks it, on 127.0.0.1,
// for the size of the image it is about to apply and refuses (and deletes) a
// download that is smaller.  GitHub's release list is answered by a stand-in in
// the player (standin-http.ts); the player is made a Pi by /etc/fpp/platform.

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const RELEASES = '/repos/FalconChristmas/fpp/releases';
const PLATFORM = '/etc/fpp/platform';

let gh: FakeGitHub;

test.beforeEach(() => {
  inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
  gh = new FakeGitHub();
  gh.start();
});

test.afterEach(() => {
  gh?.stop();
  inPlayer('rm', '-f', PLATFORM);
});

test('the sizes are the release images of this kind of player, one "name,bytes" line each', async ({ request }) => {
  // Regression: a5b1a6ae7 (#1400).  An FPPOS download cut short was applied
  // anyway; upgradeOS-part1.sh now compares its size with this list's.
  const r10 = release('10.5', ['Pi64-10.5.fppos', 'BBB-10.5.fppos']);
  r10.assets[0].size = 1234567890;
  const r9 = release('10.4', ['Pi64-10.4.fppos']);
  r9.assets[0].size = 987654321;
  gh.routes({ [RELEASES]: { json: [r10, r9] } });
  const r = await request.get('/api/git/releases/sizes', { timeout: 60_000 });
  expect(r.ok(), await r.text()).toBe(true);
  // The receiving end: part1 greps its image's name out of this and takes the
  // second comma-separated field, as here.
  const body = (await r.text()).split('\n').filter((l) => l);
  const size = (name: string) => body.filter((l) => l.includes(name)).map((l) => l.split(',')[1]);
  expect(size('Pi64-10.5.fppos')).toEqual(['1234567890']);
  expect(size('Pi64-10.4.fppos')).toEqual(['987654321']);
  // Another platform's image is not listed.
  expect(body.some((l) => l.startsWith('BBB-'))).toBe(false);
});
