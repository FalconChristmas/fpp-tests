import { test, expect } from './fixtures';

// A name in an API path is decoded once: what the client encoded is what the
// handler sees.  A name that itself holds a valid escape ("%41") is the case
// that shows it: decoded twice it arrives as "A".  Its spaces, sent as
// "%20", show the one decode is still there.
// (filemanager-special-names.spec.ts: "#", "?", "+" and "%" names from the File Manager.)

const NAME = 'fpp-tests a%41 b%2520c';
const enc = encodeURIComponent(NAME);

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${enc}`);
  await request.delete(`/api/playlist/${encodeURIComponent('fpp-tests aA b%20c')}`);
  await request.delete(`/api/playlist/${encodeURIComponent('fpp-tests aA b c')}`);
});

test('a playlist whose name holds an escape is saved, read and deleted under that name', async ({ request }) => {
  // Regression: a2c6be1f5.  limonade's request_uri() decoded the path again after PHP
  // had, and the playlist handlers once more: "a%41" was saved as "aA".
  const r = await request.post(`/api/playlist/${enc}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(r.ok(), await r.text()).toBe(true);
  expect(await (await request.get('/api/playlists')).json()).toContain(NAME);
  const got = await request.get(`/api/playlist/${enc}`);
  expect(got.ok()).toBe(true);
  expect((await got.json()).name).toBe(NAME);
  expect((await request.delete(`/api/playlist/${enc}`)).ok()).toBe(true);
  expect(await (await request.get('/api/playlists')).json()).not.toContain(NAME);
});

test.describe('a GET from another site that would start a playlist', () => {
  const PL = 'fpp-tests-gate';
  const crossSite = { 'Sec-Fetch-Site': 'cross-site' };
  const playing = async (request: any) => (await (await request.get('/api/fppd/status')).json()).current_playlist?.playlist ?? '';
  test.beforeEach(async ({ request }) => {
    const r = await request.post(`/api/playlist/${PL}`, { data: { name: PL, version: 4, desc: '', repeat: 0, loopCount: 0,
      leadIn: [], mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 30 }], leadOut: [], playlistInfo: {} } });
    expect(r.ok()).toBe(true);
  });
  test.afterEach(async ({ request }) => {
    await request.post('/api/command', { data: { command: 'Stop Now', args: [] } });
    await request.delete(`/api/playlist/${PL}`);
  });

  test('is refused, also with its slashes encoded twice', async ({ request }) => {
    // Regression: a2c6be1f5.  Apache's cross-site GET rule matches the decoded path, and
    // ".../playlist%252F<name>%252Fstart" decodes once to a path it doesn't
    // match; limonade then decoded it again into /playlist/<name>/start.
    const plain = await request.get(`/api/playlist/${PL}/start`, { headers: crossSite });
    expect(plain.status(), 'the control: the rule refuses the plain path').toBe(403);
    const twice = await request.get(`/api/playlist%252F${PL}%252Fstart`, { headers: crossSite });
    expect(twice.status()).not.toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await playing(request)).not.toBe(PL);
  });
});
