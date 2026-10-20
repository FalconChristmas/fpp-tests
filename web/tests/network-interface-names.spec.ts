import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The {interface} of /api/network/interface/{interface}, and the INTERFACE a
// save names, reach shell commands (ip, iw, networkctl, sudo fppinit) and the
// paths of config/interface.<name> and config/leases.<name>.  Deleting a
// saved interface config is its own endpoint.

test.skip(!container, 'checks files and commands inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const MARK = 'fpp-tests-ifname-mark';

function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e '${path}' && echo yes || echo no`).trim() === 'yes';
}

function findMark(): string {
  return inPlayer('sh', '-c', `find / -xdev -name ${MARK} 2>/dev/null || true`).trim();
}

test('an interface name is never run as shell text', async ({ request }) => {
  // Regression: bd2199592.  GET /api/network/interface/<name> pasted the name
  // into "ip ... dev <name>" (and iw, networkctl) unquoted, so a name with a
  // ";" ran whatever followed it as the web server's user.
  try {
    const r = await request.get(`/api/network/interface/${encodeURIComponent(`eth0;touch ${MARK}`)}`);
    expect(findMark(), 'the name ran as a command').toBe('');
    expect((await r.json()).status).toBe('ERROR: Interface not found');
    // The control: a real name still answers.
    const ok = await (await request.get('/api/network/interface/lo')).json();
    expect(ok.status).toBe('OK');
  } finally {
    inPlayer('sh', '-c', `find / -xdev -name ${MARK} -delete 2>/dev/null || true`);
  }
});

test('a saved interface name cannot leave the config directory', async ({ request }) => {
  // Regression: bd2199592.  POST /api/network/interface/<x> wrote
  // config/interface.<INTERFACE> with INTERFACE unchecked, so a name with
  // "/../" in it wrote wherever it pointed (given a directory named like a
  // config file to step through).
  const dir = `${MEDIA}/config/interface.fpptestsdir`;
  const escaped = `${MEDIA}/fpp-tests-escaped`;
  inPlayer('sh', '-c', `mkdir -p '${dir}' && chown fpp:fpp '${dir}' 2>/dev/null; chmod 777 '${dir}'`);
  try {
    const r = await request.post('/api/network/interface/fpptestsdir', {
      data: { INTERFACE: 'fpptestsdir/../../fpp-tests-escaped', PROTO: 'dhcp' },
    });
    expect(exists(escaped), 'a file was written outside config/').toBe(false);
    expect((await r.json()).status).toBe('ERROR: invalid interface name');
  } finally {
    inPlayer('rm', '-rf', dir, escaped, `${MEDIA}/leases.fpp-tests-escaped`, `${MEDIA}/config/leases.fpptestsdir`);
  }
});

test('a saved interface config can be deleted, but not one in use', async ({ request }) => {
  // Feature: a1ccb5140 (DELETE /api/network/interface/{interface}).  An absent
  // interface's config and static leases are removed; there is nothing to
  // delete a second time; a name that could leave the config directory is
  // refused; and the interface carrying this very request is kept, since
  // deleting it would leave no way back from the UI.
  const cfg = `${MEDIA}/config/interface.eth9`;
  const leases = `${MEDIA}/config/leases.eth9`;
  inPlayer('sh', '-c', `printf 'INTERFACE="eth9"\\nPROTO="dhcp"\\n' > '${cfg}'; printf '[DHCPServerStaticLease]\\n' > '${leases}'; chown fpp:fpp '${cfg}' '${leases}' 2>/dev/null; true`);
  const inUse = inPlayer('sh', '-c', "ip -o route show default | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p' | head -1").trim();
  const inUseCfg = `${MEDIA}/config/interface.${inUse}`;
  const seeded = !exists(inUseCfg);
  if (seeded) {
    inPlayer('sh', '-c', `printf 'INTERFACE="${inUse}"\\nPROTO="dhcp"\\n' > '${inUseCfg}'; chown fpp:fpp '${inUseCfg}' 2>/dev/null; true`);
  }
  try {
    let r = await request.delete('/api/network/interface/eth9');
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).deleted.sort()).toEqual(['interface.eth9', 'leases.eth9']);
    expect(exists(cfg) || exists(leases)).toBe(false);

    r = await request.delete('/api/network/interface/eth9');
    expect(r.status()).toBe(404);

    r = await request.delete(`/api/network/interface/${encodeURIComponent('..settings')}`);
    expect(r.status()).toBe(400);
    expect(exists(`${MEDIA}/settings`)).toBe(true);

    expect(inUse, 'no default route in the player').not.toBe('');
    r = await request.delete(`/api/network/interface/${inUse}`);
    expect(r.status(), await r.text()).toBe(409);
    expect(exists(inUseCfg)).toBe(true);
  } finally {
    inPlayer('rm', '-f', cfg, leases);
    if (seeded) inPlayer('rm', '-f', inUseCfg);
  }
});
