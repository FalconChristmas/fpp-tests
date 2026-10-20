import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, PLUGINS, pluginInfo, restoreState, saveState, sh } from './plugin-repo';

// A plugin update stops at the commit its versions[] entry pins.  Fixed in
// fpp 98bf09e3e ("fix(plugins): honour a pinned commit when updating a
// plugin"): a versions[] entry with a `sha` freezes the plugin at that commit,
// and the update check already treated it so, but Update fast-forwarded to
// origin/<branch> regardless, so a pinned plugin jumped past its pin.
//
// The repository: A (installed), B, then C, whose pluginInfo.json pins this
// FPP's entry to B.  The pin is read from the fetched branch tip, as FPP does.

test.skip(!container, 'builds a plugin repository inside the run-web.sh container');

const NAME = 'fpp-tests-pinned';

test('an update of a pinned plugin lands the pinned commit, not the branch tip', async ({ request }) => {
  saveState();
  const repo = new PluginRepo(NAME);
  try {
    const a = repo.commit({ 'pluginInfo.json': pluginInfo(NAME), 'version.txt': 'A\n' }, 'A');
    const r = await request.post('/api/plugin', { data: repo.body(), timeout: 120_000 });
    expect((await r.json()).Status, 'the install').toBe('OK');
    const head = () => sh(`git -C ${PLUGINS}/${NAME} rev-parse HEAD`).trim();
    expect(head()).toBe(a);

    const b = repo.commit({ 'version.txt': 'B\n' }, 'B');
    const c = repo.commit({
      'pluginInfo.json': pluginInfo(NAME, { versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master', sha: b }] }),
      'version.txt': 'C\n',
    }, 'C');
    expect(c).not.toBe(b);

    const up = await request.post(`/api/plugin/${NAME}/upgrade`, { timeout: 120_000 });
    const body = await up.text();
    // The control: the update ran and moved the clone.
    expect(head(), `the update did not move the clone: ${body}`).not.toBe(a);
    expect(head(), `the update went past the pin (B) to the tip (C): ${body}`).toBe(b);
    expect(sh(`cat ${PLUGINS}/${NAME}/version.txt`).trim()).toBe('B');
  } finally {
    repo.remove();
    restoreState([NAME]);
  }
});
