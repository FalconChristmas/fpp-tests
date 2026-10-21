import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';

// When the update source could not be reached, git_pull printed a warning and
// exited 0, so manualUpdate.php restarted fppd and logged "Upgrade Complete"
// with nothing pulled.  Fixed in fpp 98c20f9a5 ("fix(updates): report an
// unreachable update source as a failed update"): it exits 1.
//
// The test player's fppd is built and valid, so neither side rebuilds it.

const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// Each test puts the settings file back as it found it.  Writing back the
// UpgradeSource read from the API instead left UpgradeSource = "" where it
// had never been set, and an empty source is a custom one: every status poll
// then skipped the no-internet shortcut and waited out a ping to github.com,
// which takes ten seconds where ICMP is dropped (as on CI's runners) and is
// not cached when it fails -- every later page that asks for status slowed by
// that much.
let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('an update from an unreachable source fails', async ({ request }) => {
  test.setTimeout(120_000);
  try {
    expect((await request.put('/api/settings/UpgradeSource', { data: 'fpp-tests-unreachable.invalid' })).ok()).toBe(true);
    const out = inPlayer('sh', '-c', '/opt/fpp/scripts/git_pull > /tmp/fpp-tests-git-pull.out 2>&1; echo "rc=$?"; cat /tmp/fpp-tests-git-pull.out');
    // The control: it took the unreachable-source path, and built nothing.
    expect(out).toContain('unable to pull git updates');
    expect(out).not.toContain('Building FPP');
    expect(out.split('\n')[0]).toBe('rc=1');
  } finally {
    inPlayer('rm', '-f', LOG, '/tmp/fpp-tests-git-pull.out');
  }
});

// When the source was unreachable but fppd was missing, git_pull rebuilt the
// installed code and exited 4, and manualUpdate.php then printed "Upgrade
// FAILED" and the FINISH (rc=4) made updateActivity report the run failed:
// every Rebuild button, used offline, reported a successful rebuild as a
// failure.  Regression: db56ed0d3 ("fix(updates): report an offline rebuild
// as a completed rebuild, not a failed upgrade").
//
// Rebuilding fppd in the test player takes too long, and restarting it would
// leave run-web.sh's fppd behind, so git_pull is replaced by one that logs
// what the real one does on that path and exits 4, and fppd_restart by a
// no-op, for the length of the test.
const STUB_PULL = `#!/bin/bash
BINDIR=$(cd $(dirname $0) && pwd)
. \${BINDIR}/common
. \${BINDIR}/functions
startUpgradeLog "fpp-update" "fpp-tests"
echo "Can not access http://fpp-tests-unreachable.invalid/git, unable to pull git updates."
echo "\${FPPBINDIR}/fppd is missing or damaged, need to build it"
logStage "Building FPP (longest step, please wait)"
exit 4
`;

function replaceScript(name: string, body: string) {
  const path = `/opt/fpp/scripts/${name}`;
  inPlayer('sh', '-c', `cp -p ${path} ${path}.fpp-tests && echo ${Buffer.from(body).toString('base64')} | base64 -d > ${path} && chmod 755 ${path}`);
  return () => inPlayer('sh', '-c', `mv ${path}.fpp-tests ${path}`);
}

test('an offline rebuild is reported as a rebuild, not a failed upgrade', async ({ request }) => {
  test.setTimeout(120_000);
  inPlayer('rm', '-f', LOG);
  const restores = [replaceScript('git_pull', STUB_PULL), replaceScript('fppd_restart', '#!/bin/sh\nexit 0\n')];
  try {
    const out = await (await request.post('/manualUpdate.php?wrapped=1', { timeout: 90_000 })).text();
    // The control: it took the unreachable-and-rebuilt path.
    expect(out).toContain('unable to pull git updates');
    expect(out, out).not.toContain('Upgrade FAILED');
    expect(out).toContain('Rebuild Complete');
    expect(out).toContain('no updates were pulled');

    const activity = await (await request.get('/api/system/updateActivity')).json();
    expect(activity.op, JSON.stringify(activity)).toBe('fpp-update');
    expect(activity.inProgress).toBe(false);
    expect(activity.failed, JSON.stringify(activity)).toBe(false);
    expect(activity.stage).toBe('Rebuild Complete');
  } finally {
    for (const restore of restores) restore();
    inPlayer('rm', '-f', LOG, '/home/fpp/media/tmp/fppd_restarted');
  }
});
