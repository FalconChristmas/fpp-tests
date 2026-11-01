import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer, playerAddress } from './container';
import { MEDIA, keepingFile, keepingSettings, php, setSettingInFile, writeFile } from './privacy-helpers';

// What the usage statistics payload (GET /api/statistics/usage, which a player
// that has opted in uploads) carries, and what it must never carry: Wi-Fi
// names and keys, addresses and host names, hardware addresses, the cape's
// serial, or any setting declared pii or a password.  ?force=1 regenerates it;
// without it a cached copy up to two hours old comes back.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function payload(request: APIRequestContext) {
  const r = await request.get('/api/statistics/usage?force=1');
  const text = await r.text();
  expect(r.ok(), text).toBe(true);
  return { text, json: JSON.parse(text) };
}

const IFACE = `${MEDIA}/config/interface.eth0`;

test('an interface config reaches the payload only through the allowlist', async ({ request }) => {
  // Regression: c76c4cffd -- the interface block tested the array being built
  //   rather than the source, so it never emitted anything; the fix made it an
  //   allowlist, as the old denylist missed BACKUPSSID and BACKUPPSK.
  // Feature: 1fe0a63bc -- the allowlist is "gatherStats" in
  //   www/interface-settings.json.
  await keepingFile(IFACE, async () => {
    writeFile(IFACE, 'INTERFACE="eth0"\nPROTO="dhcp"\nSSID="LEAK-ssid"\nPSK="LEAK-psk"\n' +
      'BACKUPSSID="LEAK-backup-ssid"\nBACKUPPSK="LEAK-backup-psk"\nADDRESS="192.0.2.77"\n' +
      'NETMASK="255.255.255.0"\nGATEWAY="192.0.2.1"\n');
    const { text, json } = await payload(request);
    expect(json.network.interfaces.eth0.config, 'no interface config in the payload').toEqual({ PROTO: 'dhcp' });
    expect(text).not.toContain('LEAK-');
    expect(text).not.toContain('192.0.2.');
  });
});

test('the interface allowlist is read from interface-settings.json', async ({ request }) => {
  // Regression: a21b5d166.  stats_network() had no `global $settings`, so it
  // looked for /interface-settings.json, never found it, and always used its
  // built-in copy of the list: editing the file changed nothing.
  const FIELDS = '/opt/fpp/www/interface-settings.json';
  await keepingFile(IFACE, () => keepingFile(FIELDS, async () => {
    writeFile(IFACE, 'INTERFACE="eth0"\nPROTO="dhcp"\nROUTEMETRIC="7"\n');
    const before = (await payload(request)).json.network.interfaces.eth0.config;
    // The control: both fields are on the shipped allowlist.
    expect(before).toEqual({ PROTO: 'dhcp', ROUTEMETRIC: '7' });
    const meta = JSON.parse(inPlayer('cat', FIELDS));
    delete meta.fields.PROTO.gatherStats;
    writeFile(FIELDS, JSON.stringify(meta, null, 4));
    const after = (await payload(request)).json.network.interfaces.eth0.config;
    expect(after, 'PROTO is still sent after interface-settings.json stopped allowing it').toEqual({ ROUTEMETRIC: '7' });
  }));
});

test('settings marked pii stay out, whatever gatherStats says', async ({ request }) => {
  // Regression: 08fc1175a -- settings declared pii were collected when they
  //   also said gatherStats (KioskUrl, the AES67 session and group, the
  //   MultiSync external address).
  // Feature: a716df142 -- WLEDAudioSyncMode, currentHeaderSensor and
  //   AudioCardType are collected.
  // cfefc3ae9 -- MultiSyncExtraRemotes, now pii, is not collected either.
  await keepingSettings(async () => {
    const leaks = {
      KioskUrl: 'http://LEAK-kiosk.invalid/', AES67SessionName: 'LEAK-session',
      AES67MulticastIP: 'LEAK-group', MultiSyncExternalIPAddress: 'LEAK-external',
      MultiSyncExtraRemotes: 'LEAK-remotes', HostName: 'LEAK-host', emailAddress: 'LEAK@example.invalid',
    };
    for (const [k, v] of Object.entries(leaks)) setSettingInFile(k, v);
    const wanted = { WLEDAudioSyncMode: 'fpp-tests-wled', currentHeaderSensor: 'fpp-tests-sensor', AudioCardType: 'fpp-tests-card' };
    for (const [k, v] of Object.entries(wanted)) setSettingInFile(k, v);
    const { text, json } = await payload(request);
    // The control: ordinary gatherStats settings are collected.
    expect(json.settings.fppMode).toBe('player');
    for (const [k, v] of Object.entries(wanted)) expect(json.settings[k], k).toBe(v);
    for (const k of Object.keys(leaks)) expect(json.settings[k], `${k} was collected`).toBeUndefined();
    expect(text).not.toContain('LEAK');
  });
});

