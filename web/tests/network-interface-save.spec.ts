import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// Saving an interface's settings (POST /api/network/interface/<if>, what the
// Network page's Update Interface sends) and applying them (.../apply, which
// runs fppinit setupNetwork).  What is written to config/interface.<if> and
// config/leases.<if>, and what is refused.  Scratch interface names, so the
// player's own interfaces are untouched; the save doesn't need the interface
// to exist.  (network-config-page.spec.ts: the page's save, with leases.)

test.skip(!container, 'reads the files the save writes inside the run-web.sh container');

const CONFIG = '/home/fpp/media/config';
const ETH = 'fpptestsave';
const WL = 'wlfpptestsave';
const FPPINIT = '/opt/fpp/src/fppinit';

const sh = (script: string) => inPlayer('sh', '-c', script);
const cfg = (name: string) => sh(`cat ${CONFIG}/interface.${name} 2>/dev/null || printf MISSING`);
const leases = (name: string) => sh(`cat ${CONFIG}/leases.${name} 2>/dev/null || printf MISSING`);

test.afterEach(() => {
  sh(`rm -f ${CONFIG}/interface.${ETH} ${CONFIG}/leases.${ETH} ${CONFIG}/interface.${WL} ${CONFIG}/leases.${WL}
      rm -f '${CONFIG}/../interface.x' /tmp/fpp-tests-fppinit.log
      if [ -e ${FPPINIT}.fpp-tests-real ]; then mv -f ${FPPINIT}.fpp-tests-real ${FPPINIT}; fi`);
});

async function save(request: APIRequestContext, name: string, data: unknown) {
  const r = await request.post(`/api/network/interface/${name}`, { data });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* checked by the caller */ }
  return { text, json };
}

test('a static and a DHCP interface are written as fppinit reads them', async ({ request }) => {
  let r = await save(request, ETH, { INTERFACE: ETH, PROTO: 'static', ADDRESS: '192.168.9.2', NETMASK: '255.255.255.0',
    ROUTEMETRIC: 20, IPFORWARDING: 1 });
  expect(r.json).toEqual({ status: 'OK' });
  expect(cfg(ETH)).toBe(`INTERFACE="${ETH}"\nPROTO="static"\nADDRESS="192.168.9.2"\nNETMASK="255.255.255.0"\nROUTEMETRIC=20\nIPFORWARDING=1\n`);

  // A fresh file: a save that leaves ROUTEMETRIC and IPFORWARDING out keeps
  // the saved ones (fpp c448237ac; network-interface-advanced-fields-kept).
  sh(`rm -f ${CONFIG}/interface.${ETH}`);
  r = await save(request, ETH, { INTERFACE: ETH, PROTO: 'dhcp' });
  expect(r.json).toEqual({ status: 'OK' });
  expect(cfg(ETH)).toBe(`INTERFACE=${ETH}\nPROTO=dhcp\n`);
});

test("a wireless interface's network, its backup, and their flags are written", async ({ request }) => {
  const r = await save(request, WL, { INTERFACE: WL, PROTO: 'dhcp',
    SSID: "Grandma's Lights & Sound", PSK: 'p@ss w0rd!', HIDDEN: true, WPA3: false,
    BACKUPSSID: 'fpp-tests-backup', BACKUPPSK: 'other key', BACKUPHIDDEN: 'false', BACKUPWPA3: 1 });
  expect(r.json).toEqual({ status: 'OK' });
  expect(cfg(WL)).toBe(`INTERFACE=${WL}\nPROTO=dhcp\n` +
    `SSID="Grandma's Lights & Sound"\nPSK="p@ss w0rd!"\nHIDDEN=1\nWPA3=\n` +
    `BACKUPSSID="fpp-tests-backup"\nBACKUPPSK="other key"\nBACKUPHIDDEN=false\nBACKUPWPA3=1\n`);
});

