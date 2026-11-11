import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile, readFile, exists, setSettingInFile, snapshotSettings } from './settings-file';
import { standInCommand, commandLog } from './pw-helpers';

// changebranch.php for a pull request and for the developer's own GitHub fork
// (the Developer tab's Pull Requests and fork remotes).  A PR is fetched from
// origin as pull/<n>/head and checked out as pr-<n>; before that, if the PR
// carries config migrations (upgrade/<n>) this player has not run, the page
// stops and says so -- they can't be undone, and PRs reuse each other's
// numbers -- and only a Continue (ackcfg=1) switches.  A fork remote is added
// (with the saved token, so a private fork can be fetched) and fetched before
// git_branch is run.  git and git_branch are stand-ins: the player has no git
// tree here, and nothing is checked out.

test.skip(!container, 'stands in for git and git_branch inside the run-web.sh container');

const GIT_BRANCH = '/opt/fpp/scripts/git_branch';
const CONFIG_VERSION = '/etc/fpp/config_version';
const sh = (s: string) => inPlayer('sh', '-c', s);

let restoreSettings: () => void = () => {};
let configVersion: string | null = null;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  configVersion = exists(CONFIG_VERSION) ? readFile(CONFIG_VERSION) : null;
  sh(`[ -e ${GIT_BRANCH}.fpp-tests-real ] || mv ${GIT_BRANCH} ${GIT_BRANCH}.fpp-tests-real
      printf '%s\\n' '#!/bin/sh' 'echo "$(id -un) $*" >> /tmp/fpp-tests-git_branch.log' 'echo "fpp-tests git_branch $*"' > ${GIT_BRANCH}
      chmod 755 ${GIT_BRANCH}; rm -f /tmp/fpp-tests-git.log /tmp/fpp-tests-git_branch.log /tmp/fpp-tests-git.*`);
  // The PR's tree has migrations 97 to 101; 100 says what it does.
  putFile('/tmp/fpp-tests-git.tree', ['upgrade/97', 'upgrade/98', 'upgrade/99', 'upgrade/100', 'upgrade/101', 'upgrade/README.md'].join('\n') + '\n');
  standInCommand('git', `case "$*" in
  *" fetch "*) echo "fpp-tests fetched"; exit "$(cat /tmp/fpp-tests-git.fetchrc 2>/dev/null || echo 0)" ;;
  *" ls-tree "*) cat /tmp/fpp-tests-git.tree ;;
  *" show "*:upgrade/100/upgrade.sh*) printf '%s\\n' '#!/bin/bash' '# Upgrade 100: fpp-tests moves <apache> config' ;;
  *" show "*) echo '#!/bin/bash' ;;
  *" remote get-url "*) if [ -e /tmp/fpp-tests-git.hasremote ]; then echo https://github.com/x/fpp.git; else echo "error: No such remote"; exit 2; fi ;;
  *" remote "*) exit 0 ;;
  *) exec /usr/bin/git "$@" ;;
esac`);
});
test.afterEach(() => {
  sh(`if [ -e ${GIT_BRANCH}.fpp-tests-real ]; then mv -f ${GIT_BRANCH}.fpp-tests-real ${GIT_BRANCH}; fi
      rm -f /usr/local/bin/git /tmp/fpp-tests-git.log /tmp/fpp-tests-git_branch.log /tmp/fpp-tests-git.*`);
  if (configVersion === null) sh(`rm -f ${CONFIG_VERSION}`);
  else putFile(CONFIG_VERSION, configVersion);
  restoreSettings();
});

const gitCalls = () => commandLog('git').map((l) => l.replace(/^--git-dir=\S+ /, ''));
const gitBranchRuns = () => (exists('/tmp/fpp-tests-git_branch.log') ? readFile('/tmp/fpp-tests-git_branch.log').trim() : '');
const setConfigVersion = (v: string) => sh(`mkdir -p /etc/fpp && echo ${v} > ${CONFIG_VERSION}`);

test("a PR whose migrations this player hasn't run is not switched to until the warning is accepted", async ({ request }) => {
  setConfigVersion('99');
  const r = await request.get('/changebranch.php?branch=pull/42/head&remote=pull-requests', { timeout: 60_000 });
  const out = await r.text();
  expect(gitCalls()[0]).toBe('fetch origin +pull/42/head:refs/remotes/origin/pull/42/head');
  expect(out).toContain("PR #42 ADVANCES THIS DEVICE'S CONFIG VERSION");
  expect(out).toContain('This device is at config version 99.');
  // Only the two it hasn't run, in order, each with what it does if it says.
  expect(out).toContain('    upgrade/100 - fpp-tests moves &lt;apache&gt; config\n    upgrade/101\n');
  expect(out).not.toContain('upgrade/99');
  expect(out).toContain('action=\'changebranch.php?branch=pr-42&amp;remote=pull-requests&amp;pr=42&amp;ackcfg=1\'');
  expect(gitBranchRuns(), 'git_branch ran before the warning was accepted').toBe('');

  // Continue: switched to the PR's local branch.
  const go = await request.post('/changebranch.php?branch=pr-42&remote=pull-requests&pr=42&ackcfg=1', { timeout: 60_000 });
  const goOut = await go.text();
  expect(goOut).not.toContain('ADVANCES');
  expect(gitBranchRuns()).toBe('root pr-42 origin');
  expect(goOut).toContain('fpp-tests git_branch pr-42 origin');
});

