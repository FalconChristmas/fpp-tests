import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// GET /api/system/status adds the player's own details to fppd's answer.
// A caller that polls it often can switch parts off: ?nonetwork leaves out
// the wifi strength, the interface list and the IP addresses (each of which
// costs a fork or a scan), ?simple leaves out utilization, kernel and git
// versions.  The player's own details are under advancedView.  The control is the plain request, which has them all.

const status = async (request: any, query = '') => {
  const r = await request.get(`/api/system/status${query}`, { timeout: 30_000 });
  expect(r.ok()).toBe(true);
  return r.json();
};

test('?nonetwork leaves out the wifi, interfaces and IP addresses', async ({ request }) => {
  // Regression: 6d8b7a840.  Added the flag: wifi and interfaces were always
  // gathered.  Also ad9229d0c: the IP addresses came with them, and could
  // not be left out of a status that was not ?simple.
  const full = await status(request);
  expect(full, 'the control: a plain status has the network details').toHaveProperty('wifi');
  expect(full).toHaveProperty('interfaces');
  expect(Array.isArray(full.advancedView.IPs), JSON.stringify(full.advancedView)).toBe(true);

  const s = await status(request, '?nonetwork');
  expect(s).not.toHaveProperty('wifi');
  expect(s).not.toHaveProperty('interfaces');
  expect(s.advancedView).not.toHaveProperty('IPs');
  // the rest of the status is still there
  expect(s.advancedView.Utilization?.CPU).toBeDefined();
  expect(s.advancedView.uuid).toBeTruthy();
});

test('?simple leaves out utilization and versions but keeps the network details', async ({ request }) => {
  // Regression: 6d8b7a840.  finalizeStatusJson() always asked for the
  // advanced system info, whatever the caller said.
  const full = await status(request);
  expect(full.advancedView.Utilization?.Memory, 'the control: a plain status has utilization').toBeDefined();
  expect(full.advancedView.Kernel).toBeTruthy();

  const s = await status(request, '?simple');
  expect(s.advancedView).not.toHaveProperty('Utilization');
  expect(s.advancedView).not.toHaveProperty('Kernel');
  expect(s).toHaveProperty('wifi');
  expect(s.advancedView.uuid).toBeTruthy();
});

test('the status uuid comes from the cache file, which is written when it is missing', async ({ request }) => {
  // Regression: b0df4971a.  Every status poll forked scripts/get_uuid; the
  // answer is now kept in /tmp/fpp_uuid, per boot.
  test.skip(!container, 'reads and writes /tmp/fpp_uuid inside the run-web.sh container');
  const cache = inPlayer('sh', '-c', 'cat /tmp/fpp_uuid 2>/dev/null || true');
  try {
    putFile('/tmp/fpp_uuid', 'M9-fpp-tests-cached-uuid\n');
    expect((await status(request)).advancedView.uuid, 'a valid cache is the identity, nothing is forked').toBe('M9-fpp-tests-cached-uuid');

    inPlayer('rm', '-f', '/tmp/fpp_uuid');
    const made = (await status(request)).advancedView.uuid;
    expect(made).toBeTruthy();
    expect(made).not.toBe('M9-fpp-tests-cached-uuid');
    expect(inPlayer('cat', '/tmp/fpp_uuid').trim(), 'the answer is cached for the next poll').toBe(made);
  } finally {
    if (cache) putFile('/tmp/fpp_uuid', cache);
    else inPlayer('rm', '-f', '/tmp/fpp_uuid');
  }
});
