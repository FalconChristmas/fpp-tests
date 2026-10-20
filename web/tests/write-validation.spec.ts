import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Values and names the API writes into line-oriented config files (and
// setting names, which pages also emit into script) can't add lines or code
// of their own.

test.skip(!container, 'reads config files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';

function file(path: string): string {
  return inPlayer('sh', '-c', `cat '${path}' 2>/dev/null || true`);
}

test('an interface config value cannot add a line', async ({ request }) => {
  // Regression: d0bcf0d4c.  Addresses and Wi-Fi strings went through
  // fprintf("%s") into config/interface.<name>, which is read as KEY=VALUE
  // lines with no escapes: a quote and a line break added a key.
  const cfg = `${MEDIA}/config/interface.wlan9`;
  try {
    for (const data of [
      { INTERFACE: 'wlan9', PROTO: 'dhcp', SSID: 'fpp-tests"\nFPPTESTSINJECTED="1', PSK: 'fpp-tests-psk' },
      { INTERFACE: 'wlan9', PROTO: 'static', ADDRESS: '10.0.0.9"\nFPPTESTSINJECTED="1', NETMASK: '255.255.255.0', SSID: 'x', PSK: 'fpp-tests-psk' },
    ]) {
      const r = await request.post('/api/network/interface/wlan9', { data });
      const conf = file(cfg);
      expect(conf, `${JSON.stringify(data)} -> ${await r.text()}`).not.toMatch(/^FPPTESTSINJECTED/m);
    }
    // The control: a clean value is written.
    await request.post('/api/network/interface/wlan9', { data: { INTERFACE: 'wlan9', PROTO: 'dhcp', SSID: 'fpp-tests-ssid', PSK: 'fpp-tests-psk' } });
    expect(file(cfg)).toContain('fpp-tests-ssid');
  } finally {
    inPlayer('rm', '-f', cfg, `${MEDIA}/config/leases.wlan9`);
  }
});

test('a proxy host or description cannot add Apache directives', async ({ request }) => {
  // Regression: d3109b082.  POST /api/proxies/<host> wrote its host into
  // proxy-config.conf unchecked, and a line break in a description ended its
  // "# D:" comment line.
  const conf = `${MEDIA}/config/proxy-config.conf`;
  try {
    await request.post('/api/proxies', {
      data: [{ host: '10.0.0.250', description: 'fpp-tests\nRewriteRule ^fpptestsdesc$ http://127.0.0.1/ [P]' }],
    });
    await request.post(`/api/proxies/${encodeURIComponent('fpptestshost$ http://127.0.0.1/ [P]\nRewriteRule ^x')}`);
    const text = file(conf);
    // The control: the valid host in the first request was written.
    expect(text).toContain('10.0.0.250');
    const directives = text.split('\n').filter((l) => /^\s*RewriteRule\b/.test(l) && /fpptests/.test(l));
    expect(directives, text).toEqual([]);
  } finally {
    await request.delete('/api/proxies');
    inPlayer('rm', '-f', conf);
  }
});

test('a setting name with a quote or a line break is refused', async ({ request }) => {
  // Regression: 3a7a34c1f.  PUT /api/settings/<name> stored any name, and a
  // name is an INI key in the settings file and a JS string on every page.
  for (const name of ["fpp-tests'quote", 'fpp-tests%0AFppTestsInjected']) {
    const r = await request.put(`/api/settings/${name}`, { data: '1' });
    expect(r.status(), `${name}: ${await r.text()}`).toBe(400);
  }
  const settings = file(`${MEDIA}/settings`);
  expect(settings).not.toContain("fpp-tests'quote");
  expect(settings).not.toMatch(/^FppTestsInjected/m);
});

test('a setting name already in the settings file is emitted into pages as data', async ({ page }) => {
  // Regression: 1e6e362c3.  config.php printed each key raw inside
  // settings['...'], so a key from a hand-edited file or a restored backup ran
  // as script on every page.
  const key = "fpp-tests'];document.documentElement.setAttribute('data-fpp-tests-ran','1');//";
  inPlayer('sh', '-c', `printf '%s = "x"\\n' "${key}" >> ${MEDIA}/settings`);
  try {
    await page.goto('/index.php');
    await page.waitForLoadState('load');
    expect(await page.locator('html').getAttribute('data-fpp-tests-ran')).toBeNull();
    // The control: the page did read the key.
    expect(await page.evaluate((k) => (window as any).settings[k], key)).toBe('x');
  } finally {
    inPlayer('sed', '-i', '/^fpp-tests/d', `${MEDIA}/settings`);
  }
});
