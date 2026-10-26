import { test, expect } from './fixtures';

// The API page's spec (/api/openapi.json) and fppd's own routes in it.

// fppd's GET routes with no path parameters, as 24cb81c5a documented them
// from the C++ handlers' doc comments.
const FPPD_GETS = [
  '/api/commands', '/api/commandPresets', '/api/fppd/status', '/api/fppd/version', '/api/fppd/warnings',
  '/api/fppd/ports', '/api/fppd/ports/list', '/api/fppd/testing/tests', '/api/fppd/effects', '/api/fppd/playlists',
  '/api/fppd/multiSyncSystems', '/api/fppd/log', '/api/gpio', '/api/overlays/models',
];

test('the spec lists fppd\'s own routes, and each answers where it says', async ({ request }) => {
  // Feature: 24cb81c5a ("Add c++ apis to the openapi page").  The spec
  // covered only the PHP API; fppd's routes, documented in the C++ sources,
  // are generated into it too.  The receiving end is fppd answering each
  // GET the spec lists.
  const spec = await (await request.get('/api/openapi.json')).json();
  const missing = FPPD_GETS.filter((p) => !spec.paths?.[p]?.get);
  expect(missing, 'fppd routes the spec has no GET for').toEqual([]);
  for (const p of FPPD_GETS) {
    expect(spec.paths[p].get.summary || spec.paths[p].get.description, `${p} is described`).toBeTruthy();
    const r = await request.get(p);
    expect(r.status(), `GET ${p}`).toBe(200);
  }
});
