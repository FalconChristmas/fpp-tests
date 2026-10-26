import { test, expect } from './fixtures';
import http from 'http';
import { gunzipSync, gzipSync } from 'zlib';
import { container, docker, playerAddress } from './container';

// /proxy/<controller>/ passes a controller's answer on as the controller sent
// it.  The controller is a host of its own next to the player on its Docker
// network, a small server that, like ESPixelStick, serves its files
// pre-gzipped whatever the client asked for.  The requests are made from
// here with node's http, which (unlike a browser or Playwright's request)
// shows the bytes and headers as they came, compressed or not.

test.skip(!container, 'puts a controller next to the run-web.sh container');

const BODY = Buffer.from('// fpp-tests controller asset\n' + 'var x = 1;\n'.repeat(400));
const GZ = gzipSync(BODY, { level: 9 });

const SERVER = `
import http.server, sys, base64
gz = base64.b64decode(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript')
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(gz)))
        self.end_headers()
        self.wfile.write(gz)
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(('0.0.0.0', 80), H).serve_forever()
`;

let controller = '';
let address = '';

test.beforeAll(() => {
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  controller = `fpp-tests-gzip-controller-${process.pid}`;
  try {
    docker('rm', '-f', controller);
  } catch {
    // none left over
  }
  docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', controller, image,
    'python3', '-c', SERVER, GZ.toString('base64'));
  address = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', controller).trim();
});

test.afterAll(() => {
  if (controller) docker('rm', '-f', controller);
});

function get(path: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }> {
  const base = test.info().project.use.baseURL!;
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('a gzipped controller asset comes through /proxy as the controller sent it', async () => {
  // Regression: b2b19166f ("update proxy handler to prevent unnecessary
  // re-compression of responses").  /proxy gunzipped and gzipped every
  // answer again, which dropped the controller's Content-Length for a
  // chunked one (and a short answer became a chunked-encoding error).
  const path = `/proxy/${address}/api/fpp-tests.js`;
  // The control: the controller answers as described, straight from the player's network.
  await expect.poll(async () => (await get(path, { 'Accept-Encoding': 'gzip' }).catch(() => null))?.headers['content-encoding'],
    { timeout: 20_000 }).toBe('gzip');
  const r = await get(path, { 'Accept-Encoding': 'gzip, deflate' });
  expect(r.headers['content-encoding']).toBe('gzip');
  expect(r.headers['transfer-encoding'], 'the answer was re-encoded on the way').toBeUndefined();
  expect(r.headers['content-length']).toBe(String(GZ.length));
  expect(Buffer.compare(r.body, GZ), 'the bytes are not the controller\'s').toBe(0);
  expect(Buffer.compare(gunzipSync(r.body), BODY)).toBe(0);
});

test('a client that cannot take gzip gets the controller asset expanded', async () => {
  // Regression: b2b19166f: the one case the filter is kept for.  curl and
  // wget ask for no encoding, and a controller that only has gzipped files
  // sends gzip all the same.
  const r = await get(`/proxy/${address}/api/fpp-tests.js`, {});
  expect(r.headers['content-encoding']).toBeUndefined();
  expect(Buffer.compare(r.body, BODY)).toBe(0);
});
