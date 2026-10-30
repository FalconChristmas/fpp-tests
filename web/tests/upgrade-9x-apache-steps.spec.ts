import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, settingInFile, setSettingInFile } from './settings-file';

// The 9.x upgrade steps that move a player onto FPP's own Apache config
// (92-98), each run on a player left as an older FPP had it: what Apache
// serves afterwards, and the settings the page then reads.  A step's own
// reload needs systemd, which the player lacks, so Apache is reloaded here
// before each request, as the step or the reboot it asks for would.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SITE = '/etc/apache2/sites-enabled/000-default.conf';
const SHIPPED_SITE = '/opt/fpp/etc/apache2.site';
const STATUS_CONF = '/etc/apache2/mods-enabled/status.conf';
const CSP = '/opt/fpp/etc/apache2.csp';
const UIPW = `${MEDIA}/config/ui-password-config.conf`;
const OLD_PROXIES = `${MEDIA}/config/proxies`;
const NEW_PROXIES = `${MEDIA}/config/proxy-config.conf`;
const PROXY_HTACCESS = '/opt/fpp/www/proxy/.htaccess';

// Run upgrade/<n>/upgrade.sh as upgrade_config does (from its directory);
// its output and exit status.
function step(n: number): string {
  return inPlayer('sh', '-c', `cd /opt/fpp/upgrade/${n} && ./upgrade.sh 2>&1; echo rc=$?`);
}

function graceful() {
  expect(inPlayer('sh', '-c', 'apache2ctl -t 2>&1; echo rc=$?'), 'Apache refuses the config').toContain('rc=0');
  inPlayer('apache2ctl', 'graceful');
}

// expect.poll's soft form, so one test reports every effect a step missed.
const soft = expect.configure({ soft: true });

const head = async (request: any, path: string) => request.get(path, { maxRedirects: 0 });

// Apache answering again after a graceful restart, on a page that answers
// whatever the step did to the config.
async function apacheUp(request: any) {
  await expect.poll(async () => (await head(request, '/api/fppd/version')).status(), { timeout: 10_000 }).toBe(200);
}

// What a test changes, put back afterwards: files (or their absence) and the
// rebootFlag the steps set.
function keep(paths: string[]): () => void {
  const saved = paths.map((p) => ({ p, had: exists(p), body: exists(p) ? readFile(p) : '' }));
  const flag = settingInFile('rebootFlag');
  return () => {
    for (const s of saved) {
      if (s.had) putFile(s.p, s.body);
      else inPlayer('rm', '-f', s.p);
    }
    setSettingInFile('rebootFlag', flag);
  };
}

// Regression: 48b571aec, 5dd8bb9b9.  The site FPP ships sets each asset's
// cache lifetime with mod_expires, which an older install never enabled;
// upgrade 92 enables it (48b571aec) and, rather than restart Apache under a
// running UI, flags a reboot (5dd8bb9b9), which the page's banner reads.
// The player here has mod_expires off: a stylesheet goes out with no
// Cache-Control at all until the step has run.
test('upgrade 92 enables mod_expires for the shipped site and flags a reboot', async ({ request }) => {
  const restore = keep([SITE]);
  const css = '/css/filepond.min.css';
  try {
    inPlayer('sh', '-c', 'a2dismod -f expires >/dev/null 2>&1');
    setSettingInFile('rebootFlag', '0');
    graceful();
    // The control: without mod_expires nothing sets the stylesheet's lifetime.
    await expect.poll(async () => (await head(request, css)).headers()['cache-control'] ?? 'none',
      { timeout: 10_000 }).toBe('none');

    const out = step(92);
    graceful();
    await soft.poll(async () => (await head(request, css)).headers()['cache-control'] ?? 'none',
      { timeout: 10_000, message: `mod_expires is still off after upgrade 92:\n${out}` }).toContain('max-age=31536000');
    expect.soft(String((await (await request.get('/api/settings/rebootFlag')).json()).value),
      `upgrade 92 did not flag a reboot:\n${out}`).toBe('1');
  } finally {
    inPlayer('sh', '-c', 'a2enmod expires >/dev/null 2>&1');
    restore();
    graceful();
    await apacheUp(request);
  }
});

