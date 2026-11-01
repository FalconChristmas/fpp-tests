import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { FakeGitHub, release } from './standin-http';

// "Show All Platforms" on the About page's OS upgrade card (Advanced and up):
// the select lists every platform's image, not only this player's, and asks
// GET /api/git/releases/os/all for them.  GitHub's release list is answered
// by a stand-in in the player (standin-http.ts), and the player is made a
// 64-bit Raspberry Pi by its /etc/fpp/platform.

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const RELEASES = '/repos/FalconChristmas/fpp/releases';
const PLATFORM = '/etc/fpp/platform';
const IMAGES = ['Pi64-10.5.fppos', 'BBB-10.5.fppos', 'BB64-10.5.fppos'];

let gh: FakeGitHub;
let uiLevel = '0';

test.beforeEach(async ({ request }) => {
  inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
  gh = new FakeGitHub();
  gh.start();
  gh.routes({ [RELEASES]: { json: [release('10.5', IMAGES)] } });
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  gh?.stop();
  inPlayer('rm', '-f', PLATFORM);
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

test('Show All Platforms lists the other platforms\' images as well as this one\'s', async ({ page, request, baseURL }) => {
  // Feature: be7d4e363 (#1097).  FPPOS downloads for all platforms in the
  // advanced mode: the checkbox makes the page ask api/git/releases/os/all,
  // which does not filter the images by the player's platform.
  const names = async (path: string) => {
    const r = await request.get(path, { timeout: 60_000 });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).files.map((f: any) => f.filename).sort();
  };
  // The control: without "all", this player's images only.
  expect(await names('/api/git/releases/os')).toEqual(['Pi64-10.5.fppos']);
  expect(await names('/api/git/releases/os/all')).toEqual([...IMAGES].sort());

  // The page: the checkbox adds the other platforms' images to the select.
  const origin = new URL(baseURL!).origin;
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  const asked: string[] = [];
  page.on('request', (r) => { if (/api\/git\/releases\/os/.test(r.url())) asked.push(new URL(r.url()).pathname); });
  const offered = () => page.locator('#osSelect option').evaluateAll((os) =>
    os.map((o) => o.textContent!.trim().replace(/ .*/, '')).filter((t) => /\.fppos/.test(t)).sort());
  await page.goto('/about.php');
  await expect.poll(offered, { timeout: 30_000 }).toEqual(['Pi64-10.5.fppos']);
  await page.locator('#allPlatforms').check();
  await expect.poll(offered, { timeout: 30_000 }).toEqual([...IMAGES].sort());
  expect(asked.some((p) => p.endsWith('/releases/os/all')), `asked ${asked}`).toBe(true);
  // Unticked, back to this player's own.
  await page.locator('#allPlatforms').uncheck();
  await expect.poll(offered, { timeout: 30_000 }).toEqual(['Pi64-10.5.fppos']);
});
