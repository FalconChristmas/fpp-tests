import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings } from './privacy-helpers';
import { FakeGitHub } from './standin-http';

// The Developer settings' GitHub endpoints: api/git/forkBranches (does the
// user's fork of fpp exist, and which branches does it have) and
// api/git/pullRequests (the open pull requests, for the "Pull Requests"
// Git Remote).  GitHub is a stand-in in the player (standin-http.ts).

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const USER = 'fpp-tests-fork';
const PAT = 'fpp-tests-token';
const PR_CACHE = '/tmp/cache_git_pull_requests.cache*';

let gh: FakeGitHub;
const clearPrCache = () => inPlayer('sh', '-c', `rm -f ${PR_CACHE}`);

test.beforeEach(() => clearPrCache());
test.afterEach(() => {
  gh?.stop();
  clearPrCache();
});

async function setSettings(request: import('@playwright/test').APIRequestContext, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    expect((await request.put(`/api/settings/${name}?skipBackup=1`, { data: value })).ok()).toBe(true);
  }
}

test('forkBranches reports the fork and its branches from the saved GitHub user and token', async ({ request }) => {
  // Regression: d438be66a.  The Developer settings page offers a "switch to
  // fork branch" list when the saved GitHub user has a fork of fpp, and it
  // asks api/git/forkBranches whether there is one.
  gh = new FakeGitHub({
    [`/repos/${USER}/fpp`]: { json: { name: 'fpp', full_name: `${USER}/fpp`, fork: true } },
    [`/repos/${USER}/fpp/branches`]: { json: [{ name: 'master' }, { name: 'zz-feature' }, { name: 'dependabot/npm/x' }, { name: 'v5.0' }] },
  });
  gh.start();
  await keepingSettings(async () => {
    await setSettings(request, { gitHubUser: USER, gitHubPAT: PAT });
    const r = await request.get('/api/git/forkBranches', { timeout: 60_000 });
    expect(r.ok(), await r.text()).toBe(true);
    // Sorted, without the obsolete-version and dependabot branches.
    expect(await r.json()).toEqual({ hasFork: true, user: USER, branches: ['master', 'zz-feature'] });
    // The receiving end: GitHub was asked for that user's repo and branches,
    // with the saved token.
    const asked = gh.requests();
    expect(asked.map((q) => q.path)).toEqual([`/repos/${USER}/fpp`, `/repos/${USER}/fpp/branches?per_page=100`]);
    expect(asked.every((q) => q.auth === `token ${PAT}`)).toBe(true);
  });
});

test('forkBranches says there is no fork without asking GitHub when no token is saved, and when GitHub has none', async ({ request }) => {
  // Regression: d438be66a.  An unreachable GitHub or a missing repo is
  // hasFork false, not an error, and the credentials must both be set before
  // GitHub is asked at all.
  gh = new FakeGitHub({});
  gh.start();
  await keepingSettings(async () => {
    await setSettings(request, { gitHubUser: USER, gitHubPAT: '' });
    let r = await request.get('/api/git/forkBranches', { timeout: 60_000 });
    expect(r.ok(), await r.text()).toBe(true);
    expect(await r.json()).toEqual({ hasFork: false, user: USER, branches: [] });
    expect(gh.requests()).toEqual([]);

    // With a token, a user GitHub has no fpp repo for (404, no local remote
    // of that name either).
    await setSettings(request, { gitHubPAT: PAT });
    r = await request.get('/api/git/forkBranches', { timeout: 60_000 });
    expect(r.ok(), await r.text()).toBe(true);
    expect(await r.json()).toEqual({ hasFork: false, user: USER, branches: [] });
    expect(gh.requests().map((q) => q.path)).toEqual([`/repos/${USER}/fpp`]);
  });
});

const PULLS = [
  { number: 3001, title: 'Fix a thing', user: { login: 'alice' }, head: { ref: 'fix/thing', sha: 'abc123', repo: { full_name: 'alice/fpp' } }, html_url: 'https://github.com/FalconChristmas/fpp/pull/3001', draft: false },
  // The fork was deleted (head.repo null), the PR is a draft and has no user.
  { number: 3002, title: 'Draft work', user: null, head: { ref: 'wip', sha: 'def456', repo: null, user: { login: 'bob' } }, draft: true },
];
const PULLS_PATH = '/repos/FalconChristmas/fpp/pulls';

test('pullRequests maps the open pull requests, caches them, and the Developer page lists them as #NUM - USER', async ({ page, request }) => {
  // Regression: fed49ecfd.  A Git Remote of "Pull Requests" fills the Branch
  // dropdown from api/git/pullRequests, which proxies GitHub's open pulls
  // (the browser does not call api.github.com) and keeps the answer 60s so
  // every page load does not use up GitHub's rate limit.
  gh = new FakeGitHub({ [PULLS_PATH]: { json: PULLS } });
  gh.start();
  await keepingSettings(async () => {
    await setSettings(request, { gitHubPAT: PAT, uiLevel: '3' });
    const r = await request.get('/api/git/pullRequests', { timeout: 60_000 });
    expect(r.ok(), await r.text()).toBe(true);
    expect(await r.json()).toEqual([
      { number: 3001, title: 'Fix a thing', user: 'alice', headRef: 'fix/thing', headRepo: 'alice/fpp', headSha: 'abc123', htmlUrl: 'https://github.com/FalconChristmas/fpp/pull/3001', draft: false },
      { number: 3002, title: 'Draft work', user: 'bob', headRef: 'wip', headRepo: '', headSha: 'def456', htmlUrl: 'https://github.com/FalconChristmas/fpp/pull/3002', draft: true },
    ]);
    // The receiving end: GitHub got the open-pulls query with the token.
    const asked = gh.requests();
    expect(asked.map((q) => q.path)).toEqual([`${PULLS_PATH}?state=open&per_page=100&sort=updated&direction=desc`]);
    expect(asked[0].auth).toBe(`token ${PAT}`);

    // Cached: a second ask does not go back to GitHub.
    expect((await (await request.get('/api/git/pullRequests')).json()).length).toBe(2);
    expect(gh.requests().length).toBe(1);

    // The Developer settings page, with Pull Requests as the remote.
    await setSettings(request, { gitRemote: 'pull-requests' });
    await page.goto('/settings.php?tab=Developer');
    const opts = page.locator('#gitBranch option[data-pr]');
    await expect(opts).toHaveCount(2, { timeout: 30_000 });
    await expect(opts.nth(0)).toHaveText('#3001 - alice');
    await expect(opts.nth(0)).toHaveAttribute('value', 'pr-3001');
    await expect(opts.nth(1)).toHaveText('[Draft] #3002 - bob');
  });
});

test('pullRequests retries without the token when GitHub refuses it, instead of reporting no pull requests', async ({ request }) => {
  // Regression: fed49ecfd.  An expired or revoked token gets 401 even though
  // the public list is open; the fetch is tried again with no token.
  gh = new FakeGitHub({ [PULLS_PATH]: { status: 401, json: { message: 'Bad credentials' } } });
  gh.start();
  await keepingSettings(async () => {
    await setSettings(request, { gitHubPAT: PAT });
    const r = await request.get('/api/git/pullRequests', { timeout: 60_000 });
    expect(r.ok(), await r.text()).toBe(true);
    // Nothing usable came back from either try, so it is an empty list.
    expect(await r.json()).toEqual([]);
    const asked = gh.requests();
    expect(asked.map((q) => q.auth)).toEqual([`token ${PAT}`, '']);
  });
});
