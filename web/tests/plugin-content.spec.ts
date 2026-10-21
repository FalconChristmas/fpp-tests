import { test, expect } from './fixtures';
import { container } from './container';
import {
  PluginRepo, PLUGINS, CONFIG, MEDIA, sh, exists, readFile, writeFile, installPlugin, uninstallPlugin, clonePlugin,
  routePluginList, clearPluginSourceSettings,
} from './plugin-backfill';

// What an installed plugin brings with it and how FPP serves or runs it: its
// pages and assets, its settings file, the alias its linkName names, the
// header indicator its api.php offers and its release notes; and what an
// install request may carry.

test.skip(!container, 'seeds plugins inside the run-web.sh container');

const seeded: string[] = [];
// A plugin directory written in place (no git): pluginInfo.json plus $files.
function seed(name: string, info: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  seeded.push(name);
  sh(`rm -rf ${PLUGINS}/${name}`);
  writeFile(`${PLUGINS}/${name}/pluginInfo.json`, JSON.stringify({
    name, repoName: name, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }], ...info,
  }));
  for (const [f, content] of Object.entries(files)) {
    writeFile(`${PLUGINS}/${name}/${f}`, content, /\.sh$/.test(f) ? '755' : undefined);
  }
}
const repos: PluginRepo[] = [];

test.afterEach(() => {
  for (const n of seeded.splice(0)) {
    sh(`rm -rf ${PLUGINS}/${n} ${CONFIG}/plugin.${n}`);
  }
  for (const r of repos.splice(0)) {
    r.remove();
  }
  sh(`rm -rf /tmp/fpp-tests-pwn* /tmp/fpp-tests-ind-hits /opt/fpp/www/fpp-tests-linkinfo.json ${PLUGINS}/fpp-tests-alias ${PLUGINS}/fpp-tests-foreign`);
  sh(`pkill -f '[f]pp-tests-rn-sleeper' || true`);
  clearPluginSourceSettings();
});

test('a plugin page can live in a subdirectory, and still cannot leave the plugin', async ({ request }) => {
  // Regression: 47e20cd39.  plugin.php took basename() of ?page=, so a page
  // in help/ was looked up as help.php in the top directory and 404d.
  seed('fpp-tests-pages', {}, {
    'help/help.php': '<?php echo "FPP-TESTS-" . "HELP-PAGE";',
    'top.php': '<?php echo "FPP-TESTS-" . "TOP-PAGE";',
    '.git/config': '[remote "origin"]\n\turl = https://fpp-tests:FPP-TESTS-SECRET@example.invalid/x.git\n',
  });
  // The control: a top-level page.
  expect(await (await request.get('/plugin.php?plugin=fpp-tests-pages&page=top.php&nopage=1')).text()).toContain('FPP-TESTS-TOP-PAGE');
  expect(await (await request.get('/plugin.php?plugin=fpp-tests-pages&page=help/help.php&nopage=1')).text()).toContain('FPP-TESTS-HELP-PAGE');
  for (const page of ['.git/config', 'help/../.git/config', '../fpp-tests-pages/.git/config']) {
    const r = await request.get(`/plugin.php?plugin=fpp-tests-pages&page=${encodeURIComponent(page)}&nopage=1`);
    expect(await r.text(), page).not.toContain('FPP-TESTS-SECRET');
  }
});

test('plugin assets in a subdirectory are served', async ({ request }) => {
  // Regression: e2ff01711.  The asset rewrite split the path on its LAST
  // slash, so /images/plugin/<p>/images/foo.png reached plugin.php as plugin
  // "<p>/images", which its name check rejects: every asset one directory
  // deep 404d.
  seed('fpp-tests-assets', {}, { 'icon.png': 'flat\n', 'js/x/y.js': 'var fppTestsNested = 1;\n' });
  sh(`mkdir -p ${PLUGINS}/fpp-tests-assets/images/sub && printf '\\211PNG\\r\\n' > ${PLUGINS}/fpp-tests-assets/images/sub/foo.png`);
  const want = Buffer.from(sh(`base64 -w0 ${PLUGINS}/fpp-tests-assets/images/sub/foo.png`), 'base64');

  // The control: a flat one.
  expect((await request.get('/images/plugin/fpp-tests-assets/icon.png')).status()).toBe(200);
  const img = await request.get('/images/plugin/fpp-tests-assets/images/sub/foo.png');
  expect(img.status()).toBe(200);
  expect(Buffer.compare(await img.body(), want)).toBe(0);
  expect((await request.get('/images/plugin/fpp-tests-assets/images/../../../config/settings')).status()).not.toBe(200);
});

