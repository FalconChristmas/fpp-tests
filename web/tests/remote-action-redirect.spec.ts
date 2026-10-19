import { test, expect } from './fixtures';
import { container, docker, inPlayer, playerAddress } from './container';

// /api/remoteAction refuses loopback as its target, but it followed the
// target's redirects, limited only to http(s).  That limits the scheme, not
// the host: a LAN host answering 302 Location: http://127.0.0.1/localonly/...
// sent the player to its own local-only pages, which Apache counts as local
// from there, and the page came back to the caller.  Fixed in fpp 852d012c3
// ("fix(api): remoteAction no longer follows a remote's redirects").
//
// The "LAN host" is a second container next to the player, answering every
// request on port 80 (remoteAction takes a bare IP) with that redirect.

const REDIRECTOR = `
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "http://127.0.0.1/localonly/phpinfo.php")
        self.send_header("Content-Length", "0")
        self.end_headers()
http.server.HTTPServer(("0.0.0.0", 80), H).serve_forever()
`;

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('remoteAction does not follow a remote redirect to the player itself', async ({ request }) => {
  const name = `fpp-tests-redirector-${process.pid}`;
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', name, image, 'python3', '-c', REDIRECTOR);
  try {
    const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // Up and redirecting, as the player sees it.
    await expect.poll(() => {
      try {
        return inPlayer('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://${ip}/api/git/releases/os`);
      } catch {
        return '';
      }
    }, { timeout: 15_000 }).toBe('302');
    // ...and the page it points at is there to be fetched from inside.
    expect(inPlayer('curl', '-s', 'http://127.0.0.1/localonly/phpinfo.php')).toContain('phpinfo()');

    const r = await request.get(`/api/remoteAction?ip=${ip}&action=listUpgrades`);
    const body = await r.text();
    expect(body, 'the redirect was followed to the player\'s local-only page').not.toContain('phpinfo()');
    expect(r.status()).not.toBe(200);
  } finally {
    try {
      docker('rm', '-f', name);
    } catch {
      // already gone
    }
  }
});
