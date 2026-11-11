import { test, expect } from './fixtures';
import { container } from './container';
import { PLUGINS, PluginRepo, exists, restoreState, saveState, sh } from './plugin-repo';
import { FakeHttps, credentials } from './fake-https';

// How a plugin's pluginInfo.json is fetched (FetchURLWithGitHubCredentials()):
// a plugin whose repo ships none has the one at its infoURL saved into its
// directory as it came, so that URL must be on the web -- a file:// or php://
// one would copy a file of the player's into the plugin's (where every
// plugin page can read it).  From GitHub with the Developer settings'
// credentials, a raw URL the token can't read is asked of the Contents API,
// and what fails says why without showing the token.  GitHub and the other
// host are an HTTPS stand-in.

test.skip(!container, 'stands in for GitHub inside the run-web.sh container');
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const OTHER = 'info.fpp-tests.example';
const USER = 'fpp-tests-user';
const PAT = 'fpp-tests-pat-9876543210';
const NAME = 'fpp-tests-noinfo';
const SECRET = '/tmp/fpp-tests-local-info.json';

let fake: FakeHttps;
let repo: PluginRepo;
test.beforeEach(() => {
  saveState();
  fake = new FakeHttps(['github.com', 'api.github.com', 'raw.githubusercontent.com', OTHER]);
  fake.start();
  // A plugin repo with no pluginInfo.json of its own.
  repo = new PluginRepo(NAME);
  repo.commit({ 'README.md': 'fpp-tests\n' });
});
test.afterEach(async ({ request }) => {
  fake.stop();
  repo.remove();
  restoreState([NAME]);
  for (const key of ['gitHubUser', 'gitHubPAT']) await request.put(`/api/settings/${key}`, { data: '' });
  sh(`rm -f ${SECRET}`);
});

async function setCredentials(request: any) {
  for (const [key, value] of [['gitHubUser', USER], ['gitHubPAT', PAT]]) {
    expect((await request.put(`/api/settings/${key}`, { data: value })).ok()).toBe(true);
  }
}
const info = (extra: Record<string, unknown> = {}) => ({ name: NAME, repoName: NAME, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }], ...extra });
const savedInfo = () => (exists(`${PLUGINS}/${NAME}/pluginInfo.json`) ? sh(`cat ${PLUGINS}/${NAME}/pluginInfo.json`) : '');

async function install(request: any, infoURL: string) {
  const r = await request.post('/api/plugin', { data: repo.body({ infoURL }), timeout: 120_000 });
  return r.text();
}

test("a plugin's infoURL on the web is saved as its pluginInfo.json; one that names a local file is not read", async ({ request }) => {
  fake.routes({ [`${OTHER} /info.json`]: { json: info({ description: 'fpp-tests fetched from the web' }) } });
  await install(request, `https://${OTHER}/info.json`);
  expect(savedInfo(), 'the control: a web infoURL is fetched and saved').toContain('fpp-tests fetched from the web');

  sh(`printf '%s' '${JSON.stringify(info({ description: 'fpp-tests local secret' }))}' > ${SECRET}`);
  for (const url of [`file://${SECRET}`, `php://filter/resource=${SECRET}`, SECRET, `FILE://${SECRET}`]) {
    restoreState([NAME]);
    await install(request, url);
    // The control: the clone happened, so its info was looked for at the URL.
    expect(exists(`${PLUGINS}/${NAME}/README.md`), url).toBe(true);
    expect(savedInfo(), url).not.toContain('fpp-tests local secret');
  }
});

test('with credentials, a raw refs/heads URL the token cannot read is asked of the Contents API for that branch', async ({ request }) => {
  const raw = `/fpp-tests/${NAME}/refs/heads/main/sub/pluginInfo.json`;
  fake.routes({
    [`raw.githubusercontent.com ${raw}`]: { status: 404, body: '404: Not Found' },
    [`api.github.com /repos/fpp-tests/${NAME}/contents/sub/pluginInfo.json?ref=main`]: { json: info({ description: 'fpp-tests from the API' }) },
  });
  await setCredentials(request);
  const r = await request.post('/api/plugin/fetchInfo', { data: { url: `https://raw.githubusercontent.com${raw}`, useCredentials: 1 }, timeout: 60_000 });
  expect(await r.json()).toMatchObject({ description: 'fpp-tests from the API' });
  const sent = fake.requests().map((q) => `${q.host} ${q.path} [${credentials(q.authorization)}]`);
  expect(sent).toEqual([
    `raw.githubusercontent.com ${raw} [${PAT}]`,
    `api.github.com /repos/fpp-tests/${NAME}/contents/sub/pluginInfo.json?ref=main [${PAT}]`,
  ]);
});

test('a token GitHub refuses is said to be the likely cause, and is not shown', async ({ request }) => {
  const raw = `/fpp-tests/${NAME}/master/pluginInfo.json`;
  const refused = { status: 401, json: { message: 'Bad credentials' } };
  fake.routes({
    [`raw.githubusercontent.com ${raw}`]: refused,
    [`api.github.com /repos/fpp-tests/${NAME}/contents/pluginInfo.json?ref=master`]: refused,
  });
  await setCredentials(request);
  const body = await (await request.post('/api/plugin/fetchInfo', { data: { url: `https://raw.githubusercontent.com${raw}`, useCredentials: 1 }, timeout: 60_000 })).json();
  expect(body.Status).toBe('Error');
  expect(body.Message).toContain('HTTP 401');
  expect(body.Message).toContain('Bad credentials');
  expect(body.Message).toContain('Personal Access Token may be invalid or expired');
  expect(JSON.stringify(body)).not.toContain(PAT);
});

test('a pluginInfo.json over 1 MB from GitHub is refused', async ({ request }) => {
  const raw = `/fpp-tests/${NAME}/master/pluginInfo.json`;
  fake.routes({ [`raw.githubusercontent.com ${raw}`]: { body: JSON.stringify(info({ description: 'x'.repeat(1_100_000) })) } });
  await setCredentials(request);
  const body = await (await request.post('/api/plugin/fetchInfo', { data: { url: `https://raw.githubusercontent.com${raw}`, useCredentials: 1 }, timeout: 60_000 })).json();
  expect(body.Status).toBe('Error');
  expect(body.Message).toContain('Failed to fetch pluginInfo.json');
});
