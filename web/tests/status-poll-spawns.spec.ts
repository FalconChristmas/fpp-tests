import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// What the status and info requests every open page polls make the player
// run.  A small LD_PRELOAD library, given to php-fpm's workers for the length
// of the test, has every program they start (and every program those start)
// write its name and its parent's to a log, so the log is the list of
// processes a request cost.
//
// Regression: 19dba5e01 ("stop forking processes in the polled status and
// info paths").  With the short cache times expired, /api/system/info ran
// git (the local version, every 20 s) and `ip -4` through a shell, and a
// status poll ran the wifi listing (`iw dev`), an `ls | grep` pipeline and
// `ip --json address show` each through a shell of its own, and the wifi
// details twice.  Now the git values keep until the checkout changes, the
// addresses come from getifaddrs() and sysfs, and the one `ip` left runs
// with no shell.  (A container has no /etc/fpp/platform, so config.php asks
// `uname -s` for one on every request: that pair is left out.)

test.skip(!container, 'preloads a library into the php-fpm of the run-web.sh container');

const LIB = '/tmp/fpp-tests-execlog.so';
const LOG = '/tmp/fpp-tests-execlog.log';
const POOL = '/etc/php/8.4/fpm/pool.d/www.conf';

const SHIM = `
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static void exe_of(const char *path, char *out, size_t size) {
    ssize_t n = readlink(path, out, size - 1);
    out[n > 0 ? n : 0] = 0;
}
__attribute__((constructor)) static void fpp_tests_execlog(void) {
    const char *log = getenv("FPP_TESTS_EXECLOG");
    if (!log) return;
    char exe[256], parent[256], ppath[64], line[600];
    exe_of("/proc/self/exe", exe, sizeof(exe));
    snprintf(ppath, sizeof(ppath), "/proc/%d/exe", (int)getppid());
    exe_of(ppath, parent, sizeof(parent));
    int len = snprintf(line, sizeof(line), "%s %s\\n", exe, parent);
    int fd = open(log, O_WRONLY | O_APPEND | O_CREAT, 0666);
    if (fd >= 0) { write(fd, line, len); close(fd); }
}
`;

async function reloadPhpFpm(request: APIRequestContext) {
  inPlayer('pkill', '-USR2', '-f', 'php-fpm[:] master');
  await expect.poll(async () => (await request.get('/api/system/info').catch(() => null))?.status(), { timeout: 20_000 }).toBe(200);
}

// The programs a GET of `url` started, as [program, parent] basenames
// (php-fpm's workers as "php-fpm").
async function spawnedBy(request: APIRequestContext, url: string): Promise<string[][]> {
  inPlayer('sh', '-c', `: > ${LOG}`);
  expect((await request.get(url)).ok()).toBe(true);
  return inPlayer('cat', LOG).split('\n').filter((l) => l.trim())
    .map((l) => l.split(' ').map((p) => p.replace(/.*\//, '').replace(/^php-fpm.*/, 'php-fpm')));
}

// Without config.php's `uname -s` (a shell and uname).
function withoutUname(spawned: string[][]): string[][] {
  const i = spawned.findIndex(([exe, parent]) => exe === 'uname' && parent === 'dash');
  return i > 0 && spawned[i - 1][0] === 'dash' ? [...spawned.slice(0, i - 1), ...spawned.slice(i + 1)] : spawned;
}

test('the polled status and info requests start no shells and no git', async ({ request }) => {
  test.setTimeout(120_000);
  putFile('/tmp/fpp-tests-execlog.c', SHIM);
  inPlayer('gcc', '-shared', '-fPIC', '-O2', '-o', LIB, '/tmp/fpp-tests-execlog.c');
  inPlayer('cp', '-p', POOL, '/tmp/fpp-tests-pool.conf');
  inPlayer('sh', '-c', `printf 'env[LD_PRELOAD] = ${LIB}\\nenv[FPP_TESTS_EXECLOG] = ${LOG}\\n' >> ${POOL}`);
  try {
    await reloadPhpFpm(request);
    // Fill every cache, then make them older than the old 20 s (local git)
    // and 90 s (remote git) lifetimes.
    for (const url of ['/api/system/info', '/api/system/status?systemonly', '/api/system/status']) await request.get(url);
    inPlayer('sh', '-c', 'for f in /tmp/cache_*.cache; do touch -d "-2 min" "$f"; done');
    // PHP sees the new mtimes once its stat cache moves on.
    await new Promise((r) => setTimeout(r, 2_500));

    const all: Record<string, string[][]> = {};
    for (const url of ['/api/system/info', '/api/system/status?systemonly', '/api/system/status']) {
      all[url] = await spawnedBy(request, url);
    }
    // The control: the log sees what php-fpm starts -- the shell for uname,
    // and uname in it.
    expect(all['/api/system/info']).toEqual(expect.arrayContaining([['dash', 'php-fpm'], ['uname', 'dash']]));
    expect(withoutUname(all['/api/system/info']), 'api/system/info').toEqual([]);
    for (const url of ['/api/system/status?systemonly', '/api/system/status']) {
      // The interface list's one `ip`, run directly.
      expect(withoutUname(all[url]), url).toEqual([['ip', 'php-fpm']]);
    }
  } finally {
    inPlayer('sh', '-c', `cat /tmp/fpp-tests-pool.conf > ${POOL}`);
    await reloadPhpFpm(request);
    inPlayer('rm', '-f', LIB, LOG, '/tmp/fpp-tests-execlog.c', '/tmp/fpp-tests-pool.conf');
  }
});
