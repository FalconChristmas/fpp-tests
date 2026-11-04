import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// What the small helper pages and a few page parameters do with hostile
// input.  Each fix below was a bug-bounty report (huntr.dev) against 5.0: the
// value was echoed into the page or passed to a shell.  None had a test.

const IMG = '<img src=x onerror=alert(1)>';

test('ping.php refuses a host that is markup and shows none of it', async ({ request }) => {
  // bf96b436d, 4c10baaf9: the host was echoed into the page and run in a shell.
  const r = await request.get(`/ping.php?ip=${encodeURIComponent(IMG)}`);
  const body = await r.text();
  expect(body).not.toContain('<img');
  expect(body).toContain('Invalid host name or address');
});

test('ping.php does not run a command put after the host', async ({ request }) => {
  // 4c10baaf9: os command injection through the host.
  const r = await request.get(`/ping.php?ip=${encodeURIComponent('127.0.0.1; echo fpptestsinjected')}`);
  expect(await r.text()).not.toContain('fpptestsinjected');
});

for (const helper of ['shutdownRemoteFPP.php', 'rebootRemoteFPP.php', 'restartRemoteFPPD.php']) {
  test(`${helper} echoes a bad address escaped, and calls nothing`, async ({ request }) => {
    // 1cfdc526b, 40a636c6e (shutdown), 10f102bff (reboot), 8f3847a0c (restart).
    const r = await request.get(`/${helper}?ip=${encodeURIComponent('<b>x</b><script>y</script>')}`);
    const body = await r.text();
    expect(body).not.toContain('<b>');
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;b&gt;');
    expect(body).toMatch(/not a valid IP address|Invalid IP/);
  });
}

test('shutdownRemoteFPP.php refuses a name that is not an address', async ({ request }) => {
  // 40a636c6e
  const r = await request.get('/shutdownRemoteFPP.php?ip=notanip');
  expect(await r.text()).toContain('notanip is not a valid IP address');
});

test('runEventScript.php shows an unknown script name escaped', async ({ request }) => {
  // b23678241, f032d800a: the name was echoed as markup.
  const r = await request.get(`/runEventScript.php?scriptName=${encodeURIComponent(IMG)}`);
  const body = await r.text();
  expect(body).toContain('Unknown script');
  expect(body).not.toContain('<img');
  expect(body).toContain('&lt;img');
});

test('playlists.php carries ?playlist= into its script as text', async ({ request }) => {
  // 8d69be318, 30a2d62c3: a quote and a closing script tag broke out of the string.
  const payload = '";</script><script>alert(1)//';
  const r = await request.get(`/playlists.php?playlist=${encodeURIComponent(payload)}`);
  const body = await r.text();
  expect(body).not.toContain('</script><script>alert(1)');
  expect(body).toMatch(/var initialPlaylist = "&quot;;&lt;\/script&gt;/);
});

test('backup.php does not copy a non-numeric ?tab= into its script', async ({ request }) => {
  // 244e8ff55
  const r = await request.get(`/backup.php?tab=${encodeURIComponent("1';alert(1)//")}`);
  const body = await r.text();
  expect(body).not.toContain("';alert(1)");
  expect(body).not.toContain("1';alert");
});

test('virtualdisplay.php takes ?width= as a number only', async ({ request }) => {
  // 6f1032331
  const r = await request.get(`/virtualdisplay.php?width=${encodeURIComponent('1"><script>alert(1)</script>')}`);
  const body = await r.text();
  expect(body).not.toContain('><script>alert(1)</script>');
});

test('gitCheckoutVersion.php refuses a version with shell characters', async ({ request }) => {
  // 7547051c7, 59b7f7e80, 02948843f, 3c9da56f2
  const r = await request.get(`/gitCheckoutVersion.php?version=${encodeURIComponent('a;id')}`);
  expect(r.status()).toBe(400);
  expect(await r.text()).toContain('Invalid version');
});

test('changebranch.php refuses a branch with shell characters', async ({ request }) => {
  // 696f0ced6
  const r = await request.get(`/changebranch.php?branch=${encodeURIComponent('a;id')}`);
  expect(r.status()).toBe(400);
  expect(await r.text()).toContain('Invalid branch');
});

test('a plugin page that includes pluginconfig.php does not print the config path', async ({ page }) => {
  // 24adba429 left a debug echo of the plugin's config file path at the top of
  // pluginconfig.php, so every plugin page that includes it printed
  // "/home/fpp/media/config/plugin.<name>".
  test.skip(!container, 'writes a plugin into the run-web.sh container');
  test.fail(true, 'known leftover echo in www/pluginconfig.php: remove this line once the echo is gone');
  const PLUGIN = 'fpp-tests-pluginconfig';
  const DIR = `/home/fpp/media/plugins/${PLUGIN}`;
  inPlayer('mkdir', '-p', DIR);
  inPlayer('sh', '-c', `printf %s '${JSON.stringify({ name: PLUGIN, repoName: PLUGIN, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }] })}' > ${DIR}/pluginInfo.json`);
  inPlayer('sh', '-c', `printf %s "<?php include_once '/opt/fpp/www/pluginconfig.php'; ?><div id=ok>ok</div>" > ${DIR}/content.php`);
  try {
    await page.goto(`/plugin.php?plugin=${PLUGIN}&page=content.php&nopage=1`);
    await expect(page.locator('#ok')).toHaveCount(1);
    expect(await page.content()).not.toContain('config/plugin.');
  } finally {
    inPlayer('rm', '-rf', DIR);
  }
});
