import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// GET /api/git/originLog lists the commits origin has that this checkout
// does not, each as {hash, author, date, msg} (Feature: e27c6d8b1 added the
// author), from a git repository put at /opt/fpp for the test (the served
// tree is an export, with none).

test.skip(!container, 'puts a git repository in the run-web.sh container');

test.afterEach(() => {
  inPlayer('rm', '-rf', '/opt/fpp/.git');
});

test('origin\'s new commits come back with hash, author, date and message', async ({ request }) => {
  const G = 'git -c user.name=fpp-tests -c user.email=fpp-tests@invalid';
  inPlayer('sh', '-c', `cd /opt/fpp && git init -q -b master && a=$(${G} commit-tree $(git mktree < /dev/null) -m base) && ` +
    `git update-ref refs/heads/master $a && ` +
    `b=$(GIT_AUTHOR_NAME='Pat Tester' GIT_AUTHOR_DATE='2026-03-04T10:00:00' ${G} commit-tree $(git mktree < /dev/null) -p $a -m 'fix: first new commit') && ` +
    `c=$(GIT_AUTHOR_NAME='Sam Writer' GIT_AUTHOR_DATE='2026-03-05T10:00:00' ${G} commit-tree $(git mktree < /dev/null) -p $b -m 'feat: second new commit') && ` +
    `git update-ref refs/remotes/origin/master $c`);
  const body = await (await request.get('/api/git/originLog')).json();
  expect(body.status).toBe('OK');
  expect(body.rows.map((r: any) => [r.author, r.date, r.msg])).toEqual([
    ['Sam Writer', '2026-03-05', 'feat: second new commit'],
    ['Pat Tester', '2026-03-04', 'fix: first new commit'],
  ]);
  for (const r of body.rows) expect(r.hash).toMatch(/^[0-9a-f]{40}$/);
});

test('the branch list holds the remote\'s usable branches and leaves out dependabot\'s and the very old ones', async ({ request }) => {
  // Feature: 3b4e49591 (git_fetch / git_branch; the list is from the remote's
  // branches).
  inPlayer('sh', '-c', 'cd /opt/fpp && git init -q -b master && c=$(git -c user.name=fpp-tests -c user.email=fpp-tests@invalid ' +
    'commit-tree $(git mktree < /dev/null) -m x) && for b in master aaa-fpp-tests dependabot/npm/foo v5.x v6.x v9.x; do git update-ref refs/remotes/origin/$b $c; done');
  const branches: string[] = await (await request.get('/api/git/branches')).json();
  expect(branches).toEqual(expect.arrayContaining(['master', 'aaa-fpp-tests', 'v9.x']));
  expect(branches.filter((b) => b.startsWith('dependabot/') || b === 'v5.x' || b === 'v6.x')).toEqual([]);
});
