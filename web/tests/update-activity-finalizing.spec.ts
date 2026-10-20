import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';

// While an update's own request is still finalizing -- its script has logged
// FINISH, and the request still holds the update lock while it restarts fppd
// and regenerates the Apache config -- the activity endpoint keeps reporting
// that run.  Fixed in fpp 2f73d07ff ("fix(updates): keep run identity while
// finalizing; build-failure housekeeping"); before it a finished run with the
// lock held was reported as the synthetic "workers-active" run, and the client
// lost track of the real one (no completion toast or outcome banner).
//
// The "request" is a PHP process inside the player that takes the update lock
// the way manualUpdate.php does, logs a run's START and FINISH, and keeps the
// lock for a while.

test.skip(!container, 'holds the update lock inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const LOG = `${MEDIA}/logs/fpp_system_upgrades.log`;

const HOLDER = `
$mediaDirectory = '${MEDIA}';
require '/opt/fpp/www/common/updateLock.inc.php';
UpdateLockAcquireOrConflict('fpp-update', 'fpp-tests');
file_put_contents('${LOG}',
  "[fpp-update fpp-tests] ===== fpp-update START: fpp-tests =====\\n" .
  "[fpp-update fpp-tests] fpp-tests working\\n" .
  "[fpp-update fpp-tests] ===== fpp-update FINISH: fpp-tests (rc=0) =====\\n", FILE_APPEND);
touch('/tmp/fpp-tests-lock-held');
sleep(20);
`;

test("a finishing update's own request is still reported as that run", async ({ request }) => {
  inPlayer('rm', '-f', '/tmp/fpp-tests-lock-held');
  docker('exec', '-d', container, 'php', '-r', HOLDER);
  try {
    await expect.poll(() => inPlayer('sh', '-c', 'test -e /tmp/fpp-tests-lock-held && echo yes || echo no').trim(),
      { timeout: 10_000 }).toBe('yes');
    const activity = (await (await request.get('/api/system/status')).json()).updateActivity;
    expect(activity.inProgress, JSON.stringify(activity)).toBe(true);
    expect(activity.runId, JSON.stringify(activity)).not.toBe('workers-active');
    expect(activity.op).toBe('fpp-update');
  } finally {
    inPlayer('sh', '-c', `pkill -f "[U]pdateLockAcquireOrConflict" || true; rm -f /tmp/fpp-tests-lock-held ${LOG} ${MEDIA}/tmp/fpp-update.lock`);
  }
});
