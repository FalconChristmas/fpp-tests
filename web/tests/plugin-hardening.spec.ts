import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, PLUGINS, exists, history, pluginInfo, restoreState, saveState, sh } from './plugin-repo';

// Values a plugin author or a clone URL controls, kept in their place.

test.skip(!container, 'seeds plugins inside the run-web.sh container');

// fpp ea8cb05cb ("fix(plugins): sanitise the plugin linkName before using
// it"): uninstalling ran `rm <plugins>/<linkName>` through the shell with the
// pluginInfo.json's linkName as it was, so a linkName could run a command or
// delete any file the shell could reach.  Now only a plain file name that is
// this plugin's own symlink is removed.
test('uninstalling a plugin removes only its own linkName symlink, and runs nothing from it', async ({ request }) => {
  const PWNED = '/tmp/fpp-tests-linkname-pwned';
  const VICTIM = `${PLUGINS}/fpp-tests-victim`;
  const plugins = { alias: 'fpp-tests-ln-alias', victim: 'fpp-tests-ln-victim', shell: 'fpp-tests-ln-shell' };
  saveState();
  const seed = (name: string, linkName: string) => sh(`mkdir -p ${PLUGINS}/${name} && cat > ${PLUGINS}/${name}/pluginInfo.json <<'JSON'
${JSON.stringify({ name, repoName: name, linkName })}
JSON`);
  try {
    sh(`rm -f ${PWNED}; echo keep > ${VICTIM}; ln -sfn ${plugins.alias} ${PLUGINS}/fpp-tests-alias-link`);
    seed(plugins.alias, 'fpp-tests-alias-link');
    seed(plugins.victim, 'fpp-tests-victim');
    seed(plugins.shell, `x; touch ${PWNED}`);

    for (const name of Object.values(plugins)) {
      const r = await request.delete(`/api/plugin/${name}`, { timeout: 120_000 });
      expect(exists(`${PLUGINS}/${name}`), `${name}: ${await r.text()}`).toBe(false);
    }
    // The control: the plugin's own alias goes with it.
    expect(exists(`${PLUGINS}/fpp-tests-alias-link`)).toBe(false);
    expect(exists(VICTIM), 'a linkName naming another file deleted it').toBe(true);
    expect(exists(PWNED), 'a linkName ran a shell command').toBe(false);
  } finally {
    sh(`rm -rf ${PWNED} ${VICTIM} ${PLUGINS}/fpp-tests-alias-link`);
    restoreState(Object.values(plugins));
  }
});

// fpp fd7b98898 ("fix: harden plugin history URLs, troubleshooting output
// and pip args"):
// - PluginHistoryURL() kept a clone URL's query string and fragment, where a
//   token can ride, in the install history; now the URL is rebuilt from
//   scheme, host, port and path.
test('the install history does not keep a clone URL\'s query string', async ({ request }) => {
  const NAME = 'fpp-tests-histurl';
  saveState();
  const repo = new PluginRepo(NAME);
  // git takes a file:// URL's query as part of the path, so the repository
  // lives at a path that ends in one.
  const bare = `${repo.bare}?token=FPP-TESTS-SECRET`;
  try {
    repo.commit({ 'pluginInfo.json': pluginInfo(NAME) }, 'v1');
    sh(`rm -rf '${bare}' && git clone -q --bare ${repo.bare} '${bare}'`);
    const r = await request.post('/api/plugin', { data: repo.body({ srcURL: `file://${bare}` }), timeout: 120_000 });
    expect((await r.json()).Status).toBe('OK');
    const entries = history(NAME);
    // The control: the install was recorded, with where it came from.
    expect(entries.length, JSON.stringify(entries)).toBe(1);
    expect(entries[0].srcURL).toBe(repo.url);
    expect(JSON.stringify(entries)).not.toContain('FPP-TESTS-SECRET');
  } finally {
    sh(`rm -rf '${bare}'`);
    repo.remove();
    restoreState([NAME]);
  }
});

// - troubleshootingHelper.php served a command's output as text/html, and
//   that output can hold text a plugin or a hand-edited config file
//   controls; the URL can be opened on its own.  Now it is text/plain unless
//   the command is marked "format": "html".
test('a troubleshooting command\'s output is served as plain text', async ({ request }) => {
  const r = await request.get('/troubleshootingHelper.php?key=Memory');
  // The control: the command ran.
  expect(await r.text()).toContain('Mem:');
  expect(r.headers()['content-type']).toMatch(/^text\/plain/);
});
