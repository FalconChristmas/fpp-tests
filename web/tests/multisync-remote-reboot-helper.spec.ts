import { test, expect } from './fixtures';
import { container, docker, inPlayer, playerAddress } from './container';

// rebootRemoteFPP.php and shutdownRemoteFPP.php, which the MultiSync page
// streams into a remote's row: the remote is asked to reboot (or shut down),
// and for a reboot the player then waits for it to answer again.  The remote
// is a second container next to the player that logs what it is asked and
// answers as told.

const REMOTE = `
import http.server, json, os
action = int(os.environ.get('ACTION_STATUS', '200'))
down = int(os.environ.get('STATUS_DOWN_FOR', '0'))
log = []
class H(http.server.BaseHTTPRequestHandler):
    def answer(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n:
            self.rfile.read(n)
        global down
        code, body = 200, b'{}'
        if self.path == '/fpp-tests-log':
            body = json.dumps(log).encode()
        else:
            log.append(self.command + ' ' + self.path)
            if self.path == '/api/fppd/status':
                if down > 0:
                    down -= 1
                    code = 503
            elif self.path.startswith('/api/system/'):
                code = action
            else:
                code = 404
        self.send_response(code)
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

// A remote that answers the reboot/shutdown request with actionStatus, and
// its first statusDownFor status polls with 503.
async function remote(actionStatus: number, statusDownFor = 0) {
  name = `fpp-tests-remote-${process.pid}`;
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', name,
    '-e', `ACTION_STATUS=${actionStatus}`, '-e', `STATUS_DOWN_FOR=${statusDownFor}`, image, 'python3', '-c', REMOTE);
  const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim();
  // What the helper asked. The player's fppd may also fetch the remote's
  // system info and cape (MultiSync's info sweep) when an earlier spec's
  // peer had this address -- Docker hands the same one out again -- so
  // those two are not the helper's and are left out.
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

test('a remote is asked to reboot, then waited for until it answers again', async ({ request }) => {
  test.setTimeout(90_000);
  // "Down" for the first three looks after the 20 seconds a reboot is given.
  const { ip, asked } = await remote(200, 3);
  const started = Date.now();
  const body = await (await request.get(`/rebootRemoteFPP.php?ip=${ip}`, { timeout: 80_000 })).text();
  const took = (Date.now() - started) / 1000;

  expect(body).toMatch(new RegExp(`^Rebooting FPP system @ ${ip.replace(/\./g, '\\.')}\nWaiting for system to come back up:\n\\.{24}\nSystem Rebooted$`));
  // Asked once, by POST, and its status not looked at until the 20 seconds are up.
  expect(asked()).toEqual(['POST /api/system/reboot', ...Array(4).fill('GET /api/fppd/status')]);
  expect(took).toBeGreaterThan(22);
  expect(took).toBeLessThan(40);
});

test('a remote that refuses the reboot is not reported as rebooted', async ({ request }) => {
  // The answer to the reboot request is looked at, so a remote that refused
  // it is not reported as "System Rebooted".
  test.setTimeout(90_000);
  const { ip, asked } = await remote(401);
  const body = await (await request.get(`/rebootRemoteFPP.php?ip=${ip}`, { timeout: 80_000 })).text();
  expect(asked()[0]).toBe('POST /api/system/reboot');
  expect(body).not.toContain('System Rebooted');
});

test('a remote is asked to shut down, once', async ({ request }) => {
  const { ip, asked } = await remote(200);
  const body = await (await request.get(`/shutdownRemoteFPP.php?ip=${ip}`)).text();
  expect(body).toBe(`Shutting down FPP system @ ${ip}\n\nSystem Shutdown`);
  expect(asked()).toEqual(['POST /api/system/shutdown']);
});

test('a remote that refuses the shutdown is not reported as shut down', async ({ request }) => {
  // As for the reboot: the answer to the request is looked at.
  const { ip, asked } = await remote(401);
  const body = await (await request.get(`/shutdownRemoteFPP.php?ip=${ip}`)).text();
  expect(asked()).toEqual(['POST /api/system/shutdown']);
  expect(body).not.toContain('System Shutdown');
});

test('an older remote without the POST route is asked by GET', async ({ request }) => {
  // RemotePlayerAction(): 404 or 405 to the POST means a remote from before
  // the route took one.
  const { ip, asked } = await remote(405);
  await (await request.get(`/shutdownRemoteFPP.php?ip=${ip}`)).text();
  expect(asked()).toEqual(['POST /api/system/shutdown', 'GET /api/system/shutdown']);
});