test('the cape is reported without its serial, cs or vendor contact details', async ({ request }) => {
  // Regression: 08fc1175a.  The cape serial and cs -- a per-unit key into the
  // vendor's order records -- were sent, gated on SendVendorSerial, along with
  // the vendor's whole block (e-mail, site).
  // Also 40b33e589: the vendor's name is still reported: the capeInfo mapping
  // names it.
  const CAPE = `${MEDIA}/tmp/cape-info.json`;
  await keepingFile(CAPE, async () => {
    writeFile(CAPE, JSON.stringify({
      id: 'fpp-tests-cape', name: 'Test Cape', designer: 'fpp-tests', serialNumber: 'LEAK-serial-0042',
      cs: 'LEAK-cs', vendor: { name: 'Test Vendor', url: 'https://LEAK-vendor.invalid', email: 'LEAK@vendor.invalid' },
    }));
    const { text, json } = await payload(request);
    expect(json.capeInfo).toEqual({ id: 'fpp-tests-cape', name: 'Test Cape', designer: 'fpp-tests', vendor: 'Test Vendor' });
    expect(text).not.toContain('LEAK');
  });
});

test('uuidSource is a source, never the identity, and a bad cached identity is not used', async ({ request }) => {
  // Regression: f53203a34.  The cached `get_uuid --source` answer was trusted
  // forever, and a get_uuid without --source printed the UUID into it, so
  // uuidSource became a copy of uuid; a cached UUID that the current rules
  // reject (all zeros) was trusted the same way.
  const real = (await payload(request)).json;
  expect(real.uuidSource, 'the control: a source token').toMatch(/^[a-z-]+$/);
  await keepingFile('/tmp/fpp_uuid_source', () => keepingFile('/tmp/fpp_uuid', async () => {
    inPlayer('sh', '-c', `printf '%s\\n' '${real.uuid}' > /tmp/fpp_uuid_source`);
    inPlayer('sh', '-c', `printf '%s\\n' 00000000-0000-0000-0000-000000000000 > /tmp/fpp_uuid`);
    const { json } = await payload(request);
    expect(json.uuidSource, 'uuidSource carries the cached identity').not.toBe(real.uuid);
    expect(['setting', 'cpuinfo', 'device-tree', 'board-eeprom', 'dmidecode', 'machine-id', 'generated',
      'container', 'ioreg', 'none', 'unknown']).toContain(json.uuidSource);
    expect(json.uuid, 'a cached all-zero identity was used').toBe(real.uuid);
  }));
});

test('universe outputs are counted by destination without any address', async ({ request }) => {
  // Regression: c76c4cffd -- enabled, threaded and type were never emitted
  //   for universe outputs (validateAndAdd was given an index that doesn't
  //   exist there).
  // Regression: ea2c6ccfa -- only channelOutputs[0] was read, so a second
  //   universe-output block was invisible; rows are now tagged with the class
  //   of what they feed (a discovered peer's type, unknown, multicast).
  // Feature: 3761b6795 -- targets: unique unicast destinations, discovered or
  //   not, with broadcast and multicast rows counted apart.
  const own = playerAddress().ip;
  const row = (address: string) => ({ active: 1, address, type: 0, startChannel: 1, universeCount: 1, channelCount: 512 });
  const CO = `${MEDIA}/config/co-universes.json`;
  await keepingFile(CO, async () => {
    writeFile(CO, JSON.stringify({ channelOutputs: [
      { enabled: 1, type: 'universes', threaded: 0, universes: [row(own), row(own), row('192.0.2.255')] },
      { enabled: 1, type: 'universes', universes: [row(''), row('192.0.2.60'), row('fpp-tests-ctl.invalid')] },
    ] }));
    const { text, json } = await payload(request);
    const out = json.output_e131;
    expect(out.type).toBe('universes');
    expect(out.enabled).toBe(1);
    expect(out.rowCount, 'the second block was not counted').toBe(6);
    expect(Object.keys(out.destType).sort()).toEqual(expect.arrayContaining(['multicast', 'unknown']));
    expect(Object.keys(out.destType).some((k) => k.startsWith('FPP')), `own player not classed: ${JSON.stringify(out.destType)}`).toBe(true);
    const t = out.targets;
    expect(t.count).toBe(3);
    expect(t.discovered).toMatchObject({ targets: 1, rows: 2 });
    expect(t.undiscovered).toMatchObject({ targets: 2, rows: 2 });
    expect(t.nonUnicast).toMatchObject({ targets: 1, rows: 1 });
    expect(t.undiscoveredForm).toEqual({ ipv4: 1, hostname: 1 });
    for (const leak of ['192.0.2.', 'fpp-tests-ctl', `"${own}"`]) expect(text).not.toContain(leak);
  });
});

