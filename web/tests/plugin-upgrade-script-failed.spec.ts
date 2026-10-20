import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, PLUGINS, pluginInfo, restoreState, saveState, sh } from './plugin-repo';

// An update whose code landed but whose own upgrade script failed says so,
// rather than blaming git.  Fixed in fpp 0e37a62ff ("fix(plugins): say which
// phase of a plugin upgrade failed"): upgrade_plugin returned the script's rc
// as its own and UpgradePlugin() reported any non-zero rc as "Could not run
// git pull", so a plugin whose fpp_upgrade.sh failed looked like a git
// problem.  Now the code phase and the script phase are told apart.
//
// (Update All's report of the same failure, on the Plugins page, is in
// plugins-page.spec.ts.)

test.skip(!container, 'builds a plugin repository inside the run-web.sh container');

const NAME = 'fpp-tests-upscript';

test('an update whose upgrade script fails says the code was updated and the script failed', async ({ request }) => {
  saveState();
  const repo = new PluginRepo(NAME);
  try {
    repo.commit({ 'pluginInfo.json': pluginInfo(NAME), 'version.txt': '1\n' }, 'v1');
    expect((await (await request.post('/api/plugin', { data: repo.body(), timeout: 120_000 })).json()).Status).toBe('OK');

    const v2 = repo.commit({
      'version.txt': '2\n',
      'scripts/fpp_upgrade.sh': { content: '#!/bin/sh\necho fpp-tests upgrade script ran\nexit 3\n', mode: '755' },
    }, 'v2');
    const r = await request.post(`/api/plugin/${NAME}/upgrade`, { timeout: 120_000 });
    const body = await r.json();
    // The control: the code did land.
    expect(sh(`git -C ${PLUGINS}/${NAME} rev-parse HEAD`).trim(), JSON.stringify(body)).toBe(v2);
    expect(body.Status).toBe('Error');
    expect(body.Message, 'the failed script was reported as a git failure').toMatch(/was updated, but its install\/upgrade script failed/);
  } finally {
    repo.remove();
    restoreState([NAME]);
  }
});
