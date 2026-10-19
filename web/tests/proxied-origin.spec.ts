import { test, expect } from './fixtures';

// A state-changing request from this player's UI seen through an older
// player's /proxy/ is accepted. That proxy passes the browser's Origin (the
// proxying player) on unchanged, with the host the browser asked for in
// X-Forwarded-Host. The cross-site gate (fpp ef8961d24) compared Origin with
// this player's own Host only, so once fpp 77efc7561 moved the UI's controls
// to POST, every one of them was refused (403) there. Fixed in fpp 5876f98ca
// ("fix(apache): this player's UI seen through an older player's /proxy/ can
// POST"), which also accepts an Origin matching X-Forwarded-Host.
//
// Playwright's request context is not a browser, so it can send these
// headers as a proxy would; a page on another site cannot (CORS preflight).

const route = '/api/playlists/stop';

test("a POST an older player's /proxy/ passed on is accepted", async ({ request }) => {
  const r = await request.post(route, {
    headers: { Origin: 'http://older-player.example', 'X-Forwarded-Host': 'older-player.example' },
  });
  expect(r.status(), await r.text()).not.toBe(403);
});

test('a POST from another site is still refused', async ({ request }) => {
  for (const headers of [
    { Origin: 'http://elsewhere.example' },
    { Origin: 'http://elsewhere.example', 'X-Forwarded-Host': 'older-player.example' },
    { Origin: 'http://older-player.example', 'X-Forwarded-Host': 'older-player.example', 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const r = await request.post(route, { headers });
    expect(r.status(), JSON.stringify(headers)).toBe(403);
  }
});
