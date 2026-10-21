import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';

// Regression: ba5d026aa ("a branch switch refused by the update lock answers
// 409, not 200"). changebranch.php took the update lock after it had sent its
// page head, so with another update holding the lock the refusal came back as
// a 200 carrying "Another FPP update is already running".

test.skip(!container, 'holds the update lock inside the run-web.sh container');

const LOCK = '/home/fpp/media/tmp/fpp-update.lock';

test('a branch switch while another update holds the lock answers 409', async ({ request }) => {
  // -o: only flock itself holds the lock, so killing it lets go.
  docker('exec', '-d', container, 'flock', '-o', LOCK, 'sh', '-c', 'touch /tmp/fpp-tests-branch-lock; sleep 30');
  try {
    await expect.poll(() => inPlayer('sh', '-c', 'test -e /tmp/fpp-tests-branch-lock && echo yes || echo no').trim(),
      { timeout: 10_000 }).toBe('yes');
    const r = await request.get('/changebranch.php?branch=master', { timeout: 60_000 });
    const body = await r.text();
    expect(body).toContain('Another FPP update is already running');
    expect(r.status(), 'the refusal came back as a success').toBe(409);
  } finally {
    inPlayer('sh', '-c', 'pkill -f "[f]lock -o ' + LOCK + '" || true; rm -f /tmp/fpp-tests-branch-lock');
  }
});