test("a plugin's settings reach its page as written", async ({ request }) => {
  // Regression: f9cc6a348.  Plugin config files were read with
  // parse_ini_file(), which stripped the quotes from the JSON values
  // WriteSettingToFile() stores and turned "yes" into "1".
  seed('fpp-tests-cfg', {}, { 'page.php': '<?php echo "page";' });
  writeFile(`${CONFIG}/plugin.fpp-tests-cfg`, 'controllerBases = {"F16V5":1}\nflag = yes\nname = "plain"\n');
  const text = await (await request.get('/plugin.php?plugin=fpp-tests-cfg&page=page.php')).text();
  expect(text).toContain('pluginSettings["name"] = "plain";');
  expect(text).toContain('pluginSettings["controllerBases"] = "{\\"F16V5\\":1}";');
  expect(text).toContain('pluginSettings["flag"] = "yes";');
});

test("a plugin's linkName is only ever its own alias in the plugins directory", async ({ request }) => {
  // Regression: ea8cb05cb.  The author's linkName went to "ln -s" and, on
  // uninstall, "rm <plugins>/<linkName>" unchecked, so '../../x' put a link
  // outside the plugins directory and a linkName naming another file deleted
  // it.  linkName is honoured for a plugin whose pluginInfo.json comes from
  // infoURL (the clone has none), served here by the player itself.
  const repo = new PluginRepo('fpp-tests-link');
  repos.push(repo);
  repo.init({}, {});
  repo.commit('no info', { 'pluginInfo.json': null, 'README': 'x\n' });
  const above = sh(`cd ${PLUGINS}/../.. && pwd -P`).trim();
  const info = (linkName: string) => ({ ...repo.info({ linkName }), infoURL: 'http://127.0.0.1/fpp-tests-linkinfo.json' });

  // A traversal: no link anywhere outside the plugins directory.
  writeFile('/opt/fpp/www/fpp-tests-linkinfo.json', JSON.stringify(info('../../fpp-tests-pwn-link')));
  let r = await installPlugin(request, info('../../fpp-tests-pwn-link'));
  expect(r.Status, JSON.stringify(r)).toBe('OK');
  expect(exists(`${above}/fpp-tests-pwn-link`), 'a link was made outside the plugins directory').toBe(false);
  expect((await uninstallPlugin(request, repo.name)).Status).toBe('OK');

  // A plain name: the alias is made (the control), and removed on uninstall.
  writeFile('/opt/fpp/www/fpp-tests-linkinfo.json', JSON.stringify(info('fpp-tests-alias')));
  r = await installPlugin(request, info('fpp-tests-alias'));
  expect(r.Status, JSON.stringify(r)).toBe('OK');
  expect(sh(`readlink ${PLUGINS}/fpp-tests-alias`).trim()).toBe(repo.name);
  expect((await uninstallPlugin(request, repo.name)).Status).toBe('OK');
  expect(exists(`${PLUGINS}/fpp-tests-alias`)).toBe(false);

  // A name that is another file: neither replaced nor deleted.
  writeFile(`${PLUGINS}/fpp-tests-foreign`, 'not the plugin\n');
  writeFile('/opt/fpp/www/fpp-tests-linkinfo.json', JSON.stringify(info('fpp-tests-foreign')));
  r = await installPlugin(request, info('fpp-tests-foreign'));
  expect(r.Status, JSON.stringify(r)).toBe('OK');
  expect((await uninstallPlugin(request, repo.name)).Status).toBe('OK');
  expect(readFile(`${PLUGINS}/fpp-tests-foreign`), 'the uninstall deleted a file the plugin did not own').toBe('not the plugin\n');
});

