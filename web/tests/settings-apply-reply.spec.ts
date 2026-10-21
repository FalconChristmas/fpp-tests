import { test, expect } from './fixtures';

// Regression: 705b57f83 ("applying the UI password setting no longer writes
// into the reply"). SetupHtaccess() reloaded Apache with system(), which
// passes the command's output through, so "Reloading Apache httpd web
// server..." went out in front of the JSON of every call that applied
// passwordEnable: the settings save, and every Settings restore of a backup
// carrying the key.

test('saving passwordEnable answers with JSON and nothing else', async ({ request }) => {
  const r = await request.put('/api/settings/passwordEnable', { data: '0' });
  const body = await r.text();
  expect(r.ok(), body).toBe(true);
  expect(body, 'the reload command wrote into the reply').not.toContain('Reloading');
  expect(() => JSON.parse(body), body.slice(0, 200)).not.toThrow();
  expect(JSON.parse(body).status).toBe('OK');
});
