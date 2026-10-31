import { test, expect } from './fixtures';
import http from 'http';
import type { AddressInfo } from 'net';
import { container, inPlayer } from './container';

// The header's cape vendor logo comes from the vendor's own host, which an
// offline show player cannot reach.  The vendor host here is a server on
// another port that takes the request and never answers it.

test.skip(!container, 'seeds cape info inside the run-web.sh container');
// The player's CSP only names a vendor's host once the cape is detected at
// boot; the test cape here is added afterwards.
test.use({ bypassCSP: true });

const INFO = '/home/fpp/media/tmp/cape-info.json';

test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', INFO);
  await request.put('/api/settings/FetchVendorLogos', { data: '0' });
});

test('a vendor logo host that never answers does not hold up the page', async ({ page, request }) => {
  // Regression: 93bab0a9c.  The logo was an <img> in the header's markup, so
  // the page's load event -- and everything the page runs on it -- waited on
  // the vendor host until the browser gave up on it.
  let asked = 0;
  const held: http.ServerResponse[] = [];
  const vendor = http.createServer((_req, res) => {
    asked++;
    held.push(res);
  });
  await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
  const { port } = vendor.address() as AddressInfo;
  try {
    inPlayer('sh', '-c', `mkdir -p /home/fpp/media/tmp && cat > ${INFO} <<'EOF'
{"id":"fpp-tests","name":"fpp-tests cape","serialNumber":"1","vendor":{"name":"fpp-tests","url":"http://127.0.0.1:${port}/","image":"http://127.0.0.1:${port}/logo.png"}}
EOF`);
    await request.put('/api/settings/FetchVendorLogos', { data: '1' });
    const started = Date.now();
    await page.goto('/index.php', { waitUntil: 'load', timeout: 15_000 });
    const ms = Date.now() - started;
    // The control: the logo was asked for, and is still outstanding.
    await expect.poll(() => asked).toBeGreaterThan(0);
    expect(ms, 'the page load waited on the vendor host').toBeLessThan(10_000);
    await expect(page.locator('#capeVendorLink img')).toHaveCount(0);
  } finally {
    for (const res of held) res.destroy();
    vendor.close();
  }
});