test('an install request cannot inject through its srcURL, branch or sha', async ({ request }) => {
  // Regression: de759f86d.  install_plugin's arguments were built into a
  // shell command with only double quotes around srcURL, branch and sha, so a
  // $(...) in any of them ran as root.
  const repo = new PluginRepo('fpp-tests-inject');
  repos.push(repo);
  repo.init();
  const tries: Record<string, unknown>[] = [
    { srcURL: `${repo.url}$(touch /tmp/fpp-tests-pwn-url)` },
    { branch: 'master$(touch /tmp/fpp-tests-pwn-branch)' },
    { sha: '$(touch /tmp/fpp-tests-pwn-sha)' },
    { repoName: 'fpp-tests-inject;touch /tmp/fpp-tests-pwn-name' },
  ];
  for (const t of tries) {
    const r = await installPlugin(request, { ...repo.info(), ...t });
    expect(r.Status, JSON.stringify(t)).toBe('Error');
  }
  expect(sh('ls /tmp | grep fpp-tests-pwn || true').trim(), 'an install request ran a command').toBe('');
  expect(exists(repo.dir)).toBe(false);
  // The control: the same request without the payload installs.
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
});

test("plugins' header indicators are collected at most once per few seconds", async ({ request }) => {
  // Feature: 6a3692473.  /api/plugin/headerIndicators (behind every page's
  // status poll) made one request per plugin back into the web server on
  // every call, so a few open pages filled php-fpm.  It now serves a cache
  // for 5 s.
  seed('fpp-tests-ind', {}, {
    'api.php': `<?php
function getEndpointsfpptestsind() {
    return array(array('method' => 'GET', 'endpoint' => 'headerIndicator', 'callback' => 'fppTestsIndHeader'));
}
function fppTestsIndHeader() {
    file_put_contents('/tmp/fpp-tests-ind-hits', "hit\\n", FILE_APPEND);
    return json(array('icon' => 'fa-star', 'text' => 'fpp-tests'));
}
`,
  });
  sh(`rm -f ${MEDIA}/tmp/plugin-header-indicators.json`);
  const t0 = Date.now();
  let last: any = null;
  for (let i = 0; i < 20; i++) {
    last = await (await request.get('/api/plugin/headerIndicators')).json();
  }
  const secs = (Date.now() - t0) / 1000;
  // The control: the plugin's indicator is in the answer.
  expect(JSON.stringify(last)).toContain('fpp-tests-ind');
  const hits = readFile('/tmp/fpp-tests-ind-hits').split('\n').filter((l) => l === 'hit').length;
  expect(hits, `${hits} sub-requests for 20 polls in ${secs}s`).toBeLessThanOrEqual(Math.ceil(secs / 5) + 1);
});

test("a plugin's release notes: bounded script output, a deadline, a clean environment, and git history", async ({ request }) => {
  // Feature: fc8c9d427.  Release notes are offered only for an installed
  // plugin; a script's output is capped at 64 KiB, it is killed (with its
  // children) after 15 s, and it never sees the request's environment;
  // gitHistory lists what Update would pull in.
  test.setTimeout(120_000);
  let r = await request.get('/api/plugin/fpp-tests-rn-none/releaseNotes');
  expect(r.status()).toBe(404);
  // Also 933fb9eed: offered only on an explicit releaseNotesStyle, not for
  // being on GitHub.
  seed('fpp-tests-rn-nostyle', { srcURL: 'https://github.com/fpp-tests/fpp-tests-rn-nostyle.git' });
  r = await request.get('/api/plugin/fpp-tests-rn-nostyle/releaseNotes');
  expect(r.status()).toBe(404);
  expect((await r.json()).Message).toContain('does not publish release notes');

  const big = '#!/bin/sh\nhead -c 204800 /dev/zero | tr "\\000" a\n';
  seed('fpp-tests-rn', { releaseNotesStyle: 'script' }, { 'scripts/fpp_releasenotes.sh': big });
  let body = await (await request.get('/api/plugin/fpp-tests-rn/releaseNotes')).json();
  expect(body).toMatchObject({ Status: 'OK', style: 'script', truncated: true });
  expect(body.text.length).toBeLessThanOrEqual(64 * 1024);

  writeFile(`${PLUGINS}/fpp-tests-rn/scripts/fpp_releasenotes.sh`, '#!/bin/sh\nenv\n', '755');
  body = await (await request.get('/api/plugin/fpp-tests-rn/releaseNotes', { headers: { 'X-Fpp-Tests': 'leak' } })).json();
  expect(body.Status).toBe('OK');
  expect(body.text).toContain('FPPDIR=');
  expect(body.text).not.toMatch(/HTTP_|leak/);

  writeFile(`${PLUGINS}/fpp-tests-rn/scripts/fpp-tests-rn-sleeper.sh`, '#!/bin/sh\nsleep 120\n', '755');
  writeFile(`${PLUGINS}/fpp-tests-rn/scripts/fpp_releasenotes.sh`,
    `#!/bin/sh\necho started\n${PLUGINS}/fpp-tests-rn/scripts/fpp-tests-rn-sleeper.sh &\n${PLUGINS}/fpp-tests-rn/scripts/fpp-tests-rn-sleeper.sh\n`, '755');
  const t0 = Date.now();
  r = await request.get('/api/plugin/fpp-tests-rn/releaseNotes', { timeout: 100_000 });
  const secs = (Date.now() - t0) / 1000;
  expect(r.status()).toBe(502);
  expect((await r.json()).Message).toContain('did not finish within');
  expect(secs).toBeLessThan(30);
  await expect.poll(() => sh(`pgrep -f '[f]pp-tests-rn-sleeper' || true`).trim(), { timeout: 10_000 }).toBe('');

  const repo = new PluginRepo('fpp-tests-rn-git');
  repos.push(repo);
  repo.init({ releaseNotesStyle: 'gitHistory' });
  clonePlugin(repo);
  repo.commit('fpp-tests v2', { 'v.txt': '2\n' });
  sh(`git -C ${repo.dir} fetch -q origin`);
  body = await (await request.get(`/api/plugin/${repo.name}/releaseNotes`)).json();
  expect(body, JSON.stringify(body)).toMatchObject({ Status: 'OK', style: 'gitHistory', branch: 'master', pendingCount: 1 });
  expect(body.pending.map((c: any) => c.subject)).toEqual(['fpp-tests v2']);
  expect(body.installed[0].subject).toBe('v1');
});

