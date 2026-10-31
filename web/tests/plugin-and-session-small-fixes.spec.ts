import { test, expect } from './fixtures';

// Small web-layer answers.

test('a plugin page that does not exist is a 404', async ({ request }) => {
  // Regression: 3ef13b44d.  The "Error with plugin" text went out with a 200.
  const r = await request.get('/plugin.php?plugin=fpp-tests-none&page=nothing.php&nopage=1');
  expect(r.status(), (await r.text()).slice(0, 200)).toBe(404);
});

test('a plugin file that does not exist is a 404', async ({ request }) => {
  // Regression: 3ef13b44d.
  const r = await request.get('/plugin.php?plugin=fpp-tests-none&file=nothing.png&nopage=1');
  expect(r.status(), (await r.text()).slice(0, 200)).toBe(404);
});

test('the API does not start a PHP session', async ({ request }) => {
  // Regression: ac509f839 (#1436).  limonade started a session, so every API
  // answer carried a LIMONADE0x5x0 cookie.
  const r = await request.get('/api/settings/HostName');
  expect(r.status()).toBe(200);
  const cookies = r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
  expect(cookies, JSON.stringify(cookies)).toEqual([]);
});

test('/api/cape with no cape is a 404 that is still JSON', async ({ request }) => {
  // Regression: d8b8203fb.  The 404 body was plain text, which the UI's JSON
  // parse failed on.
  const r = await request.get('/api/cape');
  test.skip(r.status() !== 404, 'this player has a cape');
  expect(r.headers()['content-type']).toContain('application/json');
  expect((await r.json()).id).toBe('No Cape!');
});
