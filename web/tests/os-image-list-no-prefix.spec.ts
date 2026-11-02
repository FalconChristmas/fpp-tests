import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { FakeGitHub, release } from './standin-http';

// GET /api/git/releases/os on a player whose platform gives no OS image
// prefix (OSImagePrefix empty: no /etc/fpp/platform, so config.php picks none).

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const RELEASES = '/repos/FalconChristmas/fpp/releases';
const PLATFORM = '/etc/fpp/platform';
let gh: FakeGitHub;
let platform = '';

test.beforeEach(() => {
  platform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null; true`);
  inPlayer('rm', '-f', PLATFORM);
  gh = new FakeGitHub();
  gh.start();
});
test.afterEach(() => {
  gh?.stop();
  if (platform) inPlayer('sh', '-c', `printf '%s' "$1" > ${PLATFORM}`, 'sh', platform);
});

test('a player with no OS image prefix is offered no OS images', async ({ request }) => {
  // Regression: 94ed842fe (#1119).  With OSImagePrefix empty every .fppos
  // matched (the prefix test was startsWith "", true for any name), so a
  // player of unknown type was offered every platform's images.  The "all"
  // form lists every platform's images regardless, which is where an empty
  // prefix has to be refused outright.
  gh.routes({
    [RELEASES]: { json: [release('10.5', ['Pi64-10.5.fppos', 'BBB-10.5.fppos', 'BB64-10.5.fppos'])] },
  });
  for (const path of ['/api/git/releases/os', '/api/git/releases/os/all']) {
    const r = await request.get(path, { timeout: 60_000 });
    expect(r.ok(), await r.text()).toBe(true);
    const list = await r.json();
    // The control: GitHub was asked and answered, so an empty list is the prefix's doing.
    expect(gh.requests().map((q) => q.path), path).toContain(`${RELEASES}?per_page=100`);
    expect(list.files.map((f: any) => f.filename), path).toEqual([]);
  }
});
