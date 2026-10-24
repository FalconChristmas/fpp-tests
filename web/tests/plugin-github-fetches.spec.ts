import { test, expect } from './fixtures';
import { container } from './container';
import { PLUGINS, PluginRepo, exists, pluginInfo, restoreState, saveState, sh } from './plugin-repo';
import { FakeHttps, credentials } from './fake-https';
import { routePluginList } from './plugin-backfill';

// What the plugin manager fetches from GitHub on the user's behalf -- clones
// with the Developer settings' GitHub credentials, pluginInfo.json for a
// private repository, a plugin's icon, open issue and PR counts -- answered
// by a stand-in for GitHub's hosts inside the player.

test.skip(!container, 'stands in for GitHub inside the run-web.sh container');
test.describe.configure({ mode: 'serial' });

const OTHER = 'git.fpp-tests.example';
const HOSTS = ['github.com', 'api.github.com', 'raw.githubusercontent.com', OTHER];
const USER = 'fpp-tests-user';
const PAT = 'fpp-tests-pat-0123456789';
const REPO = 'fpp-tests-private';

let fake: FakeHttps;

test.beforeEach(() => {
  fake = new FakeHttps(HOSTS);
  fake.start();
});

test.afterEach(async ({ request }) => {
  fake.stop();
  for (const key of ['gitHubUser', 'gitHubPAT']) {
    await request.put(`/api/settings/${key}`, { data: '' });
  }
  sh(`rm -rf '${PLUGINS}/${REPO}' '${PLUGINS}/fpp-tests-icon-url' /tmp/cache_plugin_icon_fpp-tests-* /tmp/cache_github_*`);
});

async function setCredentials(request: any) {
  for (const [key, value] of [['gitHubUser', USER], ['gitHubPAT', PAT]]) {
    const r = await request.put(`/api/settings/${key}`, { data: value });
    expect(r.ok(), `PUT /api/settings/${key}`).toBe(true);
  }
}

// A private repository on each host, served to git behind Basic auth as
// USER:PAT: a plugin with an install script and a PHP API endpoint, so an
// install that got in can be seen to load and run.
const ROOT = '/tmp/fpp-tests-ghroot';
const MARKER = '/tmp/fpp-tests-ghroot-installed';
function privateRepos() {
  const repo = new PluginRepo(REPO);
  repo.commit({
    'pluginInfo.json': pluginInfo(REPO),
    'scripts/fpp_install.sh': { content: `#!/bin/sh\ntouch ${MARKER}\n`, mode: '755' },
    'api.php': `<?php
function getEndpointsfpptestsprivate() {
    return array(array('method' => 'GET', 'endpoint' => 'hello', 'callback' => 'fppTestsPrivateHello'));
}
function fppTestsPrivateHello() { return 'fpp-tests private plugin'; }
`,
  });
  sh(`set -e; rm -rf ${ROOT} ${MARKER}; mkdir -p ${ROOT}/fpp-tests
    git clone -q --bare ${repo.bare} ${ROOT}/fpp-tests/${REPO}.git`);
  repo.remove();
  fake.routes({
    'git github.com': { root: ROOT, user: `${USER}:${PAT}` },
    [`git ${OTHER}`]: { root: ROOT, user: `${USER}:${PAT}` },
  });
}

async function install(request: any, srcURL: string, extra: Record<string, unknown> = {}) {
  const r = await request.post('/api/plugin', {
    data: { name: REPO, repoName: REPO, srcURL, branch: 'master', sha: '', ...extra }, timeout: 120_000,
  });
  return r.text();
}

// What each host was sent: the credentials of every request to it.
function sentTo(host: string): string[] {
  return fake.requests().filter((r) => r.host === host).map((r) => credentials(r.authorization));
}

for (const [label, extra] of [
  ['with Use Credentials', { useCredentials: 1 }],
  ['without Use Credentials', {}],
] as const) {
  test(`a plugin cloned from github.com ${label} is fetched with the GitHub credentials, and another host never gets them`, async ({ request }) => {
    // Feature: e59ef994d (a GitHub user and Personal Access Token on the
    // Developer settings page, put into a github.com clone URL when the
    // install asks for credentials).  Regression: ee492b8e3 (they are used
    // for every github.com URL once configured, as the Plugins page's own
    // fetches already did, rather than only when "Use Credentials" was
    // ticked).  Never for a host that is not GitHub's.  The receiving end:
    // the private repository really clones with them, and the installed
    // plugin's install script ran and its API endpoint answers.
    saveState();
    try {
      privateRepos();
      await setCredentials(request);

      const out = await install(request, `https://github.com/fpp-tests/${REPO}.git`, extra);
      const github = sentTo('github.com');
      // The control: git really asked github.com.
      expect(github.length, `requests to github.com; install said: ${out.slice(0, 500)}`).toBeGreaterThan(0);
      expect(github, 'the credentials sent to github.com').toContain(`${USER}:${PAT}`);
      expect(exists(MARKER), `the plugin's install script ran; install said: ${out.slice(0, 500)}`).toBe(true);
      const hello = await request.get(`/api/plugin/${REPO}/hello`);
      expect(await hello.text(), "the installed plugin's endpoint").toBe('fpp-tests private plugin');
      // The PAT stays out of the install's reply, the logs and the install
      // history.  (The clone's own .git/config keeps it in origin's URL, for
      // the updates' pulls.)
      expect(out, 'the install reply').not.toContain(PAT);
      expect(sh(`grep -rlF '${PAT}' /home/fpp/media/logs /home/fpp/media/config/pluginHistory.jsonl 2>/dev/null || true`).trim(),
        'files that keep the PAT').toBe('');

      fake.clearLog();
      sh(`rm -rf '${PLUGINS}/${REPO}' ${MARKER}`);
      const other = await install(request, `https://${OTHER}/fpp-tests/${REPO}.git`, extra);
      const elsewhere = sentTo(OTHER);
      expect(elsewhere.length, `requests to ${OTHER}; install said: ${other.slice(0, 500)}`).toBeGreaterThan(0);
      expect(elsewhere.filter((c) => c !== ''), `credentials sent to ${OTHER}`).toEqual([]);
      expect(exists(MARKER), `a clone ${OTHER} refused was installed`).toBe(false);
    } finally {
      sh(`rm -rf ${ROOT} ${MARKER}`);
      restoreState([REPO]);
    }
  });
}