test('a save without the keys keeps the ones saved before', async ({ request }) => {
  await save(request, WL, { INTERFACE: WL, PROTO: 'dhcp', SSID: 'net', PSK: 'k${HOME}ept', HIDDEN: false, WPA3: false,
    BACKUPSSID: '', BACKUPPSK: 'b-kept', BACKUPHIDDEN: false, BACKUPWPA3: false });
  // The page never gets the keys back, so it sends none.
  const r = await save(request, WL, { INTERFACE: WL, PROTO: 'dhcp', SSID: 'net2', HIDDEN: false, WPA3: true,
    BACKUPSSID: '', BACKUPHIDDEN: false, BACKUPWPA3: false });
  expect(r.json).toEqual({ status: 'OK' });
  expect(cfg(WL)).toContain('SSID="net2"\nPSK="k${HOME}ept"\n');
  expect(cfg(WL)).toContain('BACKUPPSK="b-kept"\n');
});

test("the DHCP server's static leases are written, and a save without any removes the file", async ({ request }) => {
  const base = { INTERFACE: ETH, PROTO: 'static', ADDRESS: '192.168.9.1', NETMASK: '255.255.255.0',
    DHCPSERVER: true, DHCPOFFSET: 100, DHCPPOOLSIZE: 50 };
  let r = await save(request, ETH, { ...base, Leases: { '192.168.9.10': '02:00:00:00:09:10', '192.168.9.11': '02-00-00-00-09-11' } });
  expect(r.json).toEqual({ status: 'OK' });
  expect(cfg(ETH)).toContain('DHCPSERVER=1\nDHCPOFFSET=100\nDHCPPOOLSIZE=50\n');
  expect(leases(ETH)).toBe('[DHCPServerStaticLease]\nMACAddress=02:00:00:00:09:10\nAddress=192.168.9.10\n\n' +
    '[DHCPServerStaticLease]\nMACAddress=02-00-00-00-09-11\nAddress=192.168.9.11\n\n');

  r = await save(request, ETH, base);
  expect(r.json).toEqual({ status: 'OK' });
  expect(leases(ETH)).toBe('MISSING');

  r = await save(request, ETH, { ...base, DHCPSERVER: false });
  expect(cfg(ETH)).toContain('DHCPSERVER=0\n');
});

test('a bad name, lease, address, flag, string or number is refused', async ({ request }) => {
  const cases: [string, Record<string, unknown>, string][] = [
    [ETH, { INTERFACE: '../interface.x', PROTO: 'dhcp' }, 'ERROR: invalid interface name'],
    [ETH, { INTERFACE: ETH, PROTO: 'dhcp', Leases: 'x' }, 'ERROR: invalid leases'],
    [ETH, { INTERFACE: ETH, PROTO: 'dhcp', Leases: { '192.168.9.300': '02:00:00:00:09:10' } }, 'ERROR: invalid static lease entry'],
    [ETH, { INTERFACE: ETH, PROTO: 'dhcp', Leases: { '192.168.9.10': '02:00:00:00:09' } }, 'ERROR: invalid static lease entry'],
    [ETH, { INTERFACE: ETH, PROTO: 'static', ADDRESS: '192.168.9.2', NETMASK: '255.255.255.0\nDNS1=1.1.1.1' }, 'ERROR: invalid static address or netmask'],
    [WL, { INTERFACE: WL, PROTO: 'dhcp', SSID: 'net"\nPSK="x' }, 'ERROR: invalid characters in SSID'],
    [WL, { INTERFACE: WL, PROTO: 'dhcp', SSID: 'net', BACKUPPSK: 'a\rb' }, 'ERROR: invalid characters in BACKUPPSK'],
    [WL, { INTERFACE: WL, PROTO: 'dhcp', SSID: 'net', HIDDEN: 'yes' }, 'ERROR: invalid value for HIDDEN'],
    [ETH, { INTERFACE: ETH, PROTO: 'dhcp', DHCPPOOLSIZE: [50] }, 'ERROR: invalid value for DHCPPOOLSIZE'],
    [ETH, { INTERFACE: ETH, PROTO: 'dhcp', ROUTEMETRIC: '5; reboot' }, 'ERROR: invalid value for ROUTEMETRIC'],
  ];
  for (const [name, data, status] of cases) {
    const r = await save(request, name, data);
    expect(r.json?.status, `${JSON.stringify(data)}: ${r.text}`).toBe(status);
  }
  expect(sh(`test -e '${CONFIG}/../interface.x' && echo escaped || echo no`).trim()).toBe('no');
  expect(leases(ETH), 'a refused lease writes no leases file').toBe('MISSING');
});

