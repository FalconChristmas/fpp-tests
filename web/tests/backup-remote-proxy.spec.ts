import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingFile, keepingSettings } from './privacy-helpers';
import { answerUpdateCheck } from './standin-http';
import { SecondPlayer } from './second-player';

// The backup page's remote half -- a remote player's storage, its backup
// folders, whether it runs rsyncd -- goes through this player's API with
// ?ip=<remote>, which asks the remote server-side, so the browser never makes
// a cross-origin request and the CSP needs no entry per remote.  The remote
// is a second real player next to this one (second-player.ts), with a backup
// folder of its own.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const CSP_JSON = '/home/fpp/media/config/csp_allowed_domains.json';

const MARK = 'fpp-tests-remote-backups';

function remote() {
  const peer = new SecondPlayer('backup').start();
  peer.sh(`mkdir -p /home/fpp/media/backups/${MARK}`);
  return peer;
}

function stopRemote(peer: SecondPlayer) {
  const verdict = peer.stop();
  expect.soft(verdict.ok, verdict.detail).toBe(true);
}

test('a remote\'s backup storage is asked for through this player', async ({ page, baseURL }) => {
  // Regression: 5cd3a6903.  The page asked each remote itself, cross-origin,
  // which needed every known remote added to the CSP's connect-src (and could
  // not name an IPv6 one at all).
  test.setTimeout(240_000);
  const peer = remote();
  try {
    const crossOrigin: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).origin !== new URL(baseURL!).origin) crossOrigin.push(r.url());
    });
    await answerUpdateCheck(page);
    await keepingSettings(async () => {
      await page.goto('/backup.php');
      await page.click('#backups-fileCopy-tab');
      await page.selectOption('#backup\\.Direction', 'FROMREMOTE');
      // The remote isn't one this player's fppd knows, so the host list is
      // made just it, once the page's own lookups for whatever host it listed
      // first (one that may never answer) are over.
      await page.waitForLoadState('networkidle');
      const devices = page.waitForResponse((r) => r.url().includes(`api/backups/devices?ip=${peer.address}`));
      await page.evaluate((ip) => {
        const sel = document.getElementById('backup.Host') as HTMLSelectElement;
        sel.innerHTML = '';
        sel.add(new Option(`${ip} - fpp-tests-remote`, ip));
        sel.value = ip;
        (window as any).GetRemoteHostUSBStorage();
      }, peer.address);
      // The remote's own answer, through this player.
      const answered = await devices;
      expect(answered.status()).toBe(200);
      expect(await answered.json()).toEqual(peer.get('/api/backups/devices'));
      await expect(page.locator('#backup\\.RemoteStorage option').first()).toHaveText('Default FPP Storage');
    });
    expect(crossOrigin.filter((u) => u.includes(peer.address)), crossOrigin.join('\n')).toEqual([]);
  } finally {
    stopRemote(peer);
  }
});

test('the backups and settings APIs answer for a remote, and refuse a non-address', async ({ request }) => {
  // Feature: 5cd3a6903 (GET /api/backups/... and /api/settings/<name> with ?ip=).
  // Each answer is the remote's own.
  test.setTimeout(240_000);
  const peer = remote();
  try {
    const list = await (await request.get(`/api/backups/list?ip=${peer.address}`)).json();
    expect(list).toContain(MARK);
    expect(list).toEqual(peer.get('/api/backups/list'));
    expect(await (await request.get(`/api/backups/devices?ip=${peer.address}`)).json()).toEqual(peer.get('/api/backups/devices'));
    const rsync = await (await request.get(`/api/settings/Service_rsync?ip=${peer.address}`)).json();
    expect(rsync.name).toBe('Service_rsync');
    expect(rsync).toEqual(peer.get('/api/settings/Service_rsync'));
    for (const path of ['/api/backups/list', '/api/settings/Service_rsync']) {
      const r = await request.get(`${path}?ip=${encodeURIComponent('example.com')}`);
      expect(r.status(), path).toBe(400);
    }
  } finally {
    stopRemote(peer);
  }
});

test('regenerating the CSP drops the per-remote address entries older backup pages added', async () => {
  // Regression: 5cd3a6903.  The entries the old backup page wrote into the
  // CSP override file stayed there for good.
  await keepingFile(CSP_JSON, async () => {
    const seeded = {
      'default-src': [], 'img-src': [], 'script-src': [], 'style-src': [], 'object-src': [], 'font-src': [],
      'connect-src': ['http://192.0.2.50', 'http://192.0.2.51:8080', 'http://[2001:db8::1]', 'https://fpp-tests.example.com'],
    };
    inPlayer('sh', '-c', `echo '${JSON.stringify(seeded)}' > ${CSP_JSON}`);
    inPlayer('bash', '/opt/fpp/scripts/ManageApacheContentPolicy.sh', 'regenerate-norestart');
    const after = JSON.parse(inPlayer('cat', CSP_JSON));
    expect(after['connect-src']).toEqual(['https://fpp-tests.example.com']);
  });
  // The generated config, from the file as it was again (Apache was not
  // reloaded, so what it serves never changed).
  inPlayer('bash', '/opt/fpp/scripts/ManageApacheContentPolicy.sh', 'regenerate-norestart');
});
