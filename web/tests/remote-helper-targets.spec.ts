import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, docker, inPlayer, playerAddress } from './container';

// The helpers that act on another player (GET /api/settings/<name>?ip=, the
// restart/reboot/shutdown pages, the MultiSync job runner) took any address,
// loopback included, and followed the remote's redirects, so a request
// through them reached this player's own local-only services; and a file push
// job sent any directory GetDirSetting() maps -- config included -- to the host
// it named.  streamRemoteJobs.php also took a text/plain body, which another
// web site can POST without a preflight.  Fixed in fpp 307566ca3
// ("fix(security): remote helpers only reach other players, and only what they
// should").
//
// restartRemoteFPPD.php spliced its ip parameter into the URL unchecked, so a
// "host" of 10.0.0.5:8081/x? sent the request to any port and path.  Fixed in
// fpp 30ceda818 ("fix(multisync): Validate remote target in reboot/restart
// remote pages").
//
// Two hosts sit next to the player: a listener, which logs every request it
// gets on ports 80 and 8081 and answers {}, and a redirector, which answers
// everything with a redirect to the player's own loopback.  Nothing here aims a
// helper at the player itself in a way that would act: on a tree without the
// fixes, the restart page would restart the test player's fppd.

const LISTENER = `
import http.server, socketserver, sys, threading
class H(http.server.BaseHTTPRequestHandler):
    def answer(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        print(self.server.server_address[1], self.command, self.path, flush=True)
        body = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = do_POST = do_PUT = answer
    def log_message(self, *a):
        pass
class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
for port in (80, 8081):
    threading.Thread(target=S(("0.0.0.0", port), H).serve_forever, daemon=True).start()
threading.Event().wait()
`;

const REDIRECTOR = `
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "http://127.0.0.1/api/settings/HostName")
        self.send_header("Content-Length", "0")
        self.end_headers()
http.server.HTTPServer(("0.0.0.0", 80), H).serve_forever()
`;

function startHost(role: string, script: string): { name: string; ip: string } {
  const name = `fpp-tests-${role}-${process.pid}`;
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', name, image, 'python3', '-c', script);
  const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim();
  expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  return { name, ip };
}

function stopHost(name: string) {
  try {
    docker('rm', '-f', name);
  } catch {
    // already gone
  }
}

function requestsSeen(name: string): string {
  return docker('logs', name);
}

async function runJobs(request: APIRequestContext, jobs: object[], contentType = 'application/json') {
  return request.post('/streamRemoteJobs.php', {
    headers: { 'Content-Type': contentType },
    data: JSON.stringify({ jobs }),
    timeout: 60_000,
  });
}

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test.describe('remote helpers', () => {
  let listener: { name: string; ip: string };
  let redirector: { name: string; ip: string };

  test.beforeAll(() => {
    listener = startHost('listener', LISTENER);
    redirector = startHost('redirector', REDIRECTOR);
  });

  test.afterAll(() => {
    stopHost(listener.name);
    stopHost(redirector.name);
  });

  test.beforeEach(async () => {
    // Both up, as the player sees them.
    const status = (url: string) => {
      try {
        return inPlayer('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url);
      } catch {
        return '';
      }
    };
    await expect.poll(() => [`http://${listener.ip}/`, `http://${listener.ip}:8081/`, `http://${redirector.ip}/`].map(status),
      { timeout: 15_000 }).toEqual(['200', '200', '302']);
  });

  test('a remote setting is not read from the player itself', async ({ request }) => {
    const r = await request.get('/api/settings/HostName?ip=127.0.0.1');
    expect(r.status(), await r.text()).toBe(400);
  });

  test('a remote setting is not read through a redirect to the player itself', async ({ request }) => {
    // The control: a remote that answers is read.
    const ok = await request.get(`/api/settings/HostName?ip=${listener.ip}`);
    expect(ok.status()).toBe(200);

    const r = await request.get(`/api/settings/HostName?ip=${redirector.ip}`);
    const body = await r.text();
    expect(body, 'the redirect to loopback was followed').not.toContain('Host Name');
    expect(r.status()).toBe(502);
  });

  test('a file push job sends media only', async ({ request }) => {
    const before = requestsSeen(listener.name);
    // The control: an Uploads file is pushed to the listener.
    const up = await request.post('/api/file/Uploads/fpp-tests-push.txt', { data: 'fpp-tests' });
    expect(up.ok()).toBe(true);
    try {
      const ok = await runJobs(request, [{ id: 'm', type: 'pushFiles', ip: listener.ip, dir: 'uploads', files: ['fpp-tests-push.txt'] }]);
      expect(await ok.text()).toContain('File Copy Complete');
      expect(requestsSeen(listener.name).slice(before.length)).toContain('80 POST /jqupload.php');
    } finally {
      await request.delete('/api/file/Uploads/fpp-tests-push.txt');
    }

    const mark = requestsSeen(listener.name);
    const r = await runJobs(request, [{ id: 'c', type: 'pushFiles', ip: listener.ip, dir: 'config', files: ['ui-password-config.conf'] }]);
    expect(await r.text()).toContain('ERROR: invalid directory');
    expect(requestsSeen(listener.name).slice(mark.length), 'a config file was pushed').not.toContain('POST /jqupload.php');
  });

  test('the job runner refuses a body another site could send', async ({ request }) => {
    // TEST-NET-1: nothing answers there, whichever tree runs it.
    const r = await runJobs(request, [{ id: 't', type: 'pushFiles', ip: '192.0.2.1', dir: 'uploads', files: ['x'] }], 'text/plain');
    expect(r.status(), await r.text()).toBe(415);
  });

  test('the restart page takes a host, not a host with a port and path', async ({ request }) => {
    const mark = requestsSeen(listener.name);
    const r = await request.get(`/restartRemoteFPPD.php?ip=${listener.ip}:8081/x%3F`, { timeout: 60_000 });
    expect(await r.text()).toContain('Invalid IP');
    expect(requestsSeen(listener.name).slice(mark.length), 'the restart went to the port and path given').not.toContain('8081 ');
  });
});