// Before f89cda65f the interface file was opened for writing -- emptied --
// before the address, SSID/PSK, flag and number checks, so a save they
// refused left the interface with no config, or half of one.
test('a refused save leaves the saved settings as they were', async ({ request }) => {
  const saved = { INTERFACE: WL, PROTO: 'static', ADDRESS: '192.168.9.5', NETMASK: '255.255.255.0',
    SSID: 'net', PSK: 'key', HIDDEN: false, WPA3: false, BACKUPSSID: '', BACKUPPSK: '', BACKUPHIDDEN: false, BACKUPWPA3: false };
  expect((await save(request, WL, saved)).json).toEqual({ status: 'OK' });
  const before = cfg(WL);
  for (const bad of [{ NETMASK: '255.255.255.256' }, { SSID: 'a"b' }, { HIDDEN: 'yes' }, { DHCPOFFSET: 'ten' }]) {
    const r = await save(request, WL, { ...saved, ...bad });
    expect(r.json?.status, JSON.stringify(bad)).toMatch(/^ERROR/);
    expect(cfg(WL), `after the refused ${JSON.stringify(bad)}`).toBe(before);
  }
});

test('a save refused by a late check leaves the leases as they were, and no temp file behind', async ({ request }) => {
  // DHCPOFFSET is the last check, after the leases used to be rewritten
  // (before f89cda65f).
  const base = { INTERFACE: ETH, PROTO: 'static', ADDRESS: '192.168.9.1', NETMASK: '255.255.255.0',
    DHCPSERVER: true, DHCPOFFSET: 100, DHCPPOOLSIZE: 50, Leases: { '192.168.9.10': '02:00:00:00:09:10' } };
  expect((await save(request, ETH, base)).json).toEqual({ status: 'OK' });
  const before = { cfg: cfg(ETH), leases: leases(ETH) };
  const r = await save(request, ETH, { ...base, DHCPOFFSET: 'ten', Leases: { '192.168.9.20': '02:00:00:00:09:20' } });
  expect(r.json?.status).toBe('ERROR: invalid value for DHCPOFFSET');
  expect({ cfg: cfg(ETH), leases: leases(ETH) }).toEqual(before);
  // The files are written through temp files renamed into place; none is left.
  expect(sh(`ls -A ${CONFIG} | grep -c '\\.tmp$' || true`).trim()).toBe('0');
  // ... and the file is readable by everything that reads it, as before.
  expect(sh(`stat -c %a ${CONFIG}/interface.${ETH}`).trim()).toBe('644');
});

test('a save without an interface name is refused with a JSON answer', async ({ request }) => {
  // Before f89cda65f the refusal was printed after "WTF", so the answer
  // wasn't JSON.
  const r = await save(request, ETH, { PROTO: 'dhcp' });
  expect(r.text).toContain('"status":"Invalid Name is required"');
  expect(r.json, r.text).toMatchObject({ status: 'Invalid Name is required' });
});

test('applying runs fppinit setupNetwork for that interface, and a bad name is refused', async ({ request }) => {
  sh(`mv ${FPPINIT} ${FPPINIT}.fpp-tests-real
      printf '%s\\n' '#!/bin/sh' 'echo "$*" >> /tmp/fpp-tests-fppinit.log' 'echo "set up $2"' > ${FPPINIT}; chmod 755 ${FPPINIT}`);
  const ok = await request.post(`/api/network/interface/${ETH}/apply`);
  expect(await ok.json()).toEqual({ status: 'OK', output: [`set up ${ETH}`] });
  expect(sh('cat /tmp/fpp-tests-fppinit.log').trim()).toBe(`setupNetwork ${ETH}`);

  const bad = await request.post(`/api/network/interface/${encodeURIComponent('-x')}/apply`);
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toEqual({ status: 'ERROR: invalid interface name' });
  expect(sh('cat /tmp/fpp-tests-fppinit.log').trim().split('\n')).toHaveLength(1);
});