test('release notes open in the page with their markdown made safe', async ({ page }) => {
  // Feature: 0c19b184b.  The notes open in a dialog instead of a link out;
  // the release body is markdown from the plugin's author, rendered through
  // the whitelist renderer: headings and lists, no HTML, no script.
  seed('fpp-tests-rnui', { releaseNotesStyle: 'gitRelease', srcURL: 'https://github.com/fpp-tests/fpp-tests-rnui.git' });
  await page.route('**/api/plugin/fpp-tests-rnui/releaseNotes', (route: any) => route.fulfill({
    json: {
      Status: 'OK', style: 'gitRelease', stale: false, releasesUrl: 'https://github.com/fpp-tests/fpp-tests-rnui/releases',
      release: {
        name: 'v2.0', tag_name: 'v2.0', published_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/fpp-tests/fpp-tests-rnui/releases/tag/v2.0',
        body: '## FPP-TESTS heading\n\n- FPP-TESTS item\n\n<img src=x onerror="window.__fppTestsPwn=1">\n\n[click](javascript:window.__fppTestsPwn=2)\n',
      },
    },
  }));
  await routePluginList(page);
  await page.goto('/plugins.php');
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
  const link = page.locator('[id="row-fpp-tests-rnui"] [data-plugin-action="releaseNotes"]');
  await link.first().click({ timeout: 20_000 });
  const modal = page.locator('#pluginReleaseNotesModal');
  await expect(modal.locator('h2, h3, h4', { hasText: 'FPP-TESTS heading' })).toBeVisible();
  await expect(modal.locator('li', { hasText: 'FPP-TESTS item' })).toBeVisible();
  await expect(modal.locator('.modal-body img')).toHaveCount(0);
  await expect(modal.locator('a[href^="javascript"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__fppTestsPwn)).toBeUndefined();
});

test('the persistent file cache is kept out of the directory boot empties', async () => {
  // Regression: d2f53b515.  file_cache_dir_persistent() (the plugin list
  // cache, the unverified-plugin lock) was media/tmp, which fppinit empties
  // at every boot, so an offline player lost its plugin list on each reboot.
  const dir = sh(`cd /opt/fpp/www && php -r '$_SERVER["REQUEST_URI"] = "/cli"; $_SERVER["SCRIPT_NAME"] = "/cli"; ob_start(); require "config.php"; require_once "common.php"; ob_end_clean(); echo file_cache_dir_persistent();'`).trim();
  expect(dir).toMatch(/\/cache$/);
  expect(sh(`test -d '${dir}' && echo yes`).trim()).toBe('yes');
});