for (const [what, version] of [['has run every migration the PR has', '101'], ['has no config version to compare with', '']] as const) {
  test(`a PR is switched to straight away on a player that ${what}`, async ({ request }) => {
    if (version) setConfigVersion(version);
    else sh(`rm -f ${CONFIG_VERSION}`);
    const out = await (await request.get('/changebranch.php?branch=pr-7&remote=pull-requests', { timeout: 60_000 })).text();
    expect(out).not.toContain('ADVANCES');
    expect(gitCalls()[0]).toBe('fetch origin +pull/7/head:refs/remotes/origin/pull/7/head');
    expect(gitBranchRuns()).toBe('root pr-7 origin');
  });
}

test('a PR that could not be fetched says so, and leaves git_branch to fail on it', async ({ request }) => {
  setConfigVersion('101');
  putFile('/tmp/fpp-tests-git.fetchrc', '1');
  const out = await (await request.get('/changebranch.php?branch=x&remote=pull-requests&pr=8', { timeout: 60_000 })).text();
  expect(out).toContain('Failed to fetch PR #8 from origin');
  expect(gitBranchRuns()).toBe('root pr-8 origin');
});

test('a PR switch without a PR number is refused before anything is fetched', async ({ request }) => {
  for (const q of ['branch=master&remote=pull-requests', 'branch=pull/abc/head&remote=pull-requests', 'branch=pr-0&remote=pull-requests', 'branch=master&remote=pull-requests&pr=-3']) {
    const r = await request.get(`/changebranch.php?${q}`);
    expect(r.status(), q).toBe(400);
    expect(await r.text()).toBe('Invalid PR number');
  }
  expect(exists('/tmp/fpp-tests-git.log') ? gitCalls() : []).toEqual([]);
  expect(gitBranchRuns()).toBe('');
});

test("the developer's fork is added as a remote with its token, fetched, then switched to", async ({ request }) => {
  setSettingInFile('gitHubUser', 'FppTestsDev');
  setSettingInFile('gitHubPAT', 'ghp_fpp/tests:tok');
  // The remote as the Developer tab names it, in any case.
  const out = await (await request.get('/changebranch.php?branch=feature/x&remote=fpptestsdev', { timeout: 60_000 })).text();
  expect(gitCalls()).toEqual([
    'remote get-url FppTestsDev',
    'remote add FppTestsDev https://FppTestsDev:ghp_fpp%2Ftests%3Atok@github.com/FppTestsDev/fpp.git',
    'fetch FppTestsDev',
  ]);
  expect(gitBranchRuns()).toBe('root feature/x FppTestsDev');
  // The token is not shown on the page.
  expect(out).not.toContain('ghp_fpp');
});

test("a fork remote already there gets the token put in its URL; without a token it's left as it is", async ({ request }) => {
  putFile('/tmp/fpp-tests-git.hasremote', '');
  setSettingInFile('gitHubUser', 'FppTestsDev');
  setSettingInFile('gitHubPAT', 'ghp_fpptests');
  await request.get('/changebranch.php?branch=main&remote=FppTestsDev', { timeout: 60_000 });
  expect(gitCalls()).toEqual([
    'remote get-url FppTestsDev',
    'remote set-url FppTestsDev https://FppTestsDev:ghp_fpptests@github.com/FppTestsDev/fpp.git',
    'fetch FppTestsDev',
  ]);
  sh('rm -f /tmp/fpp-tests-git.log');
  setSettingInFile('gitHubPAT', '');
  await request.get('/changebranch.php?branch=main&remote=FppTestsDev', { timeout: 60_000 });
  expect(gitCalls()).toEqual(['remote get-url FppTestsDev', 'fetch FppTestsDev']);
});

test("a remote that isn't the developer's fork is neither added nor fetched here", async ({ request }) => {
  setSettingInFile('gitHubUser', 'FppTestsDev');
  for (const remote of ['someoneelse', 'origin', 'newfeatures']) {
    await request.get(`/changebranch.php?branch=main&remote=${remote}`, { timeout: 60_000 });
  }
  expect(exists('/tmp/fpp-tests-git.log') ? gitCalls() : []).toEqual([]);
  expect(gitBranchRuns().split('\n')).toEqual(['root main someoneelse', 'root main origin', 'root main newfeatures']);
});
