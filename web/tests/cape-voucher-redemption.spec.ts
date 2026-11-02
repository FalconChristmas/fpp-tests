import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The voucher redemption path of the Cape Info page: POST
// /api/cape/eeprom/voucher, and the Voucher Redemption tab that is offered
// for an unsigned licensed-driver cape until a voucher has been redeemed.
// The signing site is a local HTTPS stub (a self-signed cert trusted for the
// run) named by the SigningAPIHost setting; the container reaches no network.

test.skip(!container, 'seeds files and runs a stub signing server inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const BBB_STRINGS = `${MEDIA}/config/co-bbbStrings.json`;
const PIXEL_STRINGS = `${MEDIA}/config/co-pixelStrings.json`;
const CRT = '/usr/local/share/ca-certificates/fpp-tests-voucher.crt';
const STUB = '/tmp/fpp-tests-voucher-stub.py';

function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}
function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', 'sh', path, content);
}

const STUB_PY = `
import http.server, ssl, json
class H(http.server.BaseHTTPRequestHandler):
    def _send(self, body, ctype):
        b = body.encode()
        self.send_response(200); self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._send('// ok', 'application/javascript')
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0)); body = json.loads(self.rfile.read(n) or '{}')
        if body.get('voucher') == 'GOOD-1234':
            self._send(json.dumps({'Status': 'OK', 'key': 'KEY-FROM-STUB', 'order': 'ORDER-42'}), 'application/json')
        else:
            self._send(json.dumps({'Status': 'ERROR', 'Message': 'bad voucher'}), 'application/json')
    def log_message(self, *a): pass
s = http.server.HTTPServer(('127.0.0.1', 8443), H)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain('/tmp/fpp-tests-voucher.pem', '/tmp/fpp-tests-voucher.key')
s.socket = c.wrap_socket(s.socket, server_side=True)
s.serve_forever()
`;

let saved: Record<string, string | null> = {};
let savedHost = '';
let savedRedeemed = '';

test.beforeAll(() => {
  write(STUB, STUB_PY);
  inPlayer('sh', '-c', `cd /tmp && openssl req -x509 -newkey rsa:2048 -nodes -keyout fpp-tests-voucher.key -out fpp-tests-voucher.pem \
    -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost >/dev/null 2>&1 \
    && cp fpp-tests-voucher.pem ${CRT} && update-ca-certificates >/dev/null 2>&1
    setsid python3 ${STUB} >/dev/null 2>&1 </dev/null &
    echo $! > /tmp/fpp-tests-voucher.pid
    sleep 1`);
});
test.afterAll(() => {
  inPlayer('sh', '-c', `kill $(cat /tmp/fpp-tests-voucher.pid); rm -f ${CRT} /tmp/fpp-tests-voucher.* ${STUB}; update-ca-certificates --fresh >/dev/null 2>&1; true`);
});

test.beforeEach(async ({ request }) => {
  saved = {};
  for (const p of [CAPE_INFO, BBB_STRINGS, PIXEL_STRINGS]) saved[p] = read(p);
  const strings = JSON.stringify({ channelOutputs: [{ type: 'DPIPixels', enabled: 1, startChannel: 1, channelCount: -1, outputs: [] }] });
  write(BBB_STRINGS, strings);
  write(PIXEL_STRINGS, strings);
  // an unsigned cape on a driver that wants signing
  write(CAPE_INFO, JSON.stringify({ id: 'FppTestsHat', name: 'fpp-tests string hat', version: '1.0', serialNumber: 'SN0001', provides: ['strings'] }));
  savedHost = String((await (await request.get('/api/settings/SigningAPIHost')).json()).value ?? '');
  savedRedeemed = String((await (await request.get('/api/settings/voucherRedeemed')).json()).value ?? '');
  await request.put('/api/settings/SigningAPIHost', { data: 'localhost:8443' });
  await request.put('/api/settings/voucherRedeemed', { data: '' });
});
test.afterEach(async ({ request }) => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
  await request.put('/api/settings/SigningAPIHost', { data: savedHost });
  await request.put('/api/settings/voucherRedeemed', { data: savedRedeemed });
});

const full = { voucher: 'GOOD-1234', first_name: 'A', last_name: 'B', email: 'a@example.com', password: 'pw' };

test('redeeming a voucher without all its fields is refused', async ({ request }) => {
  // Regression: b5ffa85e2.  POST /api/cape/eeprom/voucher answers an ERROR
  // naming what must be sent when any of the five fields is missing.
  for (const k of Object.keys(full)) {
    const body: Record<string, string> = { ...full };
    delete body[k];
    const r = await request.post('/api/cape/eeprom/voucher', { data: body });
    const j = await r.json();
    expect(j.Status, `without ${k}`).toBe('ERROR');
    expect(j.Message).toContain('Missing input data');
  }
});

