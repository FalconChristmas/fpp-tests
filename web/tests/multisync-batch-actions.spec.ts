import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, docker, inPlayer, playerAddress } from './container';

// Upgrading a whole fleet from the MultiSync page leaves the player usable
// while it runs.  The browser holds at most 6 HTTP/1.1 connections to one
// host, shared by every tab: a page that keeps a long request open per system
// stalls everything else on the player until they finish.  The remotes here
// are eight addresses of one host next to the player that takes every
// connection and never answers, so every upgrade hangs for as long as the
// player keeps trying.  The systems list and status batch are answered by the
// test; the upgrades and the request timed alongside them are real.

const LOCAL = '192.168.0.13';
let REMOTES: string[] = [];
let SYSTEMS: any;
let STATUS: Record<string, unknown>;

const SILENT = `
import socketserver, time
class H(socketserver.BaseRequestHandler):
    def handle(self):
        time.sleep(600)
class S(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True
S(("0.0.0.0", 80), H).serve_forever()
`;

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

function build() {
  SYSTEMS = {
    systems: [
      system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1),
      ...REMOTES.map((ip, i) => system(ip, `fpptests-remote-${i}`, `M1-fpptests-remote-${i}`)),
    ],
  };
  STATUS = Object.fromEntries(REMOTES.map((ip) => [ip, {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: {
      Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
      LocalGitVersion: 'aaa1111', RemoteGitVersion: 'bbb2222', UpgradeSource: 'github.com',
      Utilization: { CPU: 12, Memory: 34 },
    },
  }]));
}

const silentHost = `fpp-tests-silent-${process.pid}`;

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test.beforeAll(() => {
  const { ip, network } = playerAddress();
  const base = ip.split('.').slice(0, 3).join('.');
  REMOTES = Array.from({ length: 8 }, (_, i) => `${base}.${200 + i}`);
  build();
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  const prefix = docker('network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}}{{end}}', network).trim().split('/')[1];
  const addrs = REMOTES.map((a) => `ip addr add ${a}/${prefix} dev eth0`).join(' && ');
  docker('run', '-d', '--rm', '--cap-add', 'NET_ADMIN', '--network', network, '--name', silentHost, image,
    'sh', '-c', `${addrs} && exec python3 -c '${SILENT}'`);
});

test.afterAll(() => {
  try {
    docker('rm', '-f', silentHost);
  } catch {
    // already gone
  }
});

async function openMultisync(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1400 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: STATUS }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(1 + REMOTES.length, { timeout: 15_000 });
}

test('the player answers while eight remotes are being upgraded', async ({ page }) => {
  // Regression: 504be3562.  Each system's upgrade was a stream of its own
  // from the page: eight of them took every connection the browser allows
  // to the player, so its status polls -- and any other tab on it -- waited
  // until systems finished.  Now the batch runs over one connection.
  test.setTimeout(120_000);
  // The silent host takes connections on every one of its addresses.
  await expect.poll(() => REMOTES.filter((ip) => {
    try {
      inPlayer('python3', '-c', `import socket; socket.create_connection(("${ip}", 80), 2).close()`);
      return true;
    } catch {
      return false;
    }
  }).length, { timeout: 15_000 }).toBe(REMOTES.length);
  page.on('dialog', (d) => d.accept());
  // Which systems an upgrade was sent for, however the page sends it.
  const upgrading = new Set<string>();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith('/streamRemoteJobs.php')) {
      for (const j of r.postDataJSON()?.jobs || []) upgrading.add(j.ip);
    } else if (u.pathname.endsWith('/streamRemote.php') && u.searchParams.get('action') === 'upgrade') {
      upgrading.add(u.searchParams.get('ip') || '');
    }
  });
  await openMultisync(page);
  const timed = () => page.evaluate(async () => {
    const t0 = performance.now();
    try {
      const r = await fetch('api/fppd/version', { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      await r.text();
    } catch {
      // timed out: the elapsed time says so
    }
    return performance.now() - t0;
  });
  // The page's own start-up requests can hold the connections for a few
  // seconds; this waits them out, so the request below times the upgrades.
  await timed();
  for (const ip of REMOTES) {
    const row = page.locator('#fppSystems tr.systemRow').filter({ has: page.locator(`#fpp_${ip.replace(/\./g, '_')}_hostname`) });
    await expect(row).toContainText('master');
    await row.locator('input.remoteCheckbox').check();
  }
  await page.evaluate('upgradeSelectedSystems()');
  await expect.poll(() => upgrading.size, { message: 'upgrades sent' }).toBe(REMOTES.length);
  // Let the upgrades get going.
  await page.waitForTimeout(3000);
  const ms = await timed();
  expect(ms, `a request to the player took ${Math.round(ms)} ms during the upgrades`).toBeLessThan(3000);
});