test("a private pluginInfo.json the PAT can't fetch is fetched with its share-link token", async ({ request }) => {
  // Regression: f2fb63b09.  POST /api/plugin/fetchInfo with credentials
  // strips GitHub's "Raw" share-link token (?token=GHSAT...) and fetches
  // with the PAT instead, from raw.githubusercontent.com and then the
  // Contents API; when the PAT was refused there (expired, or without access
  // to the repo) it gave up, though the URL's own token would have worked.
  // Now that token is tried last, without the PAT.
  const info = { repoName: REPO, name: 'fpp-tests private plugin', versions: [] };
  const path = `/fpp-tests/${REPO}/master/pluginInfo.json`;
  const refused = { status: 401, json: { message: 'Bad credentials' } };
  fake.routes({
    [`raw.githubusercontent.com ${path}?token=GHSATFPPTESTS`]: { noAuth: { json: info }, auth: refused },
    [`raw.githubusercontent.com ${path}`]: refused,
    [`api.github.com /repos/fpp-tests/${REPO}/contents/pluginInfo.json`]: refused,
  });
  await setCredentials(request);

  const r = await request.post('/api/plugin/fetchInfo', {
    data: { url: `https://raw.githubusercontent.com${path}?token=GHSATFPPTESTS`, useCredentials: 1 }, timeout: 60_000,
  });
  const body = await r.json();
  const sent = fake.requests().map((q) => `${q.host} ${q.path} [${credentials(q.authorization)}]`);
  // The control: the PAT was tried first, and refused.
  expect(sent, 'the requests made').toContain(`raw.githubusercontent.com ${path} [${PAT}]`);
  expect(body, sent.join('\n')).toEqual(info);
  expect(sent, 'the share-link fetch carried no PAT').toContain(`raw.githubusercontent.com ${path}?token=GHSATFPPTESTS []`);
});

