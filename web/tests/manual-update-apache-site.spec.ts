import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile, readFile, snapshotSettings } from './settings-file';
import { keepingFile } from './privacy-helpers';

// After pulling, manualUpdate.php (the About page's update) compares the
// tree's etc/apache2.site with the live site config and copies it across when
// they differ, so an update that changes the site config takes it with it.
// Feature: 83f7f8afd.
//
// Pulling and rebuilding in the test player takes too long, and restarting
// fppd would leave run-web.sh's fppd behind, so git_pull is replaced by one
// that succeeds having done nothing, and fppd_restart by a no-op, for the
// length of the test.

test.skip(!container, 'edits the live Apache config inside the run-web.sh container');

const SITE = '/opt/fpp/etc/apache2.site';
// sites-enabled/000-default.conf is a link to this.
const LIVE = '/etc/apache2/sites-available/000-default.conf';
const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';

function replaceScript(name: string, body: string) {
  const path = `/opt/fpp/scripts/${name}`;
  inPlayer('sh', '-c', `cp -p ${path} ${path}.fpp-tests && echo ${Buffer.from(body).toString('base64')} | base64 -d > ${path} && chmod 755 ${path}`);
  return () => inPlayer('sh', '-c', `mv ${path}.fpp-tests ${path}`);
}

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('an update copies a changed site config into the live Apache config, and leaves a current one alone', async ({ request }) => {
  test.setTimeout(120_000);
  const md5 = (f: string) => inPlayer('md5sum', f).split(' ')[0];
  inPlayer('cp', '-p', LIVE, `${LIVE}.fpp-tests`);
  const restores = [replaceScript('git_pull', '#!/bin/sh\necho "fpp-tests: nothing to pull"\nexit 0\n'),
    replaceScript('fppd_restart', '#!/bin/sh\nexit 0\n')];
  try {
    // The live config as an older FPP left it.
    inPlayer('sh', '-c', `printf '\\n# fpp-tests: left by an older FPP\\n' >> ${LIVE}`);
    expect(md5(LIVE)).not.toBe(md5(SITE));

    const out = await (await request.post('/manualUpdate.php?wrapped=1', { timeout: 90_000 })).text();
    // The control: the stand-in ran, and the update went on past it.
    expect(out).toContain('fpp-tests: nothing to pull');
    expect(out).toContain('Updating Apache config');
    expect(md5(LIVE), 'the live config was left as it was').toBe(md5(SITE));
    // The receiving end: Apache accepts the config it now has.
    expect(inPlayer('sh', '-c', 'apache2ctl -t 2>&1; echo rc=$?')).toMatch(/Syntax OK[\s\S]*rc=0/);

    const again = await (await request.post('/manualUpdate.php?wrapped=1', { timeout: 90_000 })).text();
    expect(again).toContain('Apache config is already up to date');
    expect(again).not.toContain('Updating Apache config');
  } finally {
    for (const r of restores) r();
    inPlayer('sh', '-c', `mv ${LIVE}.fpp-tests ${LIVE}; rm -f ${LOG}`);
  }
});

// The update then regenerates the CSP (etc/apache2.csp, the defaults plus the
// media directory's config/csp_allowed_domains.json) and reloads Apache, so a
// source allowed since the last regenerate is served from then on.
// Feature: f8f171cb3 ("add CSP regeneration to FPPUpdate").
// Regression: fpp 2de294b4c.  The call named scripts/ManageApacheContentPolicy,
// without its .sh: sudo answered "command not found" into php-fpm's stderr,
// so no update ever regenerated the policy or reloaded Apache.
const CSP_FILE = '/opt/fpp/etc/apache2.csp';
const OVERRIDES = '/home/fpp/media/config/csp_allowed_domains.json';

test('an update regenerates the CSP, and Apache serves a source allowed since', async ({ request }) => {
  test.setTimeout(120_000);
  const connectSrc = async () => ((await request.get('/index.php')).headers()['content-security-policy'] ?? '')
    .split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'connect-src') ?? [];
  const added = 'https://update.fpp-tests.invalid';
  const before = (await request.get('/index.php')).headers()['content-security-policy'] ?? '';
  expect(before, "run-web.sh's player serves a generated CSP").toContain('connect-src');
  // The player has no systemd: this systemctl hands "reload apache2" (what
  // the script's reload asks for) to the real Apache, and anything else on.
  const state = '/tmp/fpp-tests-update-systemctl';
  inPlayer('sh', '-c', `rm -rf ${state} && mkdir -p ${state} && cp -a /usr/bin/systemctl ${state}/systemctl.real && : > ${state}/calls`);
  putFile('/usr/bin/systemctl', `#!/bin/sh
echo "$*" >> ${state}/calls
case "$*" in
  "is-active --quiet apache2") exit 0 ;;
  "reload apache2") exec apache2ctl graceful ;;
esac
exec ${state}/systemctl.real "$@"
`);
  inPlayer('chmod', '755', '/usr/bin/systemctl');
  const restores = [replaceScript('git_pull', '#!/bin/sh\necho "fpp-tests: nothing to pull"\nexit 0\n'),
    replaceScript('fppd_restart', '#!/bin/sh\nexit 0\n')];
  try {
    await keepingFile(CSP_FILE, () => keepingFile(OVERRIDES, async () => {
      // Allowed by hand in the override file, which only a regenerate reads.
      const overrides = JSON.parse(readFile(OVERRIDES));
      overrides['connect-src'] = [...(overrides['connect-src'] ?? []), added];
      putFile(OVERRIDES, JSON.stringify(overrides, null, 2));
      expect(await connectSrc()).not.toContain(added);

      const out = await (await request.post('/manualUpdate.php?wrapped=1', { timeout: 90_000 })).text();
      // The control: the stand-in ran, and the update went on past it.
      expect(out).toContain('fpp-tests: nothing to pull');
      expect(readFile(CSP_FILE), 'the policy was not regenerated').toContain(added);
      // The receiving end: Apache was reloaded and serves the new policy.
      await expect.poll(connectSrc, { message: 'Apache does not serve the regenerated policy', timeout: 15_000 }).toContain(added);
      expect(inPlayer('cat', `${state}/calls`).split('\n')).toContain('reload apache2');
    }));
  } finally {
    for (const r of restores) r();
    inPlayer('sh', '-c', `cp -a ${state}/systemctl.real /usr/bin/systemctl; rm -rf ${state} ${LOG}`);
    inPlayer('apache2ctl', 'graceful');
    await expect.poll(async () => (await request.get('/index.php')).headers()['content-security-policy'] ?? '',
      { message: 'the original policy is served again', timeout: 15_000 }).toBe(before);
  }
});