test('a good voucher returns the key and order from the signing site, a bad one its error', async ({ request }) => {
  // Regression: b5ffa85e2.  The route forwards the voucher to the signing
  // API (SigningAPIHost) and hands back its key and order.
  const ok = await (await request.post('/api/cape/eeprom/voucher', { data: full })).json();
  expect(ok).toMatchObject({ Status: 'OK', key: 'KEY-FROM-STUB', order: 'ORDER-42' });
  const bad = await (await request.post('/api/cape/eeprom/voucher', { data: { ...full, voucher: 'NOPE' } })).json();
  expect(bad.Status).toBe('ERROR');
  expect(bad.Message).toContain('bad voucher');
});

test('the Voucher Redemption tab is offered until a voucher has been redeemed', async ({ page, request }) => {
  // Regression: b5ffa85e2.  An unsigned cape on a licensed driver, with the
  // signing site reachable, gets a Voucher Redemption tab; the voucherRedeemed
  // setting or a cape signed with the 'fp' key takes it away.
  await page.goto('/cape-info.php');
  await expect(page.locator('#eeprom-voucher-tab')).toBeVisible();
  await expect(page.locator('#voucherNumber')).toHaveCount(1);

  await request.put('/api/settings/voucherRedeemed', { data: '1' });
  await page.goto('/cape-info.php');
  await expect(page.locator('#eeprom-signature-tab')).toBeVisible();
  await expect(page.locator('#eeprom-voucher-tab')).toHaveCount(0);

  await request.put('/api/settings/voucherRedeemed', { data: '' });
  write(CAPE_INFO, JSON.stringify({ id: 'FppTestsHat', name: 'fpp-tests string hat', version: '1.0', serialNumber: 'SN0001',
    provides: ['strings'], verifiedKeyId: 'fp', signed: { licensePorts: '24' } }));
  await page.goto('/cape-info.php');
  await expect(page.locator('#eeprom-signature-tab')).toBeVisible();
  await expect(page.locator('#eeprom-voucher-tab')).toHaveCount(0);
});

test('the documentation voucher is turned away on the page, without asking the signing site', async ({ page }) => {
  // Regression: 844859ea3 ("Display a message if someone uses the
  // test/documentation voucher").  The manual's example voucher, SUDCAEPP, was
  // sent to the signing site like any other, and came back as a plain invalid
  // voucher; the page now says what it is and sends nothing.
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('api/cape/eeprom/voucher')) posts.push(r.url()); });
  const alerts: string[] = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept().catch(() => {}); });
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-voucher-tab').click();
  // Lower case: the page upper-cases what is typed.  The other fields are
  // good ones, so nothing else stops the redemption.
  await page.locator('#voucherNumber').fill('sudcaepp');
  await page.locator('#voucherFName').fill('Alex');
  await page.locator('#voucherLName').fill('Tester');
  await page.locator('#voucherEmail').fill('alex@example.com');
  await page.locator('#voucherPassword').fill('goodpass1');
  await page.locator('input[value="Redeem Voucher"]').click();
  await expect.poll(() => alerts.length).toBeGreaterThan(0);
  expect(alerts[0]).toContain('documentation use only');
  await page.waitForTimeout(1000);
  expect(posts, 'POSTs to api/cape/eeprom/voucher').toEqual([]);
});

test('signing is offered online when the signing site answers, and offline only when it does not', async ({ page, request }) => {
  // Regression: 7b9788d02 ("Change method of checking to see if we can sign
  // via online method").  The page pinged 8.8.8.8 to decide whether to sign
  // online, which says nothing about the signing site: a network that blocks
  // ICMP was put in offline mode although it could sign, and one that answers
  // pings but cannot reach the signing site was offered online signing that
  // could only fail.  It now asks the signing site (SigningAPIHost) itself.
  await page.goto('/cape-info.php');
  await expect(page.locator('#eeprom-signature-tab')).toBeVisible();
  await expect(page.locator('#eeprom-offline-tab'), 'offline mode with the signing site answering').toHaveCount(0);

  // A signing site that does not answer is offline mode, whatever else the
  // player can reach.
  await request.put('/api/settings/SigningAPIHost', { data: 'localhost:1' });
  await page.goto('/cape-info.php');
  await expect(page.locator('#eeprom-offline-tab')).toHaveCount(1);
});
