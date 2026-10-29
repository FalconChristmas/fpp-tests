import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The Developer settings' Git Branch picker lists the branches of the remote
// picked above it (gitRemote: origin, newfeatures, a fork), and picking one
// switches to it through changebranch.php.  The branches come from a git
// repository put at /opt/fpp for the test (the served tree is an export, with
// none).  The switch itself is answered by the test, so the player's tree is
// never changed; changebranch.php's handling of remote= is
// multisync-branch-remote.spec.ts's and small-endpoints.spec.ts's.

test.skip(!container, 'puts a git repository in the run-web.sh container');

test.afterEach(() => {
  inPlayer('rm', '-rf', '/opt/fpp/.git');
});

test("switching to a newfeatures branch asks changebranch.php for that remote's branch", async ({ page }) => {
  // Regression: 2f2c69a4b.  ChangeGitBranch sent only the branch name, so
  // changebranch.php fetched and checked it out from origin, which has no
  // such branch, whatever remote the branch was listed from.
  inPlayer('sh', '-c', 'cd /opt/fpp && git init -q && c=$(git -c user.name=fpp-tests -c user.email=fpp-tests@invalid ' +
    'commit-tree $(git mktree < /dev/null) -m fpp-tests) && git update-ref refs/remotes/origin/master $c && ' +
    'git update-ref refs/remotes/newfeatures/fpp-tests-feature $c');
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '3');
    setSettingInFile('gitRemote', 'newfeatures');
    const asked: string[] = [];
    await page.route('**/changebranch.php*', (route) => {
      asked.push(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: '<html><body>fpp-tests: not switching</body></html>' });
    });
    page.on('dialog', (d) => d.accept());
    await page.goto('/settings.php#settings-developer');
    await expect(page.locator('#gitRemote')).toHaveValue('newfeatures', { timeout: 30_000 });
    // The control: the picker lists newfeatures' branch.
    await expect(page.locator('#gitBranch option[value="fpp-tests-feature"]')).toHaveCount(1, { timeout: 30_000 });
    await page.selectOption('#gitBranch', 'fpp-tests-feature');
    await expect.poll(() => asked.length, { timeout: 15_000 }).toBe(1);
    const url = new URL(asked[0]);
    expect(url.pathname).toBe('/changebranch.php');
    expect(url.searchParams.get('branch')).toBe('fpp-tests-feature');
    expect(url.searchParams.get('remote')).toBe('newfeatures');
  });
});
