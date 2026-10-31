import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container, docker, inPlayer } from './container';
import { writeFile } from './privacy-helpers';

// The upgrade page (about.php) when fppd does not answer.  fppd keeps
// running for the suite, so the page is served by PHP's own web server in
// the player with an LD_PRELOAD shim that refuses its connections to the
// local web server and to fppd: the requests PHP makes to fppd's API
// (http://localhost/api/fppd/...) fail as they do with fppd stopped.

test.skip(!container, 'serves the page from inside the run-web.sh container');

const PORT = 18324;
const SHIM = '/tmp/fpp-tests-no-local-api.so';

test.beforeAll(() => {
  writeFile('/tmp/fpp-tests-no-local-api.c', `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <sys/socket.h>
int connect(int fd, const struct sockaddr *sa, socklen_t len) {
    static int (*real)(int, const struct sockaddr *, socklen_t);
    if (!real) real = (int (*)(int, const struct sockaddr *, socklen_t))dlsym(RTLD_NEXT, "connect");
    unsigned short port = 0;
    if (sa && sa->sa_family == AF_INET) port = ntohs(((const struct sockaddr_in *)sa)->sin_port);
    if (sa && sa->sa_family == AF_INET6) port = ntohs(((const struct sockaddr_in6 *)sa)->sin6_port);
    if (port == 80 || port == 32322) { errno = ECONNREFUSED; return -1; }
    return real(fd, sa, len);
}
`);
  inPlayer('gcc', '-shared', '-fPIC', '-o', SHIM, '/tmp/fpp-tests-no-local-api.c', '-ldl');
  docker('exec', '-d', '-w', '/opt/fpp/www', '-e', `LD_PRELOAD=${SHIM}`, container,
    'php', '-S', `127.0.0.1:${PORT}`, '-t', '/opt/fpp/www');
  for (let i = 0; i < 100; i++) {
    if (inPlayer('sh', '-c', `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/css/fpp.css || true`).trim() !== '000') return;
    execFileSync('sleep', ['0.1']);
  }
  throw new Error('PHP\'s server did not start');
});

test.afterAll(() => {
  inPlayer('sh', '-c', `pkill -f '[p]hp -S 127.0.0.1:${PORT}'; rm -f ${SHIM} /tmp/fpp-tests-no-local-api.c; true`);
});

let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

test('the upgrade page loads to the end with fppd not answering', async ({ request }) => {
  // Regression: 6075c6f73.  getKnownFPPSystems() decoded the failed fetch of
  // fppd's MultiSync systems as if it were JSON, and array_key_exists() on
  // the null died: at the Advanced UI level, where the page lists the other
  // players as upgrade sources, it stopped there.
  expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);
  const html = inPlayer('curl', '-sS', '--max-time', '120', `http://127.0.0.1:${PORT}/about.php`);
  expect(html).not.toMatch(/Fatal error|Uncaught/);
  // The upgrade sources, with no other players to offer, and the rest of the page.
  expect(html).toMatch(/<select[^>]*id=['"]UpgradeSource['"]/);
  expect(html).toContain('Upgrade Operating System');
  expect(html.trimEnd()).toMatch(/<\/html>$/);
});
