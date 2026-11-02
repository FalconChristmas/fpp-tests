import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The cape string and panel configuration queries: the keys of the configs
// cape detection leaves in media/tmp/strings and media/tmp/panels, and each
// config by key.

test.skip(!container, 'seeds cape configs inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const STRINGS = `${MEDIA}/tmp/strings/fpp-tests-strings.json`;
const PANELS = `${MEDIA}/tmp/panels/fpp-tests-panels.json`;

test.beforeEach(() => {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/tmp/strings ${MEDIA}/tmp/panels &&
    printf '%s' '{"name":"fpp-tests strings","outputs":[{"pin":"P8-45"}]}' > ${STRINGS} &&
    printf '%s' '{"name":"fpp-tests panels","driver":"BBShiftPanel"}' > ${PANELS}`);
});
test.afterEach(() => {
  inPlayer('rm', '-f', STRINGS, PANELS);
});

test('the cape string and panel configs are listed by key and served by key', async ({ request }) => {
  // Regression: a3d6d0255 ("Add some API's to query cape string/panel
  // configs").  /api/cape/strings and /api/cape/panel list the keys (the file
  // names without .json) and /api/cape/strings/:key, /api/cape/panel/:key
  // return that config.  (The 404 for an unknown string key is in
  // api-file-and-list-fixes.spec.ts.)
  const strings = await request.get('/api/cape/strings');
  expect(strings.status()).toBe(200);
  expect(await strings.json()).toContain('fpp-tests-strings');
  const panels = await request.get('/api/cape/panel');
  expect(panels.status()).toBe(200);
  expect(await panels.json()).toContain('fpp-tests-panels');

  expect(await (await request.get('/api/cape/strings/fpp-tests-strings')).json())
    .toEqual({ name: 'fpp-tests strings', outputs: [{ pin: 'P8-45' }] });
  expect(await (await request.get('/api/cape/panel/fpp-tests-panels')).json())
    .toEqual({ name: 'fpp-tests panels', driver: 'BBShiftPanel' });
});
