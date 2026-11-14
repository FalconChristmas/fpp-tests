import { test, expect } from './fixtures';
import { container, docker, inPlayer, playerAddress } from './container';

// /api/remoteAction asks another player (a bare IP) to do something and hands
// back its answer.  When that player fails, the failure is the remote's: the
// caller's own request was good.
//
// The remote players are containers next to this one: one answering every
// request with a 500, and one with nothing listening on port 80.

const FAILING = `
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"the remote broke"
        self.send_response(500)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(("0.0.0.0", 80), H).serve_forever()
`;

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

function neighbour(name: string, ...cmd: string[]): string {
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', name, image, ...cmd);
  const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim();
  expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  return ip;
}

function remove(name: string) {
  try {
    docker('rm', '-f', name);
  } catch {
    // already gone
  }
}

test('a remote player that answers with an error is a 502, with its code', async ({ request }) => {
  // Regression: 4c8dca184 ("fix(api): remoteAction answers 502, not 400, when
  // the remote player fails").  The remote's failure was answered 400, which
  // tells the caller its own request was bad.
  const name = `fpp-tests-remote-500-${process.pid}`;
  try {
    const ip = neighbour(name, 'python3', '-c', FAILING);
    await expect.poll(() => {
      try {
        return inPlayer('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://${ip}/api/git/releases/os`);
      } catch {
        return '';
      }
    }, { timeout: 15_000 }).toBe('500');

    const r = await request.get(`/api/remoteAction?ip=${ip}&action=listUpgrades`);
    const body = await r.text();
    expect(r.status(), body).toBe(502);
    expect(JSON.parse(body).error).toBe('HTTP Error: 500');
  } finally {
    remove(name);
  }
});

test('a remote player that does not answer is a 502 too', async ({ request }) => {
  // Regression: 4c8dca184.
  const name = `fpp-tests-remote-silent-${process.pid}`;
  try {
    const ip = neighbour(name, 'sleep', '120');
    const r = await request.get(`/api/remoteAction?ip=${ip}&action=listUpgrades`);
    const body = await r.text();
    expect(r.status(), body).toBe(502);
    expect(JSON.parse(body).error).toBe('HTTP Error: 0');
  } finally {
    remove(name);
  }
});

test('the control: an unknown action is still the caller\'s mistake, a 400', async ({ request }) => {
  const r = await request.get('/api/remoteAction?ip=192.0.2.1&action=fpp-tests-no-such-action');
  expect(r.status(), await r.text()).toBe(400);
});