// Regression: ff1405ede, 5dd8bb9b9.  Upgrade 93 replaces whatever
// mods-enabled/status.conf a player has with FPP's, which serves
// /server-status (Apache's live request list) to the player itself only,
// and flags a reboot rather than restarting Apache (5dd8bb9b9).  Debian's
// own status.conf already says "Require local", so the stale config here
// is one opened to every host; the request from this test reaches the
// player from outside it.
test('upgrade 93 locks /server-status to the player itself and flags a reboot', async ({ request }) => {
  const restore = keep([STATUS_CONF]);
  try {
    putFile(STATUS_CONF, '<Location /server-status>\n    SetHandler server-status\n    Require all granted\n</Location>\n');
    setSettingInFile('rebootFlag', '0');
    graceful();
    await expect.poll(async () => (await head(request, '/server-status')).status(), { timeout: 10_000 }).toBe(200);

    const out = step(93);
    graceful();
    await soft.poll(async () => (await head(request, '/server-status')).status(),
      { timeout: 10_000, message: `/server-status still open to other hosts after upgrade 93:\n${out}` }).toBe(403);
    // The player itself still gets it (the troubleshooting page reads it so).
    expect.soft(inPlayer('sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/server-status?auto')).toBe('200');
    expect.soft(String((await (await request.get('/api/settings/rebootFlag')).json()).value),
      `upgrade 93 did not flag a reboot:\n${out}`).toBe('1');
  } finally {
    restore();
    graceful();
    await apacheUp(request);
  }
});

// Regression: 4e8345970.  The content policy moved out of the site into
// etc/apache2.csp, pulled in by an IncludeOptional; upgrade 94 recopies the
// site so an upgraded player picks that file up.  The stale site here is the
// shipped one without the include: its pages go out with no policy.
test('upgrade 94 brings in the site that includes the content policy', async ({ request }) => {
  const restore = keep([SITE]);
  try {
    const shipped = readFile(SHIPPED_SITE);
    const stale = shipped.split('\n').filter((l) => !/IncludeOptional\s+\/opt\/fpp\/etc\/apache2\.csp/.test(l)).join('\n');
    expect(stale).not.toBe(shipped);
    putFile(SITE, stale);
    graceful();
    await expect.poll(async () => (await head(request, '/index.php')).headers()['content-security-policy'] ?? 'none',
      { timeout: 10_000 }).toBe('none');

    const out = step(94);
    expect.soft(readFile(SITE), `upgrade 94 left the stale site:\n${out}`).toBe(shipped);
    graceful();
    await soft.poll(async () => (await head(request, '/index.php')).headers()['content-security-policy'] ?? 'none',
      { timeout: 10_000, message: `no content policy after upgrade 94:\n${out}` }).toContain("default-src");
  } finally {
    restore();
    graceful();
    await apacheUp(request);
  }
});

// Regression: 18c7a62d2.  2e10680c7 added 'unsafe-eval' to script-src
// in the generator (the file manager's table sorting of the time needed
// it), but apache2.csp is written only when the policy is regenerated;
// upgrade 95 regenerates it.  The stale policy here is the current one
// without 'unsafe-eval', and the check is the policy Apache sends.  (Today's
// file manager no longer trips without it: no violation shows in the page.)
test('upgrade 95 regenerates the content policy Apache sends', async ({ request }) => {
  const restore = keep([CSP]);
  const policy = async () => (await head(request, '/filemanager.php')).headers()['content-security-policy'] ?? '';
  try {
    const current = readFile(CSP);
    expect(current).toContain("'unsafe-eval'");
    putFile(CSP, current.replace(/\s*'unsafe-eval'/g, ''));
    graceful();
    await expect.poll(policy, { timeout: 10_000 }).not.toContain("'unsafe-eval'");

    const out = step(95);
    graceful();
    await soft.poll(policy, { timeout: 10_000, message: `upgrade 95 left the stale policy:\n${out}` })
      .toMatch(/script-src [^;]*'unsafe-eval'/);
  } finally {
    restore();
    graceful();
    await apacheUp(request);
  }
});

