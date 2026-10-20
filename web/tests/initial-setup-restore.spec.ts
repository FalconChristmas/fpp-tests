import { test, expect } from './fixtures';

// initialSetup.php took a backup upload (restoreFile) and restored it at any
// time, not only on first run.  A restore replaces settings and scripts, and
// restored scripts' install actions run as root, while that handler has none
// of the Backup page's options.  Fixed in fpp 08ba56477 ("fix(security): only
// accept the setup wizard's backup restore before setup is done").
//
// The setup project has finished the wizard before this runs.

test('the setup wizard refuses a restore once setup is done', async ({ request }) => {
  const r = await request.post('/initialSetup.php', {
    multipart: { restoreFile: { name: 'fpp-tests.json', mimeType: 'application/json', buffer: Buffer.from('{}') } },
  });
  const body = await r.text();
  expect(r.status(), body).toBe(403);
  expect(body).toContain('already been completed');
});
