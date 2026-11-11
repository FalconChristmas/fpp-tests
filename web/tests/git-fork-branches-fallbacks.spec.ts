import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { FakeHttps, Route } from './fake-https';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The Developer tab's fork branch list (GET /api/git/forkBranches) past its
// plain answer: what it does when GitHub can't be reached, has no such
// repository or won't list the branches (it reads the branches of a remote
// named after the user in the player's own checkout), which branches it
// hides, and a saved token that would add headers of its own.  GitHub is an
// HTTPS stand-in; the tree under test is an export, so the test gives it a
// repository.

test.skip(!container, 'stands in for GitHub inside the run-web.sh container');

const USER = 'fpp-tests-dev';
const REPO = `api.github.com /repos/${USER}/fpp`;
const BRANCHES = `${REPO}/branches?per_page=100`;
const FORK: Route = { json: { name: 'fpp', full_name: `${USER}/fpp`, fork: true } };
const NONE = { hasFork: false, user: USER, branches: [] };

let fake: FakeHttps;
let restore: () => void = () => {};
test.beforeAll(() => {
  fake = new FakeHttps(['api.github.com']);
  fake.start();
});
test.afterAll(() => fake.stop());
test.beforeEach(() => {
  restore = snapshotSettings();
  setSettingInFile('gitHubUser', USER);
  setSettingInFile('gitHubPAT', 'fpp-tests-token');
  inPlayer('rm', '-rf', '/opt/fpp/.git');
  fake.clearLog();
});
test.afterEach(() => {
  restore();
  inPlayer('rm', '-rf', '/opt/fpp/.git');
});

// A checkout with remote-tracking branches: the user's (one of each kind the
// list hides among them, and the remote's HEAD) and someone else's.
function checkout(remoteBranches: string[], withRemote = true) {
  const refs = remoteBranches.map((b) => `git update-ref refs/remotes/${b} $c`).join(' && ');
  inPlayer('sh', '-c', 'set -e; cd /opt/fpp; git init -q -b master; ' +
    'c=$(git -c user.name=fpp-tests -c user.email=fpp-tests@invalid commit-tree $(git mktree < /dev/null) -m base); ' +
    'git update-ref refs/heads/master $c; ' +
    (withRemote ? `git remote add ${USER} https://github.com/${USER}/fpp.git; ` : '') +
    (refs ? `${refs}; ` : '') +
    (remoteBranches.includes(`${USER}/alpha`) ? `git symbolic-ref refs/remotes/${USER}/HEAD refs/remotes/${USER}/alpha; ` : '') +
    'true');
}
const LOCAL = [`${USER}/zeta`, `${USER}/alpha`, `${USER}/v5.x-old`, `${USER}/dependabot/npm/thing`, 'someone-else/feature'];

async function forkBranches(request: import('@playwright/test').APIRequestContext) {
  return (await request.get('/api/git/forkBranches', { timeout: 60_000 })).json();
}

test('a token with a carriage return in it is not sent to GitHub', async ({ request }) => {
  fake.routes({ [REPO]: FORK, [BRANCHES]: { json: [{ name: 'fpp-tests-feature' }] } });
  // The control: with a good token GitHub is asked, with it.
  expect(await forkBranches(request)).toEqual({ hasFork: true, user: USER, branches: ['fpp-tests-feature'] });
  expect(fake.requests().map((q) => q.authorization)).toEqual(['token fpp-tests-token', 'token fpp-tests-token']);

  // The settings file is read a line at a time and a save refuses a line
  // break, so a lone carriage return in a hand-edited (or restored) file is
  // the one that reaches the header.
  fake.clearLog();
  setSettingInFile('gitHubPAT', 'fpp-tests-token\rX-Fpp-Tests: injected');
  expect(await forkBranches(request)).toEqual(NONE);
  expect(fake.requests()).toEqual([]);
});

test('GitHub out of reach: the fork is the remote named after the user, if the checkout has one', async ({ request }) => {
  fake.down();
  try {
    // No checkout at all, then a checkout without the remote.
    expect(await forkBranches(request)).toEqual(NONE);
    checkout(['someone-else/feature'], false);
    expect(await forkBranches(request)).toEqual(NONE);

    inPlayer('rm', '-rf', '/opt/fpp/.git');
    checkout(LOCAL);
    // The remote's own branches, sorted; old release branches, dependabot's
    // and the HEAD pointer are left out.
    expect(await forkBranches(request)).toEqual({ hasFork: true, user: USER, branches: ['alpha', 'zeta'] });
  } finally {
    fake.start();
  }
});

test('GitHub has no such repository: a local remote still counts, once it has branches', async ({ request }) => {
  fake.routes({});
  checkout([]);
  expect(await forkBranches(request)).toEqual(NONE);
  inPlayer('rm', '-rf', '/opt/fpp/.git');
  checkout(LOCAL);
  expect(await forkBranches(request)).toEqual({ hasFork: true, user: USER, branches: ['alpha', 'zeta'] });
  expect(fake.requests().map((q) => q.path)).toEqual([`/repos/${USER}/fpp`, `/repos/${USER}/fpp`]);
});

test('GitHub refuses, or answers something that is not a repository: no fork, and the checkout is not consulted', async ({ request }) => {
  checkout(LOCAL);
  for (const repo of [{ status: 403, json: { message: 'rate limit' } }, { status: 500, body: 'oops' }, { json: { message: 'moved' } }, { body: '<html>' }] as Route[]) {
    fake.routes({ [REPO]: repo });
    expect(await forkBranches(request), JSON.stringify(repo)).toEqual(NONE);
  }
});

test('the repository exists but GitHub will not list its branches: the fork is there, with the branches the checkout has', async ({ request }) => {
  fake.routes({ [REPO]: FORK, [BRANCHES]: { status: 403, json: { message: 'rate limit' } } });
  // No checkout to read: still a fork, with nothing to offer.
  expect(await forkBranches(request)).toEqual({ hasFork: true, user: USER, branches: [] });
  checkout(LOCAL);
  expect(await forkBranches(request)).toEqual({ hasFork: true, user: USER, branches: ['alpha', 'zeta'] });

  // A branch list that is not JSON.
  fake.routes({ [REPO]: FORK, [BRANCHES]: { body: 'not json' } });
  expect(await forkBranches(request)).toEqual({ hasFork: true, user: USER, branches: [] });
});

test('GitHub\'s branch list is shown sorted, without old release branches and dependabot\'s', async ({ request }) => {
  fake.routes({
    [REPO]: FORK,
    [BRANCHES]: {
      json: [
        { name: 'zeta' }, { name: 'v1.x' }, { name: 'v2.5' }, { name: 'v3.x' }, { name: 'v4.6' }, { name: 'v5.x' }, { name: 'v6.3' },
        { name: 'v7.x' }, { name: 'dependabot/npm_and_yarn/x' }, { commit: {} }, { name: 'master' }, { name: 'alpha' },
      ],
    },
  });
  expect(await forkBranches(request)).toEqual({ hasFork: true, user: USER, branches: ['alpha', 'master', 'v7.x', 'zeta'] });
});

test('a user name GitHub could not have is not asked about', async ({ request }) => {
  fake.routes({ [REPO]: FORK, [BRANCHES]: { json: [{ name: 'master' }] } });
  for (const user of ['-leading', 'trailing-', 'has space', 'a/b', 'x'.repeat(40)]) {
    setSettingInFile('gitHubUser', user);
    expect(await forkBranches(request), user).toEqual({ hasFork: false, user, branches: [] });
  }
  expect(fake.requests()).toEqual([]);
});
