import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings } from './privacy-helpers';
import { FakeGitHub } from './standin-http';

// The Developer settings' branch picker for a GitHub user's fork of fpp.  The
// fork's git remote is only made when a branch is switched to, so with a user
// and token freshly entered the player has no refs for it.  GitHub is a
// stand-in in the player (standin-http.ts), answering its API the way
// api.github.com does; github.com itself answers 404, so the remote's git
// fetch fails, as it does for a fork that cannot be fetched.  (The player
// has no git checkout, so the fork's git remote, which the fix also adds, is
// not checked here.)

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const USER = 'fpp-tests-fork';
const BRANCHES = [{ name: 'master' }, { name: 'fork-feature' }, { name: 'dependabot/npm_and_yarn/x' }, { name: 'v5.0' }];

let gh: FakeGitHub;

test.beforeEach(() => {
  gh = new FakeGitHub({
    [`/repos/${USER}/fpp`]: { json: { name: 'fpp', full_name: `${USER}/fpp`, fork: true } },
    [`/repos/${USER}/fpp/branches`]: { json: BRANCHES },
  });
  gh.start();
});

test.afterEach(() => gh?.stop());

test('the branch list of a GitHub user fork is filled in when the fork has no refs here', async ({ page, request }) => {
  // Regression: 0a4c0cf2c ("Empty branch dropdown when GitHub User Fork
  // remote is selected").  The branches came from the fork's local refs
  // alone, which do not exist until a branch has been switched to.
  await keepingSettings(async () => {
    for (const [name, value] of [['gitHubUser', USER], ['gitHubPAT', 'fpp-tests-token'], ['uiLevel', '3']]) {
      expect((await request.put(`/api/settings/${name}?skipBackup=1`, { data: value })).ok()).toBe(true);
    }
    const r = await request.get(`/api/git/branches?remote=${USER}`, { timeout: 120_000 });
    expect(r.ok(), await r.text()).toBe(true);
    // The fork's branches, as GitHub lists them, without the ones the
    // picker never offers.
    expect((await r.json()).sort()).toEqual(['fork-feature', 'master']);
    expect(gh.requests().map((q) => q.path)).toContain(`/repos/${USER}/fpp/branches?per_page=100`);

    // And the Developer settings page offers them for the fork.
    await page.goto('/settings.php#settings-developer');
    const fork = page.locator(`#gitRemote option[value="${USER}"]`);
    await expect(fork).toHaveAttribute('data-fork', '1', { timeout: 30_000 });
    await page.locator('#gitRemote').selectOption(USER);
    await expect(page.locator('#gitBranch option[value="fork-feature"]')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.locator('#gitBranch option[value^="dependabot/"]')).toHaveCount(0);
  });
});
