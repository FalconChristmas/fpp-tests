import { test, expect } from './fixtures';
import { container } from './container';
import {
  PluginRepo, PLUGINS, CONFIG, MEDIA, sh, exists, writeFile, installPluginStreamed, historyOf, clearPluginSourceSettings,
} from './plugin-backfill';
import { StandIn } from './standin-http';

// A plugin's dependencies.plugins: other plugins installed with it, each
// looked up by name in the official plugin list (never by a URL the plugin
// gives), its pluginInfo.json fetched from the list's infoURL, and installed
// in turn.  The plugin list is seeded into its cache, the infoURLs are a
// stand-in web server in the player, and every plugin is a local git repo
// (plugin-backfill.ts).

test.skip(!container, 'seeds plugins inside the run-web.sh container');
test.describe.configure({ timeout: 240_000 });

const repos: PluginRepo[] = [];
const seeded: string[] = [];
let infos: StandIn | undefined;
let listCache = '';
let listCacheBefore: string | null = null;

// Not ::1 port 80: localhost is ::1 too, and the install's own calls to
// FPP's API there would reach the stand-in instead.
const INFO = (name: string) => `http://127.0.0.1:8781/fpp-tests-info/${name}.json`;

function repo(name: string, info: Record<string, unknown> = {}) {
  const r = new PluginRepo(name);
  repos.push(r);
  r.init(info);
  return r;
}

// The plugin list as GetPluginList() reads it from its cache: [name, infoURL, category].
function seedPluginList(entries: [string, string][]) {
  const dir = sh(`test -d ${MEDIA}/cache && echo ${MEDIA}/cache || echo /tmp`).trim();
  listCache = `${dir}/cache_plugin_list.cache`;
  listCacheBefore = exists(listCache) ? sh(`cat ${listCache}`) : null;
  writeFile(listCache, JSON.stringify({ pluginList: entries.map(([n, u]) => [n, u, 'Utility']) }));
}

function serveInfos(byName: Record<string, unknown>) {
  const routes: Record<string, { json: unknown }> = {};
  for (const [n, info] of Object.entries(byName)) routes[`/fpp-tests-info/${n}.json`] = { json: info };
  infos = new StandIn('plugin-infos', '127.0.0.1', 8781, routes);
  infos.start();
}

test.afterEach(() => {
  infos?.stop();
  infos = undefined;
  for (const r of repos.splice(0)) {
    sh(`rm -rf ${CONFIG}/plugin.${r.name}`);
    r.remove();
  }
  for (const n of seeded.splice(0)) sh(`rm -rf ${PLUGINS}/${n}`);
  if (listCache) {
    if (listCacheBefore === null) sh(`rm -f ${listCache}`);
    else writeFile(listCache, listCacheBefore);
  }
  listCache = '';
  clearPluginSourceSettings();
});

test('a dependency plugin is found in the plugin list, installed first, and one that is not listed is skipped', async ({ request }) => {
  const dep = repo('fpp-tests-depb');
  // Already installed: under its own name, and under the repoName a listed name points at.
  seeded.push('fpp-tests-dephave');
  writeFile(`${PLUGINS}/fpp-tests-dephave/pluginInfo.json`, JSON.stringify({ name: 'fpp-tests-dephave', repoName: 'fpp-tests-dephave' }));
  const top = repo('fpp-tests-depa', { dependencies: { plugins: [
    'fpp-tests-depb', 'fpp-tests-depb', 'fpp-tests-dephave', 'fpp-tests-depalias', 'fpp-tests-depunlisted',
    'fpp-tests-depbadinfo', '', 7,
  ] } });
  seedPluginList([
    ['fpp-tests-depb', INFO('fpp-tests-depb')],
    ['fpp-tests-depalias', INFO('fpp-tests-depalias')],
    ['fpp-tests-depbadinfo', INFO('nothing-there')],
  ]);
  serveInfos({
    'fpp-tests-depb': dep.info(),
    'fpp-tests-depalias': { name: 'Alias', repoName: 'fpp-tests-dephave', srcURL: 'file:///nonexistent.git' },
  });

  const historyBefore = historyOf('fpp-tests-depb').length;
  const out = await installPluginStreamed(request, top.info({ dependencies: { plugins: [
    'fpp-tests-depb', 'fpp-tests-depb', 'fpp-tests-dephave', 'fpp-tests-depalias', 'fpp-tests-depunlisted',
    'fpp-tests-depbadinfo', '', 7,
  ] } }));

  expect(top.installed(), out).toBe(true);
  expect(dep.installed(), out).toBe(true);
  expect(dep.installedHead()).toBe(dep.head());
  expect(out).toContain('=== Installing plugin dependencies for fpp-tests-depa ===');
  expect(out).toContain("Dependency plugin 'fpp-tests-dephave' is already installed.");
  expect(out).toContain("could not resolve dependency plugin 'fpp-tests-depunlisted' from pluginList.json (skipping)");
  expect(out).toContain("could not resolve dependency plugin 'fpp-tests-depbadinfo' from pluginList.json (skipping)");
  // Installed once, though named twice, with its own history entry.
  expect(historyOf('fpp-tests-depb').slice(historyBefore).map((e) => e.action), out).toEqual(['install']);
  // The infoURLs were fetched from the list, and nothing else was.
  expect(infos!.requests().map((q) => q.path).sort())
    .toEqual(['/fpp-tests-info/fpp-tests-depalias.json', '/fpp-tests-info/fpp-tests-depb.json', '/fpp-tests-info/nothing-there.json']);
});

test('a dependency plugin that declares a privacy disclosure no one was shown is not installed', async ({ request }) => {
  const dep = repo('fpp-tests-depprivate');
  const top = repo('fpp-tests-depowner', { dependencies: { plugins: ['fpp-tests-depprivate'] } });
  seedPluginList([['fpp-tests-depprivate', INFO('fpp-tests-depprivate')]]);
  serveInfos({ 'fpp-tests-depprivate': dep.info({ privacy: { sends: [{ what: 'everything', to: 'example.invalid' }] } }) });

  const out = await installPluginStreamed(request, top.info({ dependencies: { plugins: ['fpp-tests-depprivate'] } }));
  expect(out).toContain("'fpp-tests-depowner' depends on the plugin 'fpp-tests-depprivate', whose privacy disclosure was not shown with this install");
  expect(dep.installed(), out).toBe(false);
});

test('a dependency plugin that fails to install is named', async ({ request }) => {
  const top = repo('fpp-tests-depneedy', { dependencies: { plugins: ['fpp-tests-depgone'] } });
  seedPluginList([['fpp-tests-depgone', INFO('fpp-tests-depgone')]]);
  serveInfos({ 'fpp-tests-depgone': { name: 'fpp-tests-depgone', repoName: 'fpp-tests-depgone',
    srcURL: 'file:///tmp/fpp-tests-repo-does-not-exist.git',
    versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }] } });
  seeded.push('fpp-tests-depgone');

  const out = await installPluginStreamed(request, top.info({ dependencies: { plugins: ['fpp-tests-depgone'] } }));
  expect(out).toContain("dependency plugin 'fpp-tests-depgone' could not be installed");
  expect(exists(`${PLUGINS}/fpp-tests-depgone/pluginInfo.json`)).toBe(false);
});
