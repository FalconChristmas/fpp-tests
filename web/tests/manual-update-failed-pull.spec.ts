import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';

// A pull that fails (git_pull exits 1: local changes, a broken repo) is a
// failed update: manualUpdate.php (the About page's update) reports it
// failed and leaves fppd, the Apache config and the CSP alone.
// Regression: 5c0b83a10.  manualUpdate.php ignored git_pull's status, so
// it restarted fppd and reported the update complete after any pull.
// (git_pull's own exit on a failed pull: test_git_update_scripts.py.)
//
// git_pull is replaced by one that fails as the real one does there, and
// fppd_restart by one that only records it ran, for the length of the test.

test.skip(!container, 'replaces scripts inside the run-web.sh container');

const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';
const RESTARTED = '/tmp/fpp-tests-fppd-restart-ran';

// As the real one goes on a pull that fails: it has started the upgrade log.
const STUB_PULL = `#!/bin/bash
BINDIR=$(cd $(dirname $0) && pwd)
. \${BINDIR}/common
. \${BINDIR}/functions
startUpgradeLog "fpp-update" "fpp-tests"
logStage "Fetching updates from branch fpp-tests"
echo "error: cannot pull with rebase: You have unstaged changes."
exit 1
`;

function replaceScript(name: string, body: string) {
  const path = `/opt/fpp/scripts/${name}`;
  inPlayer('sh', '-c', `cp -p ${path} ${path}.fpp-tests && echo ${Buffer.from(body).toString('base64')} | base64 -d > ${path} && chmod 755 ${path}`);
  return () => inPlayer('sh', '-c', `mv ${path}.fpp-tests ${path}`);
}

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('a failed pull is reported as a failed update, and fppd is not restarted', async ({ request }) => {
  test.setTimeout(120_000);
  inPlayer('rm', '-f', LOG, RESTARTED);
  const restores = [
    replaceScript('git_pull', STUB_PULL),
    replaceScript('fppd_restart', `#!/bin/sh\ntouch ${RESTARTED}\nexit 0\n`),
  ];
  try {
    const out = await (await request.post('/manualUpdate.php?wrapped=1', { timeout: 90_000 })).text();
    // The control: the stand-in ran.
    expect(out).toContain('You have unstaged changes');
    expect(out, out).toContain('Upgrade FAILED');
    expect(out, out).not.toContain('Upgrade Complete');
    expect(out, out).not.toContain('Restarting FPP');
    expect(inPlayer('sh', '-c', `test -e ${RESTARTED} && echo ran || echo not`).trim(),
      'fppd was restarted after a failed pull').toBe('not');
    // What the About page's update dialog then reads.
    const activity = await (await request.get('/api/system/updateActivity')).json();
    expect(activity.inProgress, JSON.stringify(activity)).toBe(false);
    expect(activity.failed, JSON.stringify(activity)).toBe(true);
  } finally {
    for (const restore of restores) restore();
    inPlayer('rm', '-f', LOG, RESTARTED, '/home/fpp/media/tmp/fppd_restarted');
  }
});
