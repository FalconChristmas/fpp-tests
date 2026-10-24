import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { FakeGitHub, StandIn, answerUpdateCheck, release } from './standin-http';
import { SecondPlayer } from './second-player';

// MultiSync's views of a remote player, and the actions it sends one.
// GET /api/channel/output/<file>?ip=<peer> fetches a peer's channel output
// config server-side (the browser's CSP keeps it off other origins), and the
// MultiSync page shows it when the channel-output icon is hovered.  The peer
// is a second real player next to this one (second-player.ts), except where
// it has to be at an IPv6 address, which the Docker network doesn't give a
// container: there it is a stand-in on the player's own ::1 (standin-http.ts).
// The page's view of the remote's status is answered by the test.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

function universeOutputs(description: string) {
  return {
    channelOutputs: [{
      type: 'universes', enabled: 1, startChannel: 1, channelCount: 1020,
      universes: [
        { active: 1, description, id: 1, startChannel: 1, universeCount: 2, channelCount: 510, type: 5, address: '192.0.2.40', priority: 0, monitor: 1 },
        { active: 0, description: 'fpp-tests-inactive', id: 3, startChannel: 1021, universeCount: 1, channelCount: 510, type: 1, address: '192.0.2.41', priority: 0, monitor: 1 },
      ],
    }],
    status: 'OK',
  };
}

test('a peer\'s output config is fetched through this player, and a non-address is refused', async ({ request }) => {
  // Feature: 8f89bcba9 (#2100).  The peer's own API answers.
  test.setTimeout(240_000);
  const peer = new SecondPlayer('co').start();
  try {
    peer.writeFile(`${PEER_MEDIA}/config/co-universes.json`, JSON.stringify(universeOutputs('fpp-tests-peer-out')));
    const own = peer.get('/api/channel/output/universeOutputs');
    const r = await (await request.get(`/api/channel/output/universeOutputs?ip=${peer.address}`)).json();
    expect(r.channelOutputs?.[0]?.universes?.[0]?.description, JSON.stringify(r)).toBe('fpp-tests-peer-out');
    expect(r).toEqual(own);

    // Anything but an IP address is never fetched.
    for (const bad of ['example.com', `${peer.address}/x`, `${peer.address}@192.0.2.1`]) {
      const e = await (await request.get(`/api/channel/output/universeOutputs?ip=${encodeURIComponent(bad)}`)).json();
      expect(e.status, bad).toBe('ERROR: Invalid IP address');
    }
  } finally {
    const verdict = peer.stop();
    expect(verdict.ok, verdict.detail).toBe(true);
  }
});

test('a peer at an IPv6 address is asked at a bracketed URL', async ({ request }) => {
  // Regression: 202c1a7e4.  The address went into http://<ip>/... as it was,
  // and http://::1/api/... is no URL at all: an IPv6 peer's config could
  // never be fetched ("Could not reach remote system").  The stand-in takes
  // the place of a real peer only for the address; the request it gets is
  // the one the test above sends a real player (the route is api/index.php's
  // GET /channel/output/:file).
  const peer = new StandIn('co-peer6', '::1', 80, { '/api/channel/output/universeOutputs': { json: universeOutputs('fpp-tests-peer6-out') } });
  try {
    peer.start();
    const r = await (await request.get('/api/channel/output/universeOutputs?ip=::1')).json();
    expect(r.channelOutputs?.[0]?.universes?.[0]?.description, JSON.stringify(r)).toBe('fpp-tests-peer6-out');
    expect(peer.requests().map((q) => [q.host, q.path])).toEqual([['[::1]', '/api/channel/output/universeOutputs']]);
  } finally {
    peer.stop();
  }
});

const LOCAL = '192.168.0.13';
const PEER_MEDIA = '/home/fpp/media';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '1-1020', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

function remoteStatus(extra: Record<string, unknown> = {}) {
  return {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: {
      Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
      LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', UpgradeSource: 'github.com',
      Utilization: { CPU: 12, Memory: 34 },
    },
    ...extra,
  };
}

// The remote is listed at each of `addresses` (fppd lists a remote once per
// address it pings from); they share its UUID, so they make one row.
async function openMultisync(page: Page, remote: string, status: Record<string, unknown>, addresses = [remote]) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await answerUpdateCheck(page);
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), ...addresses.map((a) => system(a, 'fpptests-remote', 'M1-fpptests-remote'))] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: Object.fromEntries(addresses.map((a) => [a, status])) }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  return page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
}

