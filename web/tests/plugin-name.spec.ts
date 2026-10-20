import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// A plugin name is one installed plugin's directory, and plugin.php serves
// only that plugin's own content files.  Before fpp 54ef245bd ("fix(security):
// refuse "." as a plugin name and keep plugin files to their plugin"):
// - "." passed plugin.php's character check, so the plugins directory itself
//   counted as a plugin and a plugin.php lying in it was include()d;
// - dot paths were served, so a clone's .git/config (its remote URL, with
//   credentials when a GitHub token is configured) was readable;
// - the file API mapped "plugins" to the plugins directory, so anyone could
//   write the files the first point then ran.

test.skip(!container, 'seeds a plugin inside the run-web.sh container');

const PLUGINS = '/home/fpp/media/plugins';
const PLUGIN = 'fpp-tests-p';

test.beforeAll(() => {
  inPlayer('sh', '-c', `mkdir -p ${PLUGINS}/${PLUGIN}/.git &&
    echo '{"name":"fpp-tests-p","repoName":"fpp-tests-p"}' > ${PLUGINS}/${PLUGIN}/pluginInfo.json &&
    printf '[remote "origin"]\\n\\turl = https://fpp-tests:FPP-TESTS-SECRET@example.invalid/x.git\\n' > ${PLUGINS}/${PLUGIN}/.git/config &&
    echo 'fpp-tests content' > ${PLUGINS}/${PLUGIN}/content.txt`);
});

test.afterAll(() => {
  inPlayer('rm', '-rf', `${PLUGINS}/${PLUGIN}`, `${PLUGINS}/plugin.php`, `${PLUGINS}/fpp-tests-upload.php`);
});

test('"." is not a plugin: a plugin.php in the plugins directory does not run', async ({ request }) => {
  inPlayer('sh', '-c', `echo '<?php echo "RAN" . (1 + 1);' > ${PLUGINS}/plugin.php`);
  try {
    const r = await request.get('/plugin.php?plugin=.&nopage=1');
    expect(await r.text()).not.toContain('RAN2');
  } finally {
    inPlayer('rm', '-f', `${PLUGINS}/plugin.php`);
  }
});

test("a plugin's .git/config is not served", async ({ request }) => {
  // Control: the plugin's ordinary files are.
  const ok = await request.get(`/plugin.php?plugin=${PLUGIN}&file=content.txt&nopage=1`);
  expect(await ok.text()).toContain('fpp-tests content');

  const r = await request.get(`/plugin.php?plugin=${PLUGIN}&file=.git/config&nopage=1`);
  expect(await r.text()).not.toContain('FPP-TESTS-SECRET');
});

test('the file API does not write into the plugins directory', async ({ request }) => {
  const r = await request.post('/api/file/plugins/fpp-tests-upload.php', { data: '<?php echo "RAN";' });
  const there = inPlayer('sh', '-c', `test -e ${PLUGINS}/fpp-tests-upload.php && echo yes || echo no`).trim();
  expect(there, `POST /api/file/plugins/...: ${r.status()} ${await r.text()}`).toBe('no');
});
