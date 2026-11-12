import { test, expect } from './fixtures';
import { container, docker, inPlayer, playerAddress } from './container';

// rebootRemoteFPP.php and restartRemoteFPPD.php when the remote takes the
// connection for the request but never answers it and never acts: it keeps
// running, and its fppd status keeps answering with an uptime that only
// grows.  A remote that drops the connection while it acts is common (Docker
// remotes, FPP 5.x), so no reply is not a refusal, and the pages wait for it.
// But a remote that never went down has not rebooted or restarted, and the
// pages must not say it did.  fppd's status gives its uptime
// (uptimeTotalSeconds, since fppd started), which a reboot or a restart sets
// back to near 0.  multisync-remote-reboot-helper.spec.ts has the remotes
// that answer.

const REMOTE = `
import http.server, json, time
started = time.monotonic()
log = []
class H(http.server.BaseHTTPRequestHandler):
    def answer(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n:
            self.rfile.read(n)
        if self.path == '/fpp-tests-log':
            body = json.dumps(log).encode()
        else:
            log.append(self.command + ' ' + self.path)
            if self.path.startswith('/api/system/'):
                # Takes the request, then neither answers nor acts.
                time.sleep(20)
                self.close_connection = True
                return
            if self.path.startswith('/api/fppd/status'):
                body = json.dumps({'status': 0, 'status_name': 'idle',
                    'uptimeTotalSeconds': 5000 + int(time.monotonic() - started)}).encode()
            else:
                self.send_response(404)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = do_POST = do_PUT = answer
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(('0.0.0.0', 80), H).serve_forever()
`;

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let name = '';
test.afterEach(() => {
  try {
    docker('rm', '-f', name);
  } catch {
    // already gone
  }
});

async function remote() {
  name = `fpp-tests-remote-noact-${process.pid}`;
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', name, image, 'python3', '-c', REMOTE);
  const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim();
  // What the page asked, without the MultiSync info sweep fppd may make to
  // an address an earlier spec's peer had.
  const asked = () => (JSON.parse(inPlayer('curl', '-s', `http://${ip}/fpp-tests-log`)) as string[])
    .filter((r) => r !== 'GET /api/system/info' && r !== 'GET /api/cape');
  await expect.poll(() => {
    try {
      return asked();
    } catch {
      return null;
    }
  }, { timeout: 15_000 }).toEqual([]);
  return { ip, asked };
}

test('a remote that takes the reboot request but never goes down is not reported as rebooted', async ({ request }) => {
  // In FUTURE.md: after no reply, the page waits its 20 seconds, finds the
  // remote answering and says "System Rebooted", without looking at whether
  // it ever went down.
  test.fail(true, 'no reply is taken as the reboot, whatever the uptime says (FUTURE.md)');
  test.setTimeout(150_000);
  const { ip, asked } = await remote();
  const body = await (await request.get(`/rebootRemoteFPP.php?ip=${ip}`, { timeout: 140_000 })).text();
  // The control: the remote was asked, by POST, and gave no reply.
  expect(asked()[0]).toBe('POST /api/system/reboot');
  expect(body).toContain('No reply from');
  expect(body).not.toContain('System Rebooted');
});

test('a remote that takes the restart request but whose fppd never restarts is not reported as restarted', async ({ request }) => {
  // In FUTURE.md: as for the reboot.
  test.fail(true, 'no reply is taken as the restart, whatever the uptime says (FUTURE.md)');
  test.setTimeout(150_000);
  const { ip, asked } = await remote();
  const body = await (await request.get(`/restartRemoteFPPD.php?ip=${ip}`, { timeout: 140_000 })).text();
  expect(asked()[0]).toBe('POST /api/system/fppd/restart?quick=1');
  expect(body).toContain('No reply from');
  expect(body).not.toContain('FPPD Restarted');
});