test('hovering a remote\'s channel-output icon shows its active outputs', async ({ page }) => {
  // Feature: 8f89bcba9 (#2100).  The config comes from the remote, a real
  // player, through api/channel/output/...?ip=.
  test.setTimeout(240_000);
  const peer = new SecondPlayer('co-hover').start();
  try {
    peer.writeFile(`${PEER_MEDIA}/config/co-universes.json`, JSON.stringify(universeOutputs('fpp-tests-hover-out')));
    const row = await openMultisync(page, peer.address, remoteStatus({ channelOutputsEnabled: true, channelInputsEnabled: false }));
    const icon = row.locator('.channel-io-icon-output');
    await expect(icon).toBeVisible({ timeout: 15_000 });
    await icon.hover();
    const pop = page.locator('.channel-io-popover');
    await expect(pop).toContainText('fpp-tests-hover-out', { timeout: 10_000 });
    await expect(pop).toContainText('DDP');
    await expect(pop).toContainText('1-1020');
    await expect(pop).not.toContainText('fpp-tests-inactive');
  } finally {
    const verdict = peer.stop();
    expect(verdict.ok, verdict.detail).toBe(true);
  }
});

test('a remote\'s wifi icon marks each of its addresses on the wireless interface', async ({ page }) => {
  // Regression: 9d0b2b9a9.  The icon went after one address per row only, the
  // polled one, so a wireless remote also showing its IPv6 address had that
  // one unmarked.
  const v4 = '192.168.0.21';
  const v6 = '2001:db8::21';
  const wifi = { interface: 'wlan0', link: 70, level: -48, pct: 100, unit: 'dBm', noise: 0, desc: 'excellent' };
  const row = await openMultisync(page, v4, remoteStatus({
    wifi: [wifi],
    interfaces: [
      { ifname: 'eth0', operstate: 'DOWN', addr_info: [] },
      { ifname: 'wlan0', operstate: 'UP', addr_info: [{ family: 'inet', local: v4, prefixlen: 24 }, { family: 'inet6', local: v6, prefixlen: 64 }], wifi },
    ],
  }), [v4, v6]);
  const cell = row.locator('td').filter({ hasText: v4 });
  // The control: the row shows both addresses.
  await expect(cell).toContainText(v6, { timeout: 15_000 });
  // Each address is followed by its own icon: two of them, one after each.
  await expect.poll(() => cell.locator('.wifi-icon').count(), { timeout: 15_000 }).toBe(2);
  const order = await cell.evaluate((td, ips) => {
    const html = td.innerHTML;
    return [html.indexOf(ips[0]), html.indexOf('wifi-icon'), html.indexOf(ips[1]), html.lastIndexOf('wifi-icon')];
  }, [v4, v6]);
  expect(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], cell.toString()).toBe(true);
});

test('an OS upgrade offers the remote\'s own images, and is sent to that remote', async ({ page, request }) => {
  // Feature: 312eca18a (#2570).  The images come from the remote, a real
  // player, through api/remoteAction?action=listUpgrades; the upgrade is the
  // remote's own upgradeOS.php for the picked image (a MultiSync job since).
  // The remote is made a 64-bit Pi, its GitHub is a stand-in, and the image in
  // its uploads is empty, so its real upgradeOS.php takes the request and
  // stops at "File is empty" before it would touch anything.
  test.setTimeout(240_000);
  const image = 'Pi64-10.5_2026-10.fppos';
  const peer = new SecondPlayer('os-upgrade').start();
  const gh = new FakeGitHub({ '/repos/FalconChristmas/fpp/releases': { json: [release('10.5', [image, 'BBB-10.5_2026-10.fppos'])] } }, peer.name);
  try {
    peer.sh(`echo 'Raspberry Pi' > /etc/fpp/platform && : > ${PEER_MEDIA}/upload/${image}`);
    gh.start();
    // The API: the listing is the remote's own, and only known actions are passed on.
    const own = peer.get('/api/git/releases/os');
    expect(own.files?.map((f: any) => [f.filename, f.downloaded]), JSON.stringify(own)).toEqual([[image, true]]);
    const listed = await (await request.get(`/api/remoteAction?ip=${peer.address}&action=listUpgrades`)).json();
    expect(listed.files?.map((f: any) => f.filename), JSON.stringify(listed)).toEqual([image]);
    const bad = await request.get(`/api/remoteAction?ip=${peer.address}&action=fpp-tests-nothing`);
    expect(bad.status()).toBe(400);

    page.on('dialog', (d) => d.accept());
    const row = await openMultisync(page, peer.address, remoteStatus());
    await row.locator('input.remoteCheckbox').check();
    await page.selectOption('#multiAction', 'upgradeOS');
    const option = page.locator('#OSSelect option', { hasText: image });
    await expect(option).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('#osUpgradeWarning')).toHaveText('');
    await page.selectOption('#OSSelect', await option.getAttribute('value'));
    await page.evaluate('performMultiAction()');
    // The remote's own upgrade page got it, for that image.
    const upgradeLog = () => peer.sh(`cat ${PEER_MEDIA}/logs/fpp_system_upgrades.log 2>/dev/null || true`);
    await expect.poll(upgradeLog, { timeout: 30_000 }).toContain(`File is empty, aborting: /home/fpp/media/upload/${image}`);
  } finally {
    gh.stop();
    const verdict = peer.stop();
    expect(verdict.ok, verdict.detail).toBe(true);
  }
});
