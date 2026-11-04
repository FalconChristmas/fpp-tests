import { test, expect } from './fixtures';

test('GET /api/git/status answers OK with the status text', async ({ request }) => {
  // 1769b45fb (#944): the developer page's git status moved from fppxml.php
  // to this endpoint.
  const r = await request.get('/api/git/status');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe('OK');
  expect(typeof body.log).toBe('string');
});
