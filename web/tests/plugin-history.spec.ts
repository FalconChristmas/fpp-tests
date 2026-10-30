import http from 'http';
import { test, expect } from './fixtures';
import { container } from './container';
import {
  PluginRepo, PLUGINS, CONFIG, sh, exists, writeFile, readFile, historyOf,
  installPlugin, uninstallPlugin, clearPluginSourceSettings,
} from './plugin-backfill';

// The plugin install history (config/pluginHistory.jsonl, shown under
// Troubleshooting > Plugins) and the uninstall path it records.

test.skip(!container, 'installs plugins from repositories inside the run-web.sh container');

const PLUGIN = 'fpp-tests-hist';
const repo = new PluginRepo(PLUGIN);

test.afterEach(() => {
  repo.remove();
  sh(`git config --system --remove-section url.${repo.url} 2>/dev/null || true; rm -f /tmp/fpp-tests-hist-*`);
  clearPluginSourceSettings();
});

function historyReport(arg = ''): string {
  return sh(`php /opt/fpp/scripts/plugin_history.php ${arg} 2>&1 || true`);
}

test('an install, an uninstall and a reset of the plugins area each leave a history line', async ({ request }) => {
  // Feature: fcc5a58da.  One JSON line per install, uninstall and Reset Config
  // delete, with where the plugin came from; the report shows the clone URL,
  // its --summary form (what manual Diagnostic Reports get) does not; and the
  // file survives the reset of the plugins area.
  const sha = repo.init();
  const before = historyOf(PLUGIN).length;
  const r = await installPlugin(request, repo.info());
  expect(r.Status, JSON.stringify(r)).toBe('OK');

  let h = historyOf(PLUGIN).slice(before);
  expect(h.map((e) => e.action)).toEqual(['install']);
  expect(h[0]).toMatchObject({ source: 'unknown', srcURL: repo.url, branch: 'master', sha });
  expect(historyReport()).toContain(`from ${repo.url}`);
  const summary = historyReport('--summary');
  expect(summary).toContain(PLUGIN);
  expect(summary).not.toContain(repo.url);

  const u = await uninstallPlugin(request, PLUGIN);
  expect(u.Status, JSON.stringify(u)).toBe('OK');
  h = historyOf(PLUGIN).slice(before);
  expect(h.map((e) => e.action)).toEqual(['install', 'uninstall']);
  expect(h[1].sha).toBe(sha);

  // Back in, then removed by Reset Config's "plugins" area, which runs no
  // uninstall: a 'deleted' line, and the history itself is still there.
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
  await request.post('/resetConfig.php?areas=plugins,dummy', { timeout: 60_000 });
  expect(repo.installed()).toBe(false);
  h = historyOf(PLUGIN).slice(before);
  expect(h.map((e) => e.action)).toEqual(['install', 'uninstall', 'install', 'deleted']);
  expect(h[3].sha).toBe(sha);
});

test('Troubleshooting > Plugins > Install History shows an install', async ({ request }) => {
  // Feature: fcc5a58da.  The history is shown under Troubleshooting, whose
  // helper runs the command as the web server, through sudo: the install's
  // commit and clone URL are in its output.  (That it is served as plain
  // text is fd7b98898's, in plugin-hardening.spec.ts.)
  const sha = repo.init();
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
  const r = await request.get('/troubleshootingHelper.php?key=PluginHistory');
  expect(r.ok()).toBe(true);
  const text = await r.text();
  expect(text, 'the command failed').not.toContain('Failed to return valid result');
  // The commit is unique to this test's repository, so the line is this install's.
  expect(text).toMatch(new RegExp(`${PLUGIN}\\b.*${sha.slice(0, 8)}`));
  expect(text).toContain(`from ${repo.url}`);
});

test('the history keeps the real host of a clone URL and drops its query and fragment', async ({ request }) => {
  // Regression: fd7b98898.  PluginHistoryURL() cut everything up to the last
  // '@' before the path, so "https://evil.example?@github.com/o/r.git" was
  // recorded as github.com, and it kept query strings and fragments, where a
  // token can ride.  git's insteadOf maps both spellings to the local
  // repository, so the clones really happen.
  repo.init();
  const tricky = 'https://evil.example?@github.com/fpp-tests/r.git';
  const token = 'https://fpp-tests.invalid/r.git?token=FPP-TESTS-SECRET#frag';
  sh(`git config --system --add url.${repo.url}.insteadOf '${tricky}'; git config --system --add url.${repo.url}.insteadOf '${token}'`);

  const before = historyOf(PLUGIN).length;
  const r1 = await installPlugin(request, repo.info({ srcURL: tricky }));
  expect(r1.Status, JSON.stringify(r1)).toBe('OK');
  await uninstallPlugin(request, PLUGIN);
  const r2 = await installPlugin(request, repo.info({ srcURL: token }));
  expect(r2.Status, JSON.stringify(r2)).toBe('OK');

  const h = historyOf(PLUGIN).slice(before);
  const installs = h.filter((e) => e.action === 'install');
  expect(installs.map((e) => e.srcURL)).toEqual(['https://evil.example', 'https://fpp-tests.invalid/r.git']);
  expect(JSON.stringify(h)).not.toContain('FPP-TESTS-SECRET');
});

