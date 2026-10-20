import { test, expect } from './fixtures';
import { container, docker, playerAddress } from './container';

// /api/remoteAction relays a remote player's answer for listUpgrades and
// updateLog (added in fpp 69e37ac35).  Its only check on ip is "an IPv4
// address that is not loopback or 0", and the request is a GET, so if the
// answer is served as a page, a link to
// /api/remoteAction?ip=<any host>&action=updateLog runs whatever script that
// host answers with, with this player's whole API.
//
// Regression: 6f28a206b.  The answer went back as a bare
// string, which limonade sends as text/html.
//
// The "remote" is a second container next to the player, answering every
// request with a page that sets a global.

const HOSTILE = `
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<script>window.__fppTestsRelayed=1</script>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(("0.0.0.0", 80), H).serve_forever()
`;

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test.describe('remoteAction relaying a remote answer', () => {
  let name = '';
  let ip = '';

  test.beforeAll(() => {
    name = `fpp-tests-hostile-${process.pid}`;
    const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
    docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', name, image, 'python3', '-c', HOSTILE);
    ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim();
  });

  test.afterAll(() => {
    try {
      docker('rm', '-f', name);
    } catch {
      // already gone
    }
  });

  for (const action of ['updateLog', 'listUpgrades']) {
    test(`${action} does not run a remote's script in this player's origin`, async ({ page }) => {
      // The remote is up and its answer comes back through the relay.
      await expect.poll(async () => (await page.request.get(`/api/remoteAction?ip=${ip}&action=${action}`)).status(),
        { timeout: 15_000 }).toBe(200);

      const r = await page.goto(`/api/remoteAction?ip=${ip}&action=${action}`);
      expect(r!.headers()['content-type'] ?? '').not.toMatch(/text\/html/);
      expect(await page.evaluate(() => (window as any).__fppTestsRelayed), 'the remote script ran').toBeUndefined();
    });
  }
});
