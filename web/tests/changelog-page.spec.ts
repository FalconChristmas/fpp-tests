import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The ChangeLog page, which lists the commits of the player's own git
// checkout.  The player has none, so one is made for the test with three
// commits by two authors, and taken away after.

test.skip(!container, 'makes a git checkout in the run-web.sh container');

const COMMITS = [
  ['fpp-tests: first change, about outputs', 'Alice Example'],
  ['fpp-tests: second change, about playlists', 'Bob Example'],
  ['fpp-tests: third change, about outputs again', 'Alice Example'],
];

test.beforeEach(() => {
  const script = COMMITS.map(([msg, who], i) =>
    `GIT_COMMITTER_DATE=@${1790000000 + i * 60} GIT_AUTHOR_DATE=@${1790000000 + i * 60} ` +
    `git -c user.name='${who}' -c user.email=t@t commit -q --allow-empty -m '${msg}'`).join('\n');
  inPlayer('sh', '-c', `set -e; rm -rf /tmp/fpp-tests-git; git init -q -b fpp-tests /tmp/fpp-tests-git; cd /tmp/fpp-tests-git
    ${script}
    mv .git /opt/fpp/.git; cd /; rm -rf /tmp/fpp-tests-git /tmp/cache_local_git_* /tmp/cache_*changelog*`);
});

test.afterEach(() => inPlayer('sh', '-c', 'rm -rf /opt/fpp/.git /tmp/cache_local_git_* /tmp/cache_*changelog*'));

test('the ChangeLog lists the commits, filters them, and keeps its limit sane', async ({ page }) => {
  // Feature: d4e1157f7 ("Redesign changelog as a commit list with revert
  // modal").  The page was a table with no filter, and a limit of 0 or less
  // went into "head -<limit>" as it was.
  const shas = inPlayer('git', '--git-dir=/opt/fpp/.git', 'log', '--format=%h').trim().split('\n');
  await page.goto('/changelog.php');
  const rows = page.locator('#commitList .fpp-commit');
  await expect(rows).toHaveCount(3);
  // Newest first, as git log has them.
  await expect(rows.first().locator('.fpp-commit__subject')).toHaveText(COMMITS[2][0]);
  await expect(rows.first()).toHaveAttribute('data-sha', new RegExp(`^${shas[0]}`));
  const filter = async (q: string) => {
    await page.locator('#commitFilter').fill(q);
    return rows.evaluateAll((rs) => rs.filter((r) => (r as HTMLElement).offsetParent !== null).map((r) => r.querySelector('.fpp-commit__subject')!.textContent));
  };
  expect(await filter('playlists'), 'by message').toEqual([COMMITS[1][0]]);
  expect(await filter('alice'), 'by author').toEqual([COMMITS[2][0], COMMITS[0][0]]);
  expect(await filter(shas[2].slice(0, 7)), 'by SHA').toEqual([COMMITS[0][0]]);
  await expect(page.locator('#shownCount')).toHaveText('1');
  // A limit shorter than the history says so; one out of range is the default.
  await page.goto('/changelog.php?limit=2');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('body')).toContainText('(limited to 2)');
  for (const limit of ['0', '-5', '99999']) {
    await page.goto(`/changelog.php?limit=${limit}`);
    await expect(rows, `limit=${limit}`).toHaveCount(3);
  }
});
