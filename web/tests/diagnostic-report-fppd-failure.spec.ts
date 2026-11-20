import { execFileSync } from 'child_process';
import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';
import { MEDIA, writeFile } from './privacy-helpers';

// A Diagnostic Report when fppd is up but cannot build one.  The API must
// still produce a report: this is what a user hitting the wizard is most
// likely to see, and a failed fppd must not be able to fail the request.
//
// The suite's own fppd keeps running (web_serve.py fails the run if it
// stops), so the API is served by PHP's own web server in the player with
// an LD_PRELOAD shim that redirects its connects to fppd's port 32322 to
// a stand-in: GET /fppd/status answers, POST /internal/crashReport refuses
// with "build-failed".  The real PostCrashReport() and
// BuildManualCrashReportWithoutFppd() then run, with the real
// generate_crash_report, and build through the local fallback.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const CRASHES = `${MEDIA}/crashes`;
const PORT = 18326;
const STANDIN = 18327;
const SHIM = '/tmp/fpp-tests-fppd-refuses.so';

class ApiWithFailedFppd {
  static start(): ApiWithFailedFppd {
    writeFile('/tmp/fpp-tests-fppd-refuses.c', `#define _GNU_SOURCE
#include <dlfcn.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>
int connect(int fd, const struct sockaddr *sa, socklen_t len) {
    static int (*real)(int, const struct sockaddr *, socklen_t);
    if (!real) real = (int (*)(int, const struct sockaddr *, socklen_t))dlsym(RTLD_NEXT, "connect");
    if (sa && sa->sa_family == AF_INET) {
        struct sockaddr_in a;
        memcpy(&a, sa, sizeof(a));
        if (ntohs(a.sin_port) == 32322) {
            a.sin_port = htons(${STANDIN});
            return real(fd, (const struct sockaddr *)&a, sizeof(a));
        }
    }
    return real(fd, sa, len);
}
`);
    inPlayer('gcc', '-shared', '-fPIC', '-o', SHIM, '/tmp/fpp-tests-fppd-refuses.c', '-ldl');
    writeFile('/tmp/fpp-tests-fppd-standin.py', `from http.server import BaseHTTPRequestHandler, HTTPServer
LOG = '/tmp/fpp-tests-fppd-standin.log'
class H(BaseHTTPRequestHandler):
    def answer(self, body):
        with open(LOG, 'a') as f: f.write(self.command + ' ' + self.path + '\\n')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self): self.answer(b'{"Status":"OK"}')
    def do_POST(self): self.answer(b'{"Status":"ERROR","Code":"build-failed"}')
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', ${STANDIN}), H).serve_forever()
`);
    inPlayer('sh', '-c', `rm -f /tmp/fpp-tests-fppd-standin.log; true`);
    docker('exec', '-d', container, 'python3', '/tmp/fpp-tests-fppd-standin.py');
    docker('exec', '-d', '-w', '/opt/fpp/www', '-e', `LD_PRELOAD=${SHIM}`, container,
      'php', '-S', `127.0.0.1:${PORT}`, '-t', '/opt/fpp/www');
    const api = new ApiWithFailedFppd();
    for (let i = 0; i < 100; i++) {
      try {
        if (api.call('GET', 'crashes/uploadTarget').Status === 'OK') return api;
      } catch {
        // not up yet
      }
      execFileSync('sleep', ['0.1']);
    }
    api.stop();
    throw new Error("PHP's server did not start");
  }

  private url(path: string): string {
    return `http://127.0.0.1:${PORT}/api/index.php/${path}`;
  }

  call(method: string, path: string): any {
    return JSON.parse(inPlayer('curl', '-sS', '--max-time', '300', '-X', method,
      ...(method === 'POST' ? ['-H', 'Content-Type: application/json', '-d', '{"client":"fpp-tests"}'] : []), this.url(path)));
  }

  stop() {
    inPlayer('sh', '-c', `pkill -f '[p]hp -S 127.0.0.1:${PORT}'; pkill -f '[p]ython3 /tmp/fpp-tests-fppd-standin.py'; ` +
      `rm -f ${SHIM} /tmp/fpp-tests-fppd-refuses.c /tmp/fpp-tests-fppd-standin.py; true`);
  }
}

function zipNames(path: string): string[] {
  return JSON.parse(inPlayer('python3', '-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', path));
}

test.describe('a Diagnostic Report when fppd cannot build one', () => {
  let api: ApiWithFailedFppd | undefined;
  let kept = '';

  test.beforeEach(() => {
    // At most two manual reports are kept and the newest one sets the 10 s
    // cooldown, so move any left by another test out of the way.
    kept = `/tmp/fpp-tests-failed-fppd-kept-${process.pid}`;
    inPlayer('sh', '-c', `mkdir -p ${CRASHES} ${kept} && for f in ${CRASHES}/*-manual.zip; do [ -e "$f" ] && mv "$f" ${kept}/; done; true`);
    api = ApiWithFailedFppd.start();
  });

  test.afterEach(() => {
    api?.stop();
    inPlayer('sh', '-c', `rm -rf ${CRASHES}/*-manual.zip ${MEDIA}/tmp/manual-crash-php ${MEDIA}/tmp/manual-crash-php.lock; ` +
      `for f in ${kept}/*; do [ -e "$f" ] && mv "$f" ${CRASHES}/; done; rmdir ${kept}; true`);
  });

  test('fppd refusing the build still leaves a full report to inspect and send', async () => {
    // Regression: #3207.  fppd answered but its build failed; the API
    // used to turn that Code into an error and fail the whole request.
    test.setTimeout(600_000);
    const r = api!.call('POST', 'crashes/report');
    expect(r, JSON.stringify(r)).toMatchObject({ Status: 'OK', Fppd: 'unavailable' });
    expect(r.File).toMatch(/^fpp-.+-manual\.zip$/);
    expect(r.Size).toBeGreaterThan(0);

    const path = `${CRASHES}/${r.File}`;
    expect(r.Size).toBe(Number(inPlayer('stat', '-c', '%s', path)));
    expect(zipNames(path)).toEqual(expect.arrayContaining([
      'settings', 'logs/fppd.log', 'logs/troubleshootingCommands.log', 'logs/healthCheck.log',
    ]));

    // The stand-in really was asked to build and refused; the report came
    // from the API's fallback, not from fppd or a route stub in the test.
    const log = inPlayer('cat', '/tmp/fpp-tests-fppd-standin.log');
    expect(log).toContain('GET /fppd/status');
    expect(log).toContain('POST /internal/crashReport');
    // The suite's own fppd never stopped.
    expect(inPlayer('sh', "-c", `pgrep -x fppd >/dev/null && echo yes || true`).trim()).toBe('yes');
  });
});
