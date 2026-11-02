import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The update check reads the update source's newest commit with git ls-remote.
// ICMP is often filtered (GitHub stopped answering it in some places), so a
// ping of the source must not be a condition of asking git: git is the thing
// that knows whether the source answers.
//
// ping is replaced for the test by one that never gets a reply, as on a
// network that drops ICMP; the update source is a git repository on the
// player's own disk, which git reaches without any ICMP.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const PING = '/usr/local/bin/ping';
const ORIGIN = '/tmp/fpp-tests-origin.git';
let restoreSettings: () => void;

test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  inPlayer('sh', '-c', `cat > ${PING} <<'P'
#!/bin/sh
echo "$*" >> /tmp/fpp-tests-ping.log
exit 1
P
chmod 755 ${PING}; rm -f /tmp/cache_git_* /tmp/fpp-tests-ping.log`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `rm -rf ${PING} /tmp/cache_git_* /tmp/fpp-tests-ping.log ${ORIGIN} /opt/fpp/.git`);
  restoreSettings();
});

test('the newest commit of the update source is shown when it does not answer ping', async ({ request }) => {
  // Regression: ff7403519.  The check was "ping -q -c 1 <origin> && git
  // ls-remote ...", so a source that drops ICMP showed "Unknown" for the
  // remote version though git could read it.
  setSettingInFile('UpgradeSource', 'fpp-tests-mirror.invalid');
  const branch: string = (await (await request.get('/api/system/info')).json()).Branch;
  inPlayer('sh', '-c', `set -e; rm -f /tmp/cache_git_*; rm -rf ${ORIGIN}; git init -q --bare ${ORIGIN}; ` +
    `c=$(git --git-dir=${ORIGIN} -c user.name=t -c user.email=t@invalid commit-tree $(git --git-dir=${ORIGIN} mktree < /dev/null) -m x); ` +
    `git --git-dir=${ORIGIN} update-ref 'refs/heads/${branch}' $c; echo $c > /tmp/fpp-tests-origin-sha; ` +
    `cd /opt/fpp && git init -q && git remote add origin ${ORIGIN}`);
  const sha = inPlayer('cat', '/tmp/fpp-tests-origin-sha').trim();
  const info = await (await request.get('/api/system/info', { timeout: 60_000 })).json();
  expect(info.RemoteGitVersion).toBe(sha.slice(0, 9));
});
