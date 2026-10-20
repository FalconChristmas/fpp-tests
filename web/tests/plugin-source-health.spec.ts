import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The "Unknown Plugins" health check names the plugins that raised it, and
// says whether each is still installed.  Fixed in fpp b7dee3cb9
// ("fix(plugins): name unknown plugins in the health check, reset on FPPOS
// upgrade"); before it /api/plugin/source only said {"level":"unknown"}, which
// on a box whose installed plugins are all listed read as a false alarm about
// them, when a since-removed third-party plugin had raised the flag.

test.skip(!container, 'seeds settings and a plugin inside the run-web.sh container');

const MEDIA = '/home/fpp/media';

test('the plugin source check names the unknown plugins and whether they are still installed', async ({ request }) => {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/plugins/fpp-tests-here &&
    echo '{"name":"fpp-tests-here","repoName":"fpp-tests-here"}' > ${MEDIA}/plugins/fpp-tests-here/pluginInfo.json &&
    printf '%s\\n' 'PluginUnknownEverInstalled = "1"' \\
      'PluginUnknownRepos = "fpp-tests-gone|https://example.invalid/gone.git,fpp-tests-here|https://example.invalid/here.git"' >> ${MEDIA}/settings`);
  try {
    const r = await request.get('/api/plugin/source');
    const body = await r.json();
    expect(body.level).toBe('unknown');
    const byName = Object.fromEntries(((body.plugins || []) as { repoName: string; installed: boolean }[])
      .map((p) => [p.repoName, p.installed]));
    expect(byName, JSON.stringify(body)).toEqual({ 'fpp-tests-gone': false, 'fpp-tests-here': true });
  } finally {
    inPlayer('sh', '-c', `rm -rf ${MEDIA}/plugins/fpp-tests-here; sed -i '/^PluginUnknown/d' ${MEDIA}/settings`);
  }
});
