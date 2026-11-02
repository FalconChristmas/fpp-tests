import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// When systemd gives up on fppd for restarting too fast ("Start request
// repeated too quickly"), api/system/fppd/restartStatus says so and how long
// is left of the limit's window, and the status page warns with a countdown.
// The player's own fppd keeps its API port (32322) open, which the PHP takes
// for a live fppd, so php-fpm is restarted with fakerefuse.so to make that
// port refuse; systemctl and journalctl are stand-ins that answer as systemd
// does for a unit in the failed state.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SO = '/tmp/fpp-tests-fakerefuse.so';
const CONTROL = '/tmp/fpp-tests-refuse';
const MARK = 'fpp-tests-systemctl-stub';
// The real ones stay in /usr/bin; these come first in the PATH PHP's shell has.
const STUBS = ['/usr/local/bin/systemctl', '/usr/local/bin/journalctl'];
const STATE = '/tmp/fpp-tests-systemd-state';

function sh(script: string): string {
  return inPlayer('sh', '-c', script);
}

function restartPhpFpm(preload: string) {
  sh('m=$(cat /run/php/php8.4-fpm.pid 2>/dev/null); [ -n "$m" ] && kill -QUIT "$m"; ' +
    'for i in $(seq 50); do pgrep -x php-fpm8.4 > /dev/null || break; sleep 0.1; done; ' +
    `${preload ? `LD_PRELOAD=${preload} ` : ''}php-fpm8.4 -R && ` +
    'for i in $(seq 50); do [ -S /run/php/php8.4-fpm.sock ] && break; sleep 0.1; done');
}

// What the stand-in systemd says: the unit's state, whether `systemctl
// status` shows the limit message (else the journal does, or nothing does),
// and how many seconds ago the unit went inactive.
function systemd(state: string, where: 'status' | 'journal' | 'none', agoSec: number) {
  putFile(STATE, `${state}\n${where}\n${agoSec}\n`);
}

test.beforeAll(() => {
  for (const s of STUBS) {
    if (sh(`test -e ${s} && ! grep -q ${MARK} ${s} && echo real || true`).trim() === 'real') {
      throw new Error(`${s} is a real program in the player; not replacing it`);
    }
  }
  const msg = 'Start request repeated too quickly.';
  putFile(STUBS[0], `#!/bin/sh
# ${MARK}
state=$(sed -n 1p ${STATE}); where=$(sed -n 2p ${STATE}); ago=$(sed -n 3p ${STATE})
case "$*" in
  *ActiveState*) echo "$state" ;;
  "status fppd") echo "fppd.service - Falcon Player"; [ "$where" = status ] && echo "${msg}"; exit 3 ;;
  *InactiveEnterTimestampMonotonic*) echo 0 ;;
  *InactiveEnterTimestamp*) date -u -d "@$(( $(date +%s) - ago ))" '+%a %Y-%m-%d %H:%M:%S UTC' ;;
  *StartLimitIntervalSec*) echo 200000000 ;;
esac
`);
  putFile(STUBS[1], `#!/bin/sh
# ${MARK}
[ "$(sed -n 2p ${STATE})" = journal ] && echo "fppd.service: ${msg}"
exit 0
`);
  sh(`chmod 755 ${STUBS.join(' ')}`);
  sh(`gcc -O2 -shared -fPIC -o ${SO} /tests/web/tests/fakerefuse.c -ldl`);
  restartPhpFpm(SO);
});

test.afterAll(() => {
  sh(`rm -f ${CONTROL} ${STATE}; for s in ${STUBS.join(' ')}; do grep -q ${MARK} $s 2>/dev/null && rm -f $s; done; true`);
  restartPhpFpm('');
});

test.beforeEach(() => {
  putFile(CONTROL, '32322\n');
});

test('a unit failed for restarting too fast is blocked, with the time left of the limit', async ({ request }) => {
  // Regression: e2a243bb2.  Nothing said why Restart FPPD did nothing once
  // systemd's start limit was hit; the endpoint reports the window's
  // remaining seconds (interval 200s, started 60s ago) and the burst.
  systemd('failed', 'status', 60);
  const body = await (await request.get('/api/system/fppd/restartStatus')).json();
  expect(body).toMatchObject({ blocked: true, intervalSec: 200, burst: 5 });
  expect(body.remainingSec).toBeGreaterThan(130);
  expect(body.remainingSec).toBeLessThanOrEqual(140);
});

test('the limit message found only in the journal still counts', async ({ request }) => {
  systemd('failed', 'journal', 190);
  const body = await (await request.get('/api/system/fppd/restartStatus')).json();
  expect(body.blocked).toBe(true);
  expect(body.remainingSec).toBeLessThanOrEqual(10);
});

test('a unit that failed for another reason, or is running, is not blocked', async ({ request }) => {
  systemd('failed', 'none', 60);
  expect((await (await request.get('/api/system/fppd/restartStatus')).json()).blocked).toBe(false);
  systemd('active', 'status', 60);
  expect((await (await request.get('/api/system/fppd/restartStatus')).json()).blocked).toBe(false);
});

test('a window that has run out is not blocked', async ({ request }) => {
  systemd('failed', 'status', 500);
  const body = await (await request.get('/api/system/fppd/restartStatus')).json();
  expect(body).toMatchObject({ blocked: false, remainingSec: 0 });
});

test('the status poll carries the same verdict', async ({ request }) => {
  systemd('failed', 'status', 60);
  const body = await (await request.get('/api/system/status')).json();
  expect(body.fppdRestartBlocked).toMatchObject({ blocked: true, intervalSec: 200 });
});

test('the status page warns with the countdown while fppd is down', async ({ page }) => {
  // The page takes fppd's state from its status feed, which the player's live
  // fppd keeps saying "running" on; it is handed the stopped status a dead
  // fppd gives, and asks the endpoint (stood on by the stand-in systemd) how
  // long the limit has left.
  systemd('failed', 'status', 60);
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).GetFPPStatus === 'function' && document.readyState === 'complete');
  const warn = page.getByText(/FPPD restart limit reached/);
  await expect(async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.lastStatusJSON = { status_name: 'stopped', status: -1, warnings: [], warningInfo: [] };
      w.GetFPPStatus();
    });
    await expect(warn.first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(warn.first()).toHaveText(/please wait 2m \d+s before restarting/);
});
