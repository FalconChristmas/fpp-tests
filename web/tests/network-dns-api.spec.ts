import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, keepingFile } from './privacy-helpers';

// GET and POST /api/network/dns, the real endpoints: the Network page's own
// specs answer these for the page.

test.skip(!container, 'keeps the DNS config in the run-web.sh container');

test('DNS servers saved through the API are read back and written to the config', async ({ request }) => {
  // Regression: f1404307e (the DNS endpoints, moved here from fppjson.php).
  const file = `${MEDIA}/config/dns`;
  await keepingFile(file, async () => {
    const saved = await request.post('/api/network/dns', { data: { DNS1: '192.0.2.53', DNS2: '198.51.100.53' } });
    expect((await saved.json()).status).toBe('OK');
    const read = await (await request.get('/api/network/dns')).json();
    expect(read).toMatchObject({ status: 'OK', DNS1: '192.0.2.53', DNS2: '198.51.100.53' });
    expect(inPlayer('cat', file)).toContain('192.0.2.53');
  });
});