// Regression: 7848b906f, 9e9c9b5aa, e5d30889e.  Proxies used to be rewrite
// rules in config/proxies, an .htaccess that www/proxy/.htaccess linked to;
// the site now includes config/proxy-config.conf instead.  Upgrade 97
// carries each proxied host's rule and its "# D:" description across
// (7848b906f), reading the old file as the rules it is (9e9c9b5aa: the first
// version took each line's first word for a host, so every host came across
// as "RewriteRule" and every description was dropped as a comment), and
// removes the link (e5d30889e; nothing reads it since the site set
// AllowOverride None there).  The proxies page lists what the new file holds.
test('upgrade 97 migrates the old proxies file to the included proxy config', async ({ request }) => {
  const restore = keep([SITE, CSP, OLD_PROXIES, NEW_PROXIES, PROXY_HTACCESS]);
  try {
    putFile(OLD_PROXIES, [
      'RewriteEngine on',
      'RewriteBase /proxy/',
      '',
      '# D:Front yard controller',
      'RewriteRule ^192.168.40.11$  192.168.40.11/  [R,L]',
      'RewriteRule ^192.168.40.11/(.*)$  http://192.168.40.11/$1  [P,L]',
      '',
      'RewriteRule ^192.168.40.12$  192.168.40.12/  [R,L]',
      'RewriteRule ^192.168.40.12/(.*)$  http://192.168.40.12/$1  [P,L]',
      '',
      'RewriteRule ^(.*)/(.*)$  http://$1/$2  [P,L]',
      '',
    ].join('\n'));
    inPlayer('rm', '-f', NEW_PROXIES);
    inPlayer('ln', '-sf', OLD_PROXIES, PROXY_HTACCESS);

    const out = step(97);
    expect(exists(NEW_PROXIES), `upgrade 97 wrote no proxy config:\n${out}`).toBe(true);
    graceful();
    const list = (await (await request.get('/api/proxies')).json())
      .map((p: any) => ({ host: p.host, description: p.description }));
    expect.soft(list, `the proxies the page lists after upgrade 97:\n${readFile(NEW_PROXIES)}\n${out}`).toEqual([
      { host: '192.168.40.11', description: 'Front yard controller' },
      { host: '192.168.40.12', description: '' },
    ]);
    // The catch-all rule is the site's job now, and not carried over.
    expect.soft(readFile(NEW_PROXIES)).not.toContain('^(.*)');
    expect.soft(inPlayer('sh', '-c', `test -L ${PROXY_HTACCESS} && echo linked || echo gone`).trim(),
      `upgrade 97 left www/proxy/.htaccess:\n${out}`).toBe('gone');
  } finally {
    restore();
    graceful();
    await apacheUp(request);
  }
});

// Regression: 818b0f32b.  The UI password moved from config/.htaccess into
// config/ui-password-config.conf, included in the site's <Directory>, where
// everything else allows the player itself only; upgrade 98 deletes the old
// .htaccess files and must write the new file, or every other host is
// refused the UI until the next boot (fppinit writes one then).
test('upgrade 98 writes the UI password config that opens the UI to other hosts', async ({ request }) => {
  const restore = keep([SITE, UIPW]);
  try {
    inPlayer('rm', '-f', UIPW);
    graceful();
    await expect.poll(async () => (await head(request, '/index.php')).status(), { timeout: 10_000 }).toBe(403);

    const out = step(98);
    graceful();
    await soft.poll(async () => (await head(request, '/index.php')).status(),
      { timeout: 10_000, message: `the UI is still refused after upgrade 98:\n${out}` }).toBe(200);
  } finally {
    restore();
    graceful();
    await apacheUp(request);
  }
});
