import { test, expect } from './fixtures';

// /api sent Access-Control-Allow-Origin: * on every answer, so any web page a
// user opened could read the player's API from their browser: the cape
// serial, the settings, the file and playlist lists.  Fixed in fpp 74eb6743f
// ("fix(security): other websites can't read the API unless allowed"): the
// CORS headers are sent only while "Let other websites read the API"
// (AllowCrossOriginAPI) is on.

const ELSEWHERE = { Origin: 'http://elsewhere.example' };
const ROUTES = ['/api/fppd/status', '/api/settings/HostName'];

test('the API does not let other websites read it by default', async ({ request }) => {
  for (const route of ROUTES) {
    const r = await request.get(route, { headers: ELSEWHERE });
    // The control: the read itself is answered.
    expect(r.status(), route).toBe(200);
    expect(r.headers()['access-control-allow-origin'], route).toBeUndefined();
  }
});

test('AllowCrossOriginAPI lets other websites read the API', async ({ request }) => {
  try {
    expect((await request.put('/api/settings/AllowCrossOriginAPI', { data: '1' })).ok()).toBe(true);
    for (const route of ROUTES) {
      const r = await request.get(route, { headers: ELSEWHERE });
      expect(r.headers()['access-control-allow-origin'], route).toBe('*');
    }
  } finally {
    await request.put('/api/settings/AllowCrossOriginAPI', { data: '0' });
  }
  const r = await request.get(ROUTES[0], { headers: ELSEWHERE });
  expect(r.headers()['access-control-allow-origin']).toBeUndefined();
});

// The pages behind actions (manualUpdate, upgradeOS, resetConfig, cape-info and
// more) sent the same wildcard header themselves, from when the MultiSync
// page streamed them from other players in the browser.  Fixed in fpp
// 326eed030 ("fix(security): stop sending Access-Control-Allow-Origin: * from
// action pages").  cape-info.php is the one of them safe to request here: the
// rest act on a GET.
test('the cape page does not let other websites read it', async ({ request }) => {
  const r = await request.get('/cape-info.php', { headers: ELSEWHERE });
  expect(r.status()).toBe(200);
  expect(r.headers()['access-control-allow-origin']).toBeUndefined();
});
