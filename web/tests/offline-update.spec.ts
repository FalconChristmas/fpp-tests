import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// When the update source could not be reached, git_pull printed a warning and
// exited 0, so manualUpdate.php restarted fppd and logged "Upgrade Complete"
// with nothing pulled.  Fixed in fpp 98c20f9a5 ("fix(updates): report an
// unreachable update source as a failed update"): it exits 1.
//
// The test player's fppd is built and valid, so neither side rebuilds it.

const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('an update from an unreachable source fails', async ({ request }) => {
  test.setTimeout(120_000);
  const before = (await (await request.get('/api/settings/UpgradeSource')).json()).value ?? '';
  try {
    expect((await request.put('/api/settings/UpgradeSource', { data: 'fpp-tests-unreachable.invalid' })).ok()).toBe(true);
    const out = inPlayer('sh', '-c', '/opt/fpp/scripts/git_pull > /tmp/fpp-tests-git-pull.out 2>&1; echo "rc=$?"; cat /tmp/fpp-tests-git-pull.out');
    // The control: it took the unreachable-source path, and built nothing.
    expect(out).toContain('unable to pull git updates');
    expect(out).not.toContain('Building FPP');
    expect(out.split('\n')[0]).toBe('rc=1');
  } finally {
    await request.put('/api/settings/UpgradeSource', { data: before });
    inPlayer('rm', '-f', LOG, '/tmp/fpp-tests-git-pull.out');
  }
});