// The peer list, through stats_multiSyncCollect()'s test seam: what it makes
// of MultiSync rows it is handed.
function collectPeers(systems: object[]): any {
  const out = php(`require_once '/opt/fpp/www/api/controllers/stats.php';
echo json_encode(stats_multiSyncCollect(json_decode(file_get_contents('php://stdin'), true)));`,
  JSON.stringify({ systems }));
  return JSON.parse(out.slice(out.indexOf('{"peers"')));
}

test('a peer known only by its MAC is reported as one stable hash of it', async () => {
  // Regression: 6efd66bdb -- such a peer got a hash salted with the reporting
  //   player's own UUID, so two players describing one controller reported
  //   two unrelated devices.
  // Regression: 15c3da4aa -- the MAC itself was then sent.
  // Regression: 08fc1175a -- one device answering on two addresses was two
  //   peers.
  const systems = [
    { uuid: 'MAC:AA:BB:CC:DD:EE:01', address: '192.0.2.50', hostname: 'fpp-tests-ctl', type: 'Falcon F16v4', typeId: 129 },
    { uuid: 'MAC:AA:BB:CC:DD:EE:01', address: '192.0.2.51', hostname: 'fpp-tests-ctl', type: 'Falcon F16v4', typeId: 129 },
  ];
  const first = collectPeers(systems);
  const second = await keepingFile('/tmp/fpp_uuid', async () => {
    inPlayer('sh', '-c', "printf '%s\\n' 6ba176e7-da7f-49f4-8b27-edb5bd9ff616 > /tmp/fpp_uuid");
    return collectPeers(systems);
  });
  expect(first.peers).toHaveLength(1);
  expect(first.peers[0].addressCount).toBe(2);
  const id = first.peers[0].uuid;
  expect(id).toMatch(/^MH-[0-9a-f]{16}$/);
  expect(second.peers[0].uuid, 'the identity changed with the reporting player').toBe(id);
  const text = JSON.stringify(first).toLowerCase();
  for (const mac of ['aa:bb:cc:dd:ee:01', 'aabbccddee01', 'aa-bb-cc-dd-ee-01']) expect(text).not.toContain(mac);
  expect(text).not.toContain('192.0.2.');
  expect(text).not.toContain('fpp-tests-ctl');
});

test("a peer's platform and cape are reported from an allowlist", async () => {
  // Feature: c80cb48e4.  Per-peer platform and cape come from what fppd
  // caches of the remote's /api/system/info and /api/cape; its addresses,
  // description and colour, and the vendor's contact details, are not sent,
  // and a cape that opted out of statistics is "present" and nothing more.
  const { peers } = collectPeers([
    { uuid: '6ba176e7-da7f-49f4-8b27-edb5bd9ff617', address: '192.0.2.52', type: 'FPP', typeId: 1,
      systemInfo: { Platform: 'Raspberry Pi', Variant: 'Pi 4', OSRelease: 'fpp-tests-os', IPs: ['192.0.2.52'],
        HostDescription: 'LEAK-desc', backgroundColor: 'LEAK-colour', UpgradeSource: 'LEAK-mirror' },
      capeInfo: { present: true, id: 'fpp-tests-cape', name: 'Test Cape', version: '1.0', designer: 'fpp-tests',
        description: 'LEAK-description', serialNumber: 'LEAK-serial',
        vendor: { name: 'Test Vendor', url: 'https://LEAK-vendor.invalid', email: 'LEAK@vendor.invalid' } } },
    { uuid: '6ba176e7-da7f-49f4-8b27-edb5bd9ff618', address: '192.0.2.53', type: 'FPP', typeId: 1,
      capeInfo: { present: true, sendStats: 0, id: 'LEAK-optout-cape', name: 'LEAK-optout' } },
  ]);
  expect(peers[0].systemInfo).toEqual({ platform: 'Raspberry Pi', variant: 'Pi 4', osRelease: 'fpp-tests-os' });
  expect(peers[0].capeInfo).toEqual({ present: true, id: 'fpp-tests-cape', name: 'Test Cape', version: '1.0',
    designer: 'fpp-tests', vendor: 'Test Vendor' });
  expect(peers[1].capeInfo).toEqual({ present: true });
  expect(JSON.stringify(peers)).not.toContain('LEAK');
  expect(JSON.stringify(peers)).not.toContain('192.0.2.');
});
