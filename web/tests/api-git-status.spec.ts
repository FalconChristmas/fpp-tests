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

test('POST /api/git/reset runs the reset and answers OK with its log lines', async ({ request }) => {
  // Feature: b450264aa ("Git Reset moved - #944"): the developer page's Git
  // Reset moved from fppxml.php to this endpoint, which answers the
  // script's output.  The tree run-web.sh serves is an export with no .git,
  // so scripts/git_reset finds nothing to reset and changes nothing.
  const r = await request.post('/api/git/reset');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe('OK');
  expect(Array.isArray(body.log), JSON.stringify(body)).toBe(true);
});