test('the leftovers report ignores a claimed package name that is an option', async () => {
  // Regression: fd7b98898.  plugin_history.php --leftovers took names from
  // config/userpackages.json (writable through the config API and backup
  // restore) unchecked and handed them to dpkg-query, so a "--help" there was
  // listed and read as an option.

  const file = `${CONFIG}/userpackages.json`;
  const saved = exists(file) ? readFile(file) : null;
  try {
    writeFile(file, JSON.stringify([
      { package: '--help', requestedBy: ['fpp-tests-gone'] },
      { package: 'fpp-tests-pkg', requestedBy: ['fpp-tests-gone'] },
    ]));
    const out = historyReport('--leftovers');
    // The control: a well-formed claim of the gone plugin is listed.
    expect(out).toContain('fpp-tests-pkg');
    expect(out).not.toContain('--help');
  } finally {
    if (saved === null) {
      sh(`rm -f ${file}`);
    } else {
      writeFile(file, saved);
    }
  }
});

test('an install finishes and is recorded when the browser goes away part way through', async () => {
  // Regression: 633075320.  Closing the tab during an install stopped PHP at
  // its next echo, between the plugin's script and the bookkeeping after it,
  // so the plugin was installed but nothing recorded it.
  const marker = '/tmp/fpp-tests-hist-installed';
  repo.init({}, {
    // Plenty of output after the client is gone, paced so Apache notices and
    // drops the connection to PHP while the script still runs.
    'scripts/fpp_install.sh': `#!/bin/sh\necho installing\nsleep 3\ntouch ${marker}\n` +
      `for i in $(seq 25); do head -c 4096 /dev/zero | tr '\\0' x; echo; sleep 0.2; done\n`,
  });
  const before = historyOf(PLUGIN).length;
  const base = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080');
  await new Promise<void>((resolve) => {
    const req = http.request({
      host: base.hostname, port: base.port || 80, method: 'POST', path: '/api/plugin?stream=true',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      res.on('data', (d) => {
        // Gone once the script has started.
        if (d.toString().includes('installing')) {
          req.destroy();
          resolve();
        }
      });
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify(repo.info()));
  });
  await expect.poll(() => exists(marker), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => historyOf(PLUGIN).slice(before).map((e) => e.action), {
    timeout: 30_000, message: 'the install was cut off before its history line',
  }).toEqual(['install']);
});

test('an uninstall whose script removed the plugin directory itself succeeds', async ({ request }) => {
  // Regression: f63c25eec.  uninstall_plugin ended with
  // '[ -d "$1" ] && rm -rf "$1"', whose status is 1 when the directory is
  // already gone, so the uninstall was reported failed.
  repo.init({}, { 'scripts/fpp_uninstall.sh': `#!/bin/sh\nrm -rf ${PLUGINS}/${PLUGIN}\n` });
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
  const before = historyOf(PLUGIN).length;
  const u = await uninstallPlugin(request, PLUGIN);
  expect(u.Status, JSON.stringify(u)).toBe('OK');
  expect(repo.installed()).toBe(false);
  const h = historyOf(PLUGIN).slice(before);
  expect(h.map((e) => e.action)).toEqual(['uninstall']);
  expect(h[0].scriptFailed).toBeUndefined();
});

test('an uninstall script running under set -u can source scripts/common', async ({ request }) => {
  // Regression: 9fca0ba89.  FPPDIR reached fpp_uninstall.sh only as a
  // trailing argument, which sudo's env_reset left unset, so a script
  // running under set -u died on "FPPDIR: unbound variable"; and
  // scripts/common itself expanded a bare $LD_LIBRARY_PATH.
  const marker = '/tmp/fpp-tests-hist-uninstalled';
  repo.init({}, {
    'scripts/fpp_uninstall.sh': `#!/bin/bash\nset -u\n. \${FPPDIR}/scripts/common\necho "\${FPPDIR}" > ${marker}\n`,
  });
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
  const u = await uninstallPlugin(request, PLUGIN);
  expect(u.Status, JSON.stringify(u)).toBe('OK');
  expect(readFile(marker).trim(), 'the uninstall script stopped before its last line').toBe('/opt/fpp');
});

test("an uninstall script is told whether it is the uninstall half of a Reinstall", async ({ request }) => {
  // Feature: 4e019e14d.  The Reinstall flow's uninstall
  // (reinstall=1, or keepPackages=1 from before it had that name) gives the
  // plugin's fpp_uninstall.sh FPP_PLUGIN_REINSTALL=1 so it can keep its state;
  // any other uninstall gives it 0.  reinstall, when given, decides over
  // keepPackages, and only exactly '1' counts.  Both the streamed and the
  // JSON paths.
  const marker = '/tmp/fpp-tests-hist-reinstall';
  repo.init({}, { 'scripts/fpp_uninstall.sh': `#!/bin/sh\necho "\${FPP_PLUGIN_REINSTALL-unset}" > ${marker}\n` });
  for (const [query, expected] of [
    ['', '0'], ['?reinstall=1', '1'], ['?keepPackages=1', '1'], ['?reinstall=0', '0'],
    ['?reinstall=0&keepPackages=1', '0'], ['?reinstall=01', '0'],
    ['?stream=true', '0'], ['?stream=true&reinstall=1', '1'],
  ] as const) {
    sh(`rm -f ${marker}`);
    expect((await installPlugin(request, repo.info())).Status).toBe('OK');
    const before = historyOf(PLUGIN).length;
    await uninstallPlugin(request, PLUGIN, query);
    expect(repo.installed(), query).toBe(false);
    expect(exists(marker), `${query}: the uninstall script did not run`).toBe(true);
    expect(readFile(marker).trim(), query).toBe(expected);
    const h = historyOf(PLUGIN).slice(before);
    expect(h.map((e) => e.action), query).toEqual(['uninstall']);
    expect(h[0].reinstall, query).toBe(expected === '1' ? true : undefined);
  }
});
