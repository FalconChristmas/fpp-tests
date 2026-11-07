import { test, expect } from './fixtures';
import { container } from './container';
import { CONFIG, MEDIA, PLUGINS, sh, writeFile } from './plugin-backfill';
import { setSettingInFile, snapshotSettings } from './settings-file';
import { FakeGitHub } from './standin-http';

// GET /api/plugin/<name>/releaseNotes for a plugin whose releaseNotesStyle is
// gitRelease: the latest GitHub Release of its srcURL repo, fetched through
// the player (with the saved GitHub token, if any) and cached for 6 hours.
// GitHub is a stand-in in the player (standin-http.ts).  The script and
// gitHistory styles, and the dialog, are plugin-content.spec.ts.

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const NAME = 'fpp-tests-rn-gh';
const REPO = 'fpp-tests/fpp-tests-rn-gh';
const LATEST = `/repos/${REPO}/releases/latest`;
const CACHE = `${MEDIA}/tmp/pluginReleaseNotes.cache.json`;
const notes = () => `/api/plugin/${NAME}/releaseNotes`;

let gh: FakeGitHub | undefined;
let restoreSettings: () => void;

function seed(srcURL = `https://github.com/${REPO}.git`) {
  sh(`rm -rf ${PLUGINS}/${NAME}`);
  writeFile(`${PLUGINS}/${NAME}/pluginInfo.json`, JSON.stringify({
    name: NAME, repoName: NAME, srcURL, releaseNotesStyle: 'gitRelease',
    versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }],
  }));
}

function github(routes: Record<string, { status?: number; json?: unknown }>) {
  gh = new FakeGitHub(routes);
  gh.start();
  return gh;
}

test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('gitHubPAT', undefined);
  sh(`rm -f ${CACHE}`);
});
test.afterEach(() => {
  gh?.stop();
  gh = undefined;
  sh(`rm -rf ${PLUGINS}/${NAME} ${CONFIG}/plugin.${NAME} ${CACHE}`);
  restoreSettings();
});

const RELEASE = {
  name: 'v2.0', tag_name: 'v2.0', published_at: '2026-10-01T00:00:00Z', body: '## Fixed\n- things',
  html_url: `https://github.com/${REPO}/releases/tag/v2.0`,
  assets: [{ name: 'big.zip', size: 1 }], author: { login: 'someone' }, draft: false,
};
const kept = { name: 'v2.0', tag_name: 'v2.0', published_at: '2026-10-01T00:00:00Z', body: '## Fixed\n- things',
  html_url: `https://github.com/${REPO}/releases/tag/v2.0` };

test('the latest release is fetched with the saved token, trimmed to what the page shows, and cached', async ({ request }) => {
  seed();
  setSettingInFile('gitHubPAT', 'fpp-tests-token');
  const fake = github({ [LATEST]: { json: RELEASE } });

  const r = await request.get(notes());
  expect(r.ok(), await r.text()).toBe(true);
  expect(await r.json()).toEqual({ Status: 'OK', style: 'gitRelease', release: kept,
    releasesUrl: `https://github.com/${REPO}/releases`, stale: false });
  expect(fake.requests().map((q) => [q.path, q.auth])).toEqual([[LATEST, 'token fpp-tests-token']]);

  // Within the 6 hours, GitHub is not asked again.
  fake.clearLog();
  expect((await (await request.get(notes())).json()).release).toEqual(kept);
  expect(fake.requests()).toEqual([]);
});

test('a release with fields missing or of the wrong kind gets empty strings for them', async ({ request }) => {
  seed();
  github({ [LATEST]: { json: { tag_name: 'v3', name: 7, body: null } } });
  expect((await (await request.get(notes())).json()).release)
    .toEqual({ name: '', tag_name: 'v3', published_at: '', body: '', html_url: '' });
});

test('a repo with no release yet is an answer, and cached; one GitHub will not show is not found', async ({ request }) => {
  seed();
  const fake = github({ [`/repos/${REPO}`]: { json: { full_name: REPO } } });
  expect(await (await request.get(notes())).json()).toMatchObject({ Status: 'OK', release: null, stale: false });
  expect(fake.requests().map((q) => q.path)).toEqual([LATEST, `/repos/${REPO}`]);
  fake.clearLog();
  expect((await (await request.get(notes())).json()).release).toBeNull();
  expect(fake.requests()).toEqual([]);

  // Private, or no such repo: GitHub says 404 for both.
  sh(`rm -f ${CACHE}`);
  fake.routes({});
  const hidden = await request.get(notes());
  expect(hidden.status()).toBe(404);
  expect((await hidden.json()).Message).toContain(`GitHub does not show github.com/${REPO} to this FPP`);
});

test('a token GitHub rejects is dropped for an anonymous retry', async ({ request }) => {
  seed();
  setSettingInFile('gitHubPAT', 'fpp-tests-stale-token');
  // The stand-in answers 401 whatever is sent, so the retry is refused too.
  const fake = github({ [LATEST]: { status: 401, json: { message: 'Bad credentials' } } });
  const r = await request.get(notes());
  expect(r.status()).toBe(502);
  expect((await r.json()).Message).toContain(`GitHub could not be reached (or refused the request) for ${REPO}`);
  expect(fake.requests().map((q) => q.auth)).toEqual(['token fpp-tests-stale-token', '']);
});

test('when GitHub fails, an expired cached copy is served as stale, and with none it is an error', async ({ request }) => {
  seed();
  writeFile(CACHE, JSON.stringify({ [REPO]: { release: kept, ts: 1 } }));
  github({ [LATEST]: { status: 500, json: { message: 'oops' } } });
  expect(await (await request.get(notes())).json()).toEqual({ Status: 'OK', style: 'gitRelease', release: kept,
    releasesUrl: `https://github.com/${REPO}/releases`, stale: true });
  // The stale copy is not rewritten as fresh.
  expect(JSON.parse(sh(`cat ${CACHE}`))[REPO].ts).toBe(1);

  sh(`rm -f ${CACHE}`);
  expect((await request.get(notes())).status()).toBe(502);
});

test('a gitRelease plugin whose srcURL is not plainly on github.com offers no release notes', async ({ request }) => {
  for (const url of ['https://gitlab.com/fpp-tests/x.git', 'https://evil.example\\@github.com/fpp-tests/x.git',
    'https://github.com/fpp-tests/../x.git']) {
    seed(url);
    const r = await request.get(notes());
    expect(r.status(), url).toBe(404);
    expect((await r.json()).Message, url).toContain('does not publish release notes');
  }
});
