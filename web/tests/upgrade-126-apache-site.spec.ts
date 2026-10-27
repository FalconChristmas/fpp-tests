import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { exists, putFile, readFile } from './settings-file';

// Upgrade 126 on a player whose deployed Apache site predates the plugin-route
// rules: what Apache serves afterwards.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SITE = '/etc/apache2/sites-enabled/000-default.conf';
const SHIPPED = '/opt/fpp/etc/apache2.site';
// fppd's list of every route it serves, which Apache is to keep to itself.
const INTERNAL = '/api/plugin-apis/internal/pluginApiRoutes';

const status = async (request: any, path: string) => (await request.get(path, { maxRedirects: 0 })).status();

// Regression: 0395e0eb5.  etc/apache2.site gained a rule refusing fppd's
// /api/plugin-apis/internal/* (its route introspection) through Apache,
// but the site is copied to sites-enabled only at install, so an upgraded
// player kept passing those requests on to fppd.  Upgrade 126 recopies it.
// The stale site here is the shipped one without that rule; Apache is
// reloaded (the step's own reload needs systemd, which the player lacks) and
// the request is made through it.
test('upgrade 126 brings a stale Apache site up to the shipped one', async ({ request }) => {
  const had = exists(SITE);
  const saved = had ? readFile(SITE) : '';
  const shipped = readFile(SHIPPED);
  const stale = shipped.split('\n').filter((l) => !/^\s*RewriteRule \^plugin-apis\/internal/.test(l)).join('\n');
  try {
    // The control: the stale site really lacks the rule, and Apache serving
    // it hands the request to fppd, which answers it.
    expect(stale).not.toBe(shipped);
    putFile(SITE, stale);
    inPlayer('apache2ctl', 'graceful');
    await expect.poll(() => status(request, INTERNAL), { timeout: 10_000 }).toBe(200);

    const out = inPlayer('sh', '-c', 'bash /opt/fpp/upgrade/126/upgrade.sh 2>&1; echo rc=$?');
    expect(out).toContain('rc=0');
    expect(readFile(SITE), 'the deployed site is not the shipped one').toBe(shipped);
    expect(inPlayer('sh', '-c', 'apache2ctl -t 2>&1; echo rc=$?')).toContain('rc=0');
    inPlayer('apache2ctl', 'graceful');
    await expect.poll(() => status(request, INTERNAL), { timeout: 10_000 }).toBe(403);
    // The rest of the API still answers.
    expect(await status(request, '/api/fppd/version')).toBe(200);
  } finally {
    if (had) putFile(SITE, saved);
    inPlayer('apache2ctl', 'graceful');
    await expect.poll(() => status(request, '/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  }
});