test("a plugin with no icon.png serves the image its pluginInfo.json's iconURL names", async ({ page, request }) => {
  // Feature: e55a9d954.  GET /api/plugin/<name>/icon served only the
  // plugin's own icon.png and answered 404 without one; now it falls back to
  // fetching pluginInfo.json's iconURL itself (the page's CSP keeps an <img>
  // from loading it from GitHub directly).
  const NAME = 'fpp-tests-icon-url';
  // A 1x1 PNG.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const iconPath = `/fpp-tests/${NAME}/master/icon.png`;
  fake.routes({ [`raw.githubusercontent.com ${iconPath}`]: { b64: png, contentType: 'image/png' } });
  sh(`mkdir -p '${PLUGINS}/${NAME}' && cat > '${PLUGINS}/${NAME}/pluginInfo.json' <<'JSON'
${JSON.stringify({ name: NAME, repoName: NAME, iconURL: `https://raw.githubusercontent.com${iconPath}`, versions: [] })}
JSON`);

  const r = await request.get(`/api/plugin/${NAME}/icon`, { timeout: 30_000 });
  expect(r.status(), JSON.stringify(fake.requests())).toBe(200);
  expect(Buffer.from(await r.body()).toString('base64')).toBe(png);
  expect(r.headers()['content-type']).toMatch(/^image\/png/);
  // The control: the image came from the iconURL.
  expect(fake.requests().map((q) => `${q.host} ${q.path}`)).toContain(`raw.githubusercontent.com ${iconPath}`);

  // The receiving end: the image the Plugins page's card for it points at
  // decodes in the browser.  (Loaded afresh rather than waited for in the
  // card, which may sit on a tab that isn't showing.)
  await routePluginList(page);
  await page.goto('/plugins.php');
  const img = page.locator(`[id="row-${NAME}"] img.pluginIcon`).first();
  await expect(img).toBeAttached({ timeout: 20_000 });
  const width = await img.evaluate(async (i: HTMLImageElement) => {
    const copy = new Image();
    copy.src = i.src;
    try { await copy.decode(); } catch { return -1; }
    return copy.naturalWidth;
  });
  expect(width, "the card's icon").toBe(1);
});

test("the plugin cards' open issue and PR counts come from one GitHub search, and none when GitHub can't be reached", async ({ request }) => {
  // Feature: 9fa1a49b4.  GET /api/plugin/githubStats?repos=owner/name,...
  // answers each repo's open issues and PRs, counted from GitHub's issue
  // search with one query for all of them (not a request per plugin), and
  // when GitHub can't be reached it answers no counts, so the cards show
  // none rather than zeros.
  const CACHE = '/home/fpp/media/tmp/pluginGithubStats.cache.json';
  sh(`if [ -e ${CACHE} ]; then mv ${CACHE} ${CACHE}.fpp-tests; fi`);
  try {
    const item = (repo: string, pull = false) => ({
      repository_url: `https://api.github.com/repos/${repo}`, ...(pull ? { pull_request: { url: 'x' } } : {}),
    });
    fake.routes({
      'api.github.com /search/issues': {
        json: { total_count: 4, items: [item('fpp-tests/stats-a'), item('fpp-tests/stats-a', true), item('fpp-tests/stats-a'), item('fpp-tests/stats-b', true)] },
      },
    });
    const r = await request.get('/api/plugin/githubStats?repos=fpp-tests/stats-a,fpp-tests/stats-b,fpp-tests/stats-quiet', { timeout: 60_000 });
    const body = await r.json();
    expect(body.repos, JSON.stringify(body)).toEqual({
      'fpp-tests/stats-a': { openIssues: 2, openPRs: 1 },
      'fpp-tests/stats-b': { openIssues: 0, openPRs: 1 },
      'fpp-tests/stats-quiet': { openIssues: 0, openPRs: 0 },
    });
    const searches = fake.requests().filter((q) => q.host === 'api.github.com');
    expect(searches.length, 'requests to GitHub').toBe(1);
    const q = decodeURIComponent(new URL(searches[0].path, 'https://x').searchParams.get('q') ?? '');
    for (const repo of ['stats-a', 'stats-b', 'stats-quiet']) expect(q).toContain(`repo:fpp-tests/${repo}`);

    // GitHub unreachable, for repos nothing has been cached for.
    fake.down();
    const down = await (await request.get('/api/plugin/githubStats?repos=fpp-tests/stats-down', { timeout: 60_000 })).json();
    expect(down.repos, JSON.stringify(down)).toEqual({});
  } finally {
    sh(`rm -f ${CACHE}; if [ -e ${CACHE}.fpp-tests ]; then mv ${CACHE}.fpp-tests ${CACHE}; fi`);
  }
});

test("a plugin card in the Developer UI shows the open issue and PR counts GitHub's search gave", async ({ page, request }) => {
  // The receiving end of 9fa1a49b4: the Plugins page, at UI level 3
  // (Developer), asks api/plugin/githubStats for the listed plugins' repos
  // and puts the counts on each card.  The plugin list itself is served to
  // the browser; the counts come from the server's search of the stand-in
  // GitHub.
  test.setTimeout(90_000);
  const NAME = 'fpp-tests-stats-card';
  const CACHE = '/home/fpp/media/tmp/pluginGithubStats.cache.json';
  const level = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  sh(`if [ -e ${CACHE} ]; then mv ${CACHE} ${CACHE}.fpp-tests; fi`);
  try {
    fake.routes({
      'api.github.com /search/issues': {
        json: { total_count: 3, items: [
          { repository_url: `https://api.github.com/repos/fpp-tests/${NAME}` },
          { repository_url: `https://api.github.com/repos/fpp-tests/${NAME}` },
          { repository_url: `https://api.github.com/repos/fpp-tests/${NAME}`, pull_request: { url: 'x' } },
        ] },
      },
    });
    expect((await request.put('/api/settings/uiLevel', { data: '3' })).ok()).toBe(true);
    const url = `https://raw.githubusercontent.com/fpp-tests/${NAME}/master/pluginInfo.json`;
    await routePluginList(page, [[NAME, url]], {
      [url]: { name: `${NAME} title`, repoName: NAME, srcURL: `https://github.com/fpp-tests/${NAME}.git`,
        versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }] },
    });
    await page.goto('/plugins.php');
    const badge = page.locator(`[id="row-${NAME}"] .pluginGitHubStats`);
    await expect(badge).toHaveAttribute('title', '2 open issues, 1 open pull request', { timeout: 30_000 });
    // The control: the counts came through the server, from the search.
    expect(fake.requests().filter((q) => q.host === 'api.github.com' && q.path.startsWith('/search/issues')).length).toBe(1);
  } finally {
    await request.put('/api/settings/uiLevel', { data: level });
    sh(`rm -f ${CACHE}; if [ -e ${CACHE}.fpp-tests ]; then mv ${CACHE}.fpp-tests ${CACHE}; fi`);
  }
});
