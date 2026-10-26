import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, sh, installPlugin, uninstallPlugin, clearPluginSourceSettings, MEDIA, PLUGINS } from './plugin-backfill';
import { keepingFile, keepingSettings } from './privacy-helpers';
import { StandIn } from './standin-http';

// Where an installed plugin came from, as the "Unknown Plugins" health check
// reports it (GET /api/plugin/source), and the two proxies that fetch a
// plugin's files on the browser's behalf.  Plugins are installed from git
// repositories inside the player (plugin-backfill.ts), which no plugin list
// names.  The plugin list itself is the player's cached copy, written by the
// test; raw.githubusercontent.com is pointed at the player's loopback where
// a test needs the list to be unreachable, so nothing goes to GitHub.

test.skip(!container, 'installs plugins inside the run-web.sh container');

const LIST_CACHE = `${MEDIA}/cache/cache_plugin_list.cache`;
const HOSTS_LINE = '127.0.0.1 raw.githubusercontent.com # fpp-tests-plugin-source';

// A current plugin list, cached as the player caches it, naming none of the
// test's plugins.
function cacheList() {
  sh(`mkdir -p ${MEDIA}/cache && printf '%s' '{"pluginList":[["fpp-tests-listed","https://raw.githubusercontent.com/fpp-tests/fpp-tests-listed/master/pluginInfo.json"]]}' > ${LIST_CACHE}`);
}

const repos: PluginRepo[] = [];
test.afterEach(() => {
  for (const r of repos.splice(0)) r.remove();
  // /etc/hosts is a bind mount: written in place, never replaced.
  sh(`grep -v fpp-tests-plugin-source /etc/hosts > /tmp/fpp-tests-hosts; cat /tmp/fpp-tests-hosts > /etc/hosts; rm -f /tmp/fpp-tests-hosts`);
  clearPluginSourceSettings();
});

async function source(request: any) {
  return (await request.get('/api/plugin/source')).json();
}

test('a plugin installed while the plugin list is out of reach is unverified until the list says', async ({ request }) => {
  // Regression: 4a795529a ("rewrite plugin-source health check").  An
  // install the list could not be checked for was taken as one way or the
  // other; it is "unverified" now, and settled when a current list is in.
  await keepingSettings(() => keepingFile(LIST_CACHE, async () => {
    clearPluginSourceSettings();
    sh(`rm -f ${LIST_CACHE}; echo '${HOSTS_LINE}' >> /etc/hosts`);
    expect((await source(request)).level, 'the control: nothing to report').toBe('none');
    const repo = new PluginRepo('fpp-tests-src-offlist');
    repos.push(repo);
    repo.init();
    // A GitHub repository, which the list could name, cloned from the local
    // one by git's insteadOf (a URL that is not GitHub's is decided without
    // the list).
    const github = `https://github.com/fpp-tests/${repo.name}.git`;
    sh(`git config --system url.${repo.url}.insteadOf ${github}`);
    try {
      const r = await installPlugin(request, repo.info({ srcURL: github }));
      expect(r.Status, JSON.stringify(r)).toBe('OK');
      expect((await source(request)).level).toBe('unverified');
      // The list arrives, without it.
      cacheList();
      const s = await source(request);
      expect(s.level, JSON.stringify(s)).toBe('unknown');
      expect(s.plugins).toEqual([{ repoName: repo.name, srcURL: github, installed: true }]);
    } finally {
      sh(`git config --system --remove-section url.${repo.url} 2>/dev/null || true`);
    }
  }));
});

test('a plugin from outside the list is still reported after it is removed and the settings are reset', async ({ request }) => {
  // Feature: 7112f7f23 ("track ... unknown plugin history and surface it in
  // the health check"): the record of an unknown plugin is meant to outlast
  // the plugin, and a Reset Config of the settings, short of a reimage.
  // Reset Config deletes the settings file; it is put back afterwards.
  await keepingSettings(() => keepingFile(LIST_CACHE, async () => {
    clearPluginSourceSettings();
    cacheList();
    const repo = new PluginRepo('fpp-tests-src-gone');
    repos.push(repo);
    repo.init();
    expect((await installPlugin(request, repo.info())).Status).toBe('OK');
    expect((await uninstallPlugin(request, repo.name)).Status).toBe('OK');
    const before = await source(request);
    expect(before.level, 'the control: the install was recorded').toBe('unknown');
    const reset = await (await request.post('/resetConfig.php?areas=settings,dummy', { timeout: 60_000 })).text();
    const s = await source(request);
    expect(s.level, JSON.stringify(s)).toBe('unknown');
    expect(s.plugins).toEqual([{ repoName: repo.name, srcURL: repo.url, installed: false }]);
    expect(reset).toContain('Restored setting: PluginUnknownEverInstalled');
  }));
});

test('the plugin info and icon proxies fetch nothing that is not on GitHub', async ({ request }) => {
  // Regression: 4a795529a ("harden icon/fetchInfo proxies").  POST
  // /api/plugin/fetchInfo fetched any URL it was given, and a plugin's icon
  // came from whatever iconURL its pluginInfo.json named: the player could
  // be made to request things on its own network.  The stand-in, on the
  // player's own loopback, is such a thing; the receiving end is that it
  // gets no request.
  const lan = new StandIn('plugin-source-lan', '127.0.0.1', 8779, {
    '/pluginInfo.json': { json: { name: 'fpp-tests-lan', repoName: 'fpp-tests-lan' } },
    '/icon.png': { body: 'not really a png', contentType: 'image/png' },
  });
  lan.start();
  const NAME = 'fpp-tests-src-lanicon';
  try {
    const r = await (await request.post('/api/plugin/fetchInfo', { data: { url: 'http://127.0.0.1:8779/pluginInfo.json' } })).json();
    expect(r.Status, JSON.stringify(r)).toBe('Error');
    expect(r.Message).toContain('only fetch a pluginInfo.json from github.com');
    // An installed plugin whose pluginInfo.json names an icon on the LAN.
    sh(`mkdir -p ${PLUGINS}/${NAME} && printf '%s' '{"name":"${NAME}","repoName":"${NAME}","iconURL":"http://127.0.0.1:8779/icon.png"}' > ${PLUGINS}/${NAME}/pluginInfo.json; rm -f /tmp/cache_plugin_icon_${NAME}.*`);
    expect((await request.get(`/api/plugin/${NAME}/icon`)).status()).toBe(404);
    expect(lan.requests().map((q) => q.path), 'the player fetched from its LAN').toEqual([]);
  } finally {
    lan.stop();
    sh(`rm -rf ${PLUGINS}/${NAME} /tmp/cache_plugin_icon_${NAME}.*`);
  }
});
