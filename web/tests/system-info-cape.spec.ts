import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// api/system/info names the cape detection found, from media/tmp/cape-info.json.

test.skip(!container, 'seeds the cape info inside the run-web.sh container');

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';

test.afterEach(() => {
  inPlayer('rm', '-f', CAPE_INFO);
});

test('system info carries the cape\'s name, id and version, and nothing else of it', async ({ request }) => {
  // Feature: 8e67257d0.  The info had nothing about the cape, so a remote
  // (MultiSync, xLights) could not tell which one a player has.
  const before = await (await request.get('/api/system/info')).json();
  expect(before.capeInfo).toBeUndefined();

  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({
    id: 'fpp-tests-cape', name: 'fpp-tests Cape', version: '2.1', serialNumber: 'SN-fpp-tests-0001',
    designer: 'fpp-tests', vendor: { name: 'fpp-tests vendor', url: 'https://vendor.invalid/' },
  }), CAPE_INFO);
  const info = await (await request.get('/api/system/info')).json();
  expect(info.capeInfo).toEqual({ name: 'fpp-tests Cape', id: 'fpp-tests-cape', version: '2.1' });
  expect(JSON.stringify(info)).not.toContain('SN-fpp-tests-0001');
});
