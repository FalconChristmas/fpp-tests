import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Small API answers that clients rely on.

test('a missing playlist is a 404 with an error object', async ({ request }) => {
  // Regression: 862ab6cf3.  It was a 200 with the JSON string "", which a
  // plugin then treated as the playlist object (jsoncpp threw on its worker
  // thread, and fppd terminated).
  const r = await request.get('/api/playlist/fpp-tests-no-such-playlist');
  expect(r.status()).toBe(404);
  const body = await r.json();
  expect(body.Status).toBe('Error');
  expect(body.Message).toContain('fpp-tests-no-such-playlist');
});

test("fppd's internal plugin routes are blocked through plugin-apis in any case", async ({ request }) => {
  // Regression: 37d218d41.  The Apache rule matched "internal" case-sensitively
  // while fppd matches routes without regard to case, so /INTERNAL/ reached
  // fppd's route list.
  for (const seg of ['internal', 'INTERNAL', 'Internal']) {
    const r = await request.get(`/api/plugin-apis/${seg}/pluginApiRoutes`);
    expect(r.status(), `${seg}: ${(await r.text()).slice(0, 200)}`).toBe(403);
  }
  // The control: the passthrough itself works, so a 403 above is the block.
  const passthrough = await request.get('/api/plugin-apis/fpp-tests-none');
  expect(passthrough.status()).not.toBe(403);
});

test('a file listing gives sizes as numbers', async ({ request }) => {
  // Regression: 8826b899b.  On 64-bit PHP every sizeBytes went out as a string.
  test.skip(!container, 'seeds a sequence inside the run-web.sh container');
  const path = '/home/fpp/media/sequences/fpp-tests-size.fseq';
  inPlayer('sh', '-c', `head -c 1234 /dev/zero > ${path}`);
  try {
    const r = await request.get('/api/files/Sequences');
    const files = (await r.json()).files as { name: string; sizeBytes: unknown }[];
    const f = files.find((x) => x.name === 'fpp-tests-size.fseq');
    expect(f, JSON.stringify(files)).toBeTruthy();
    expect(f!.sizeBytes).toBe(1234);
  } finally {
    inPlayer('rm', '-f', path);
  }
});
