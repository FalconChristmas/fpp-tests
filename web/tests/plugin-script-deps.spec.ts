import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, CONFIG, sh, installPlugin, installPluginStreamed, clearPluginSourceSettings } from './plugin-backfill';

// A plugin's dependencies.scripts: scripts from FPP's script repository
// ("Category/file"), each installed with scripts/installScript as root.  The
// PHP passes only names that are one safe path component each, and says which
// it skipped.  installScript here is a stand-in that logs its arguments; what
// it does with them (the download, the install actions) is not checked.

test.skip(!container, 'seeds plugins inside the run-web.sh container');
test.describe.configure({ timeout: 240_000 });

const INSTALL_SCRIPT = '/opt/fpp/scripts/installScript';
const LOG = '/tmp/fpp-tests-installScript.log';
const repos: PluginRepo[] = [];

test.beforeEach(() => {
  sh(`[ -e ${INSTALL_SCRIPT}.fpp-tests-real ] || mv ${INSTALL_SCRIPT} ${INSTALL_SCRIPT}.fpp-tests-real
    printf '%s\\n' '#!/bin/sh' 'for a in "$@"; do printf "[%s]" "$a"; done >> ${LOG}' 'echo >> ${LOG}' > ${INSTALL_SCRIPT}
    chmod 755 ${INSTALL_SCRIPT}; rm -f ${LOG}`);
});
test.afterEach(() => {
  sh(`mv -f ${INSTALL_SCRIPT}.fpp-tests-real ${INSTALL_SCRIPT}; rm -f ${LOG}`);
  for (const r of repos.splice(0)) {
    sh(`rm -rf ${CONFIG}/plugin.${r.name}`);
    r.remove();
  }
  clearPluginSourceSettings();
});

const calls = () => sh(`cat ${LOG} 2>/dev/null || true`).split('\n').filter((l) => l);

const SCRIPTS = [
  'Utility/Do Thing.sh',   // installed: category and file, each one argument
  'Display/clock.sh',
  'noslash.sh',            // not Category/file
  7,                       // not a name at all
  '../etc/x.sh',           // leaves the repository
  'Utility/../../x.sh',
  'Utility/sub/x.sh',      // a file in a subdirectory
  '-rf/x.sh',              // would read as an option
  'Utility/.hidden.sh',
];

test('each script dependency is installed by category and file, and an unsafe or malformed one is skipped', async ({ request }) => {
  const repo = new PluginRepo('fpp-tests-scriptdeps');
  repos.push(repo);
  repo.init({ dependencies: { scripts: SCRIPTS } });

  const out = await installPluginStreamed(request, repo.info({ dependencies: { scripts: SCRIPTS } }));
  expect(repo.installed(), out).toBe(true);
  expect(calls()).toEqual(['[Utility][Do Thing.sh]', '[Display][clock.sh]']);

  expect(out).toContain('=== Installing script dependencies for fpp-tests-scriptdeps ===');
  expect(out).toContain("Installing script 'Utility/Do Thing.sh'...");
  expect(out).toContain("Skipping malformed script dependency 'noslash.sh' (expected 'Category/file').");
  expect(out).toContain("Skipping malformed script dependency '7' (expected 'Category/file').");
  for (const unsafe of ['../etc/x.sh', 'Utility/../../x.sh', 'Utility/sub/x.sh', '-rf/x.sh', 'Utility/.hidden.sh']) {
    expect(out).toContain(`Skipping script dependency with unsafe characters: '${unsafe}'.`);
  }
});

test('an install that is not streamed installs the script dependencies the same way', async ({ request }) => {
  const repo = new PluginRepo('fpp-tests-scriptdeps-quiet');
  repos.push(repo);
  repo.init({ dependencies: { scripts: ['Utility/Do Thing.sh', '../x/y.sh'] } });

  const r = await installPlugin(request, repo.info({ dependencies: { scripts: ['Utility/Do Thing.sh', '../x/y.sh'] } }));
  expect(r.Status, JSON.stringify(r)).toBe('OK');
  expect(calls()).toEqual(['[Utility][Do Thing.sh]']);
  // Nothing is echoed into the JSON answer.
  expect(JSON.stringify(r)).not.toContain('Installing script');
});
