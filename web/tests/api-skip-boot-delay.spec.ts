import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, readFile } from './settings-file';

// POST /api/system/fppd/skipBootDelay leaves the flag fppinit waits on, only
// while fppinit is holding the boot back (tmp/boot_delay is there).

test.skip(!container, "looks at the run-web.sh container's media/tmp");

const DELAY = `${MEDIA}/tmp/boot_delay`;
const SKIP = `${MEDIA}/tmp/boot_delay_skip`;

test.afterEach(() => inPlayer('rm', '-f', DELAY, SKIP));

test('with no boot delay running it says so and leaves no flag', async ({ request }) => {
  inPlayer('rm', '-f', DELAY, SKIP);
  const r = await request.post('/api/system/fppd/skipBootDelay');
  expect(JSON.parse(await r.text())).toMatchObject({ status: 'error', message: 'No boot delay in progress' });
  expect(exists(SKIP)).toBe(false);
});

test('during a boot delay it leaves the flag fppinit waits for', async ({ request }) => {
  inPlayer('touch', DELAY);
  const r = await request.post('/api/system/fppd/skipBootDelay');
  expect(JSON.parse(await r.text())).toMatchObject({ status: 'OK' });
  expect(readFile(SKIP)).toBe('1');
});
