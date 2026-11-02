import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { writeFile } from './privacy-helpers';

// Scripts and pages that run commands through sudo, from the inside of the
// run-web.sh container: what they ran is what stand-ins on the path record.

test.skip(!container, 'runs scripts inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const GROWPART = '/usr/bin/bb-growpart';
const SYSTEMCTL = '/usr/local/bin/systemctl';
const LOG = '/tmp/fpp-tests-sudo-calls.log';
const STUBS = '/tmp/fpp-tests-sudo-stubs';

const present = (path: string) => inPlayer('sh', '-c', `test -e ${path} && echo yes || echo no`).trim() === 'yes';
const calls = () => inPlayer('cat', LOG).split('\n').filter((l) => l);

test.afterEach(() => {
  inPlayer('sh', '-c', `rm -rf ${STUBS} ${LOG}`);
});

test('the grow-partition page runs the BeagleBone grow and then enables the resize service', async ({ request }) => {
  // Regression: 9fd5af827.  growsd.php had lost the ";" after its second
  // command, so the whole page was a PHP parse error: the Grow Partition
  // button on a BeagleBone's Storage Settings got a 500 and nothing was
  // grown.  The commands are stand-ins that record themselves.
  // Also 2ae382565: the enable command read "systemctl enable enable
  // resize_filesystem.service", which systemd refuses; the recorded call
  // has to be the plain "enable resize_filesystem.service".
  test.skip(present(GROWPART) || present(SYSTEMCTL), 'the player has its own bb-growpart or a systemctl in /usr/local/bin');
  const hadPlatform = present(PLATFORM);
  try {
    inPlayer('mkdir', '-p', '/etc/fpp');
    if (hadPlatform) inPlayer('cp', PLATFORM, `${PLATFORM}.fpp-tests`);
    writeFile(PLATFORM, 'BeagleBone Black');
    writeFile(GROWPART, `#!/bin/sh\necho "bb-growpart stand-in ran" >> ${LOG}\necho growing\n`);
    writeFile(SYSTEMCTL, `#!/bin/sh\necho "systemctl $*" >> ${LOG}\n`);
    inPlayer('chmod', '755', GROWPART, SYSTEMCTL);

    const r = await request.post('/growsd.php');
    const body = await r.text();
    expect(r.status(), body.slice(0, 500)).toBe(200);
    expect(body).toMatch(/^Command: sudo \/usr\/bin\/bb-growpart/);
    expect(body).toContain('growing');
    // The receiving end: the stand-ins were run, the second one with the right words.
    expect(calls()).toEqual(['bb-growpart stand-in ran', 'systemctl enable resize_filesystem.service']);
  } finally {
    inPlayer('sh', '-c', `rm -f ${GROWPART} ${SYSTEMCTL}; if [ -e ${PLATFORM}.fpp-tests ]; then mv ${PLATFORM}.fpp-tests ${PLATFORM}; else rm -f ${PLATFORM}; fi`);
  }
});

test("a script run through the default $SUDO keeps its caller's environment", async () => {
  // Regression: 9fd5af827.  scripts/common's default SUDO became "sudo -E":
  // plugin install scripts are started through $SUDO and read FPPDIR and
  // SRCDIR from their environment, which plain sudo drops (env_reset), so a
  // C++ plugin's install built against nothing.
  const out = inPlayer('env', '-u', 'SUDO', 'FPPTESTS_X=kept', 'bash', '-c',
    '. /opt/fpp/scripts/common; echo "SUDO=[$SUDO]"; export FPPTESTS_X; $SUDO sh -c \'echo "got=$FPPTESTS_X"\'');
  expect(out).toContain('SUDO=[sudo -E]');
  expect(out).toContain('got=kept');
});

test('git_origin_log asks for the branch through sudo, as it does for the log', async () => {
  // Regression: 2360be424.  The Preview Changes list (Update dialog) ran its
  // "git branch" as the web user while "git log" ran through $SUDO, and a
  // checkout that user can't read (git refuses another user's repository)
  // gave an empty branch name, so the list was always empty.  A stand-in for
  // sudo records what it was asked to run; the repository is one commit behind
  // its origin.
  inPlayer('rm', '-rf', '/opt/fpp/.git');
  try {
    const G = 'git -c user.name=fpp-tests -c user.email=fpp-tests@invalid';
    inPlayer('sh', '-c', `cd /opt/fpp && git init -q -b master && a=$(${G} commit-tree $(git mktree < /dev/null) -m base) && ` +
      `git update-ref refs/heads/master $a && ` +
      `b=$(${G} commit-tree $(git mktree < /dev/null) -p $a -m 'fix: the new commit') && git update-ref refs/remotes/origin/master $b`);
    inPlayer('mkdir', '-p', STUBS);
    writeFile(`${STUBS}/sudo`, `#!/bin/sh\necho "sudo $*" >> ${LOG}\nexec "$@"\n`);
    inPlayer('chmod', '755', `${STUBS}/sudo`);
    inPlayer('rm', '-f', LOG);
    // The script takes its sudo from $SUDO (scripts/common puts its own
    // directories ahead of any stand-in on the path).
    const out = inPlayer('env', `SUDO=${STUBS}/sudo`, 'FPPDIR=/opt/fpp', 'bash', '/opt/fpp/scripts/git_origin_log');
    // The receiving end: the list is the new commit.
    expect(out).toContain('fix: the new commit');
    expect(calls(), 'git branch was not run through sudo').toContain('sudo git branch');
    expect(calls().filter((c) => c.startsWith('sudo git log')).length).toBe(1);
  } finally {
    inPlayer('rm', '-rf', '/opt/fpp/.git');
  }
});
