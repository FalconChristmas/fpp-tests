import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, docker, playerAddress } from './container';

// A MultiSync upgrade job counted any HTTP 200 from the remote's
// manualUpdate.php as success, but that page answers 200 whatever happens, so
// a remote whose build or pull failed showed as done, with no Retry button.
// Fixed in fpp 3c2659d3a ("fix(multisync): fail a remote upgrade the remote
// reported as failed"), which reads the streamed output for the failure lines
// every FPP since 9.5 prints.
//
// The remotes are containers next to the player, answering the update page
// (by GET or POST) with a canned log.

const REMOTE = `
import http.server, sys
BODY = {
    "failed": "Pulling updates\\n===== Upgrade Failed =====\\nUpgrade FAILED.\\n",
    "ok": "Pulling updates\\nBuilding FPP\\nUpgrade Complete\\n",
}[sys.argv[1]].encode()
class H(http.server.BaseHTTPRequestHandler):
    def answer(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)
    do_GET = do_POST = answer
    def log_message(self, *a):
        pass
http.server.HTTPServer(("0.0.0.0", 80), H).serve_forever()
`;

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function runJob(request: APIRequestContext, job: object) {
  const r = await request.post('/streamRemoteJobs.php', {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ jobs: [job] }),
    timeout: 60_000,
  });
  const lines = (await r.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  return lines.find((l) => l.done) ?? lines;
}

test.describe('remote upgrade outcome', () => {
  const remotes: Record<string, { name: string; ip: string }> = {};

  test.beforeAll(() => {
    const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
    for (const mode of ['failed', 'ok']) {
      const name = `fpp-tests-remote-${mode}-${process.pid}`;
      docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', name, image, 'python3', '-c', REMOTE, mode);
      remotes[mode] = { name, ip: docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim() };
    }
  });

  test.afterAll(() => {
    for (const r of Object.values(remotes)) {
      try {
        docker('rm', '-f', r.name);
      } catch {
        // already gone
      }
    }
  });

  test('an upgrade the remote reports as failed fails the job', async ({ request }) => {
    // The control: a remote that reports success is a successful job.
    await expect.poll(async () => (await runJob(request, { id: 'ok', type: 'upgrade', ip: remotes.ok.ip })).ok,
      { timeout: 15_000 }).toBe(true);

    const done = await runJob(request, { id: 'f', type: 'upgrade', ip: remotes.failed.ip });
    expect(done).toEqual({ id: 'f', done: true, ok: false });
  });
});
