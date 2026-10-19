import { test, expect } from './fixtures';
import type { Response } from '@playwright/test';

// FPP's own callers of the routes that change state send POST. Those routes
// answer GET until FPP 11, but every GET is marked deprecated: a
// "Deprecation: true" response header and a "Deprecated: GET ..." line in
// fppd.log (fpp c5a64f567). FPP's own UI and its PHP still used the GETs, so
// that log filled with FPP's own calls, and no POST form of most of them was
// registered for anyone to move to. Fixed in fpp 77efc7561
// ("fix(api): FPP's own callers change state by POST").
//
// The UI's actions are driven through the page functions behind their buttons,
// so whatever request each of them makes is what is checked. The PHP behind a
// route runs its fppd command through fppd's own HTTP port; a GET there shows
// up only in fppd.log, from 127.0.0.1.

const STATE_ROUTE =
  /\/api\/(command(\/|$)|playlists\/(stop|stopgracefully|stopgracefullyafterloop)$|sequence\/current\/(stop|togglePause)$|file\/move\/)/;

function watchStateRequests(page: import('@playwright/test').Page) {
  const seen: Response[] = [];
  page.on('response', (r) => {
    if (STATE_ROUTE.test(new URL(r.url()).pathname)) seen.push(r);
  });
  return seen;
}

function describe(r: Response) {
  return `${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}` +
    (r.headers()['deprecation'] ? ' (Deprecation)' : '');
}

async function selfCallDeprecations(request: import('@playwright/test').APIRequestContext) {
  const log = await request.get('/api/file/Logs/fppd.log');
  expect(log.ok()).toBe(true);
  return (await log.text())
    .split('\n')
    .filter((l) => /Deprecated: GET \S+ from (127\.0\.0\.1|::1)\b/.test(l));
}

test('the status page changes state by POST', async ({ page, request }) => {
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).StopNow === 'function');
  const seen = watchStateRequests(page);

  await page.evaluate(() => {
    const w = window as any;
    w.StopNow();
    w.StopGracefully();
    w.StopGracefullyAfterLoop();
    w.ToggleSequencePause();
    w.PreviousPlaylistEntry();
    w.NextPlaylistEntry();
    w.StartNextScheduledItemNow();
    w.ExtendSchedule(1);
    w.PlayPlaylist('fpp-tests-no-such-playlist');
    w.moveFile('fpp-tests-no-such-file');
  });
  await expect.poll(() => seen.length, { timeout: 30_000 }).toBe(10);

  expect(seen.map(describe).filter((d) => !d.startsWith('POST ') || d.includes('(Deprecation)'))).toEqual([]);
  expect(await selfCallDeprecations(request)).toEqual([]);
});

test('the testing page stops a sequence by POST', async ({ page, request }) => {
  await page.goto('/testing.php');
  await page.waitForFunction(() => typeof (window as any).StopSequence === 'function');
  const seen = watchStateRequests(page);

  await page.evaluate(() => (window as any).StopSequence());
  await expect.poll(() => seen.length, { timeout: 30_000 }).toBe(1);

  expect(seen.map(describe).filter((d) => !d.startsWith('POST ') || d.includes('(Deprecation)'))).toEqual([]);
  expect(await selfCallDeprecations(request)).toEqual([]);
});

test('the state-changing routes take POST', async ({ request }) => {
  // The control: the GET form still works and is marked, so a missing mark
  // below means the POST was taken as POST, not that marking is broken.
  const get = await request.get('/api/playlists/stop');
  expect(get.status()).toBe(200);
  expect(get.headers()['deprecation']).toBe('true');

  // Only the routes safe to run in the test player: nothing here reboots,
  // restarts fppd, resets the git tree or rewrites the network config.
  const routes = [
    '/api/playlists/stop',
    '/api/playlists/stopgracefully',
    '/api/playlists/stopgracefullyafterloop',
    '/api/playlists/pause',
    '/api/playlists/resume',
    '/api/playlist/repeat/false',
    '/api/playlist/fpp-tests-no-such-playlist/start',
    '/api/playlist/fpp-tests-no-such-playlist/start/false',
    '/api/playlist/fpp-tests-no-such-playlist/start/false/false',
    '/api/sequence/current/stop',
    '/api/sequence/current/togglePause',
    '/api/sequence/fpp-tests-no-such-sequence/start/0',
    '/api/file/move/fpp-tests-no-such-file',
    '/api/scripts/fpp-tests-no-such-script.sh/run',
    '/api/events/fpp-tests-no-such-event/trigger',
    '/api/remoteAction?ip=0.0.0.0&action=reboot',
    '/api/command/Extend%20Schedule',
  ];
  const wrong: string[] = [];
  for (const route of routes) {
    const r = await request.post(route, { data: route.startsWith('/api/command/') ? ['0'] : '' });
    // limonade answers a method it has no route for with its own "Page not
    // found" page (404). A 404 from the route's handler is JSON and means the
    // route is there: since fpp 9bee8610d a trigger for no such event is one.
    const unrouted = r.status() === 405 || (r.status() === 404 && (await r.text()).includes('Page not found'));
    if (unrouted || r.headers()['deprecation']) {
      wrong.push(`POST ${route} -> ${r.status()}${r.headers()['deprecation'] ? ' (Deprecation)' : ''}`);
    }
  }
  expect(wrong).toEqual([]);
});
