import { test, expect } from './fixtures';
import { container } from './container';
import { MEDIA, readFile } from './settings-file';
import { usesPipewireConfig } from './pw-config-files';

// POST /api/pipewire/aes67/instances is the AES67 page's Save: the PTP
// settings and the list of streams, written to pipewire-aes67-instances.json
// (www/api/controllers/pipewire.php SaveAES67Instances).  What the save fills
// in, and what it refuses.  Nothing is applied: the file is the receiving end.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const FILE = 'pipewire-aes67-instances.json';
const write = usesPipewireConfig(FILE);
const path = `${MEDIA}/config/${FILE}`;
const stored = () => JSON.parse(readFile(path));
const raw = (body: string) => ({ data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });
const URL = '/api/pipewire/aes67/instances';
const SEEDED = { ptpEnabled: false, ptpInterface: 'lo', ptpDomain: 3, ptpRole: 'follower',
  instances: [{ id: 4, name: 'fpp-tests kept', mode: 'receive', multicastIP: '239.69.0.44', port: 5006, channels: 8 }] };

test('a save with only a list gets the PTP defaults, and each stream its id, name, address and timing', async ({ request }) => {
  write(FILE, SEEDED);
  const r = await request.post(URL, { data: { instances: [
    { id: 7, name: 'Stage', mode: 'receive', multicastIP: '239.1.2.3', port: 6000, channels: 8, sessionName: 'S', ptime: 4, latency: 0, sapEnabled: false, enabled: false },
    {},
    { name: 'Third' },
  ] } });
  expect(r.status(), await r.text()).toBe(200);
  expect(await r.json()).toEqual({ status: 'OK' });
  expect(stored()).toEqual({
    ptpEnabled: true, ptpInterface: '', ptpDomain: 0, ptpRole: 'auto',
    instances: [
      { id: 7, name: 'Stage', mode: 'receive', multicastIP: '239.1.2.3', port: 6000, channels: 8, sessionName: 'S', ptime: 4, latency: 0, sapEnabled: false, enabled: false },
      { id: 8, name: 'AES67 Instance 8', mode: 'send', multicastIP: '239.69.0.8', port: 5004, channels: 2, sessionName: 'AES67 Instance 8', ptime: 1, latency: 10, sapEnabled: true, enabled: true },
      { name: 'Third', id: 9, mode: 'send', multicastIP: '239.69.0.9', port: 5004, channels: 2, sessionName: 'Third', ptime: 1, latency: 10, sapEnabled: true, enabled: true },
    ],
  });
  // What the page reads back is what was stored.
  expect(await (await request.get(URL)).json()).toMatchObject({ ptpRole: 'auto', instances: [{ id: 7 }, { id: 8 }, { id: 9 }] });
});

test('the PTP domain and role are kept when they are ones fppd takes', async ({ request }) => {
  write(FILE, SEEDED);
  for (const [domain, role] of [[0, 'auto'], [127, 'master'], ['5', 'follower']] as const) {
    const r = await request.post(URL, { data: { ptpEnabled: false, ptpInterface: 'eth0', ptpDomain: domain, ptpRole: role, instances: [] } });
    expect(r.status()).toBe(200);
    expect(stored()).toEqual({ ptpEnabled: false, ptpInterface: 'eth0', ptpDomain: Number(domain), ptpRole: role, instances: [] });
  }
});

test('a save that is not one is refused with the reason, and the saved streams stay', async ({ request }) => {
  write(FILE, SEEDED);
  const before = readFile(path);
  for (const [body, message] of [
    ['{"instances": [', 'Invalid JSON'],
    ['', 'Invalid JSON'],
    ['{}', 'Missing instances array'],
    ['{"instances": "all"}', 'Missing instances array'],
    ['[]', 'Missing instances array'],
    ['{"instances": [], "ptpDomain": 128}', 'PTP domain must be between 0 and 127'],
    ['{"instances": [], "ptpDomain": -1}', 'PTP domain must be between 0 and 127'],
    ['{"instances": [], "ptpRole": "grandmaster"}', 'PTP role must be auto, follower or master'],
    ['{"instances": [], "ptpRole": ""}', 'PTP role must be auto, follower or master'],
  ] as const) {
    const r = await request.post(URL, raw(body));
    expect(r.status(), body).toBe(400);
    expect(await r.json(), body).toEqual({ status: 'ERROR', message });
  }
  expect(readFile(path)).toBe(before);
});

for (const [what, body] of [
  ['a stream that is not an object', '{"instances": [{"id": 1, "name": "ok"}, "x"]}'],
  ['two streams with one id', '{"instances": [{"id": 2, "name": "a"}, {"id": 2, "name": "b"}]}'],
  ['a port that is not a port', '{"instances": [{"id": 1, "name": "a", "port": 700000}]}'],
  ['an address that is not an address', '{"instances": [{"id": 1, "name": "a", "multicastIP": "not an address; x"}]}'],
  ['a PTP domain that is not a number', '{"instances": [], "ptpDomain": "seven"}'],
] as const) {
  test(`${what} is refused, and the saved streams stay`, async ({ request }) => {
    test.fail(true, 'the streams are filled in, not checked (FUTURE.md)');
    write(FILE, SEEDED);
    const before = readFile(path);
    const r = await request.post(URL, raw(body));
    const text = await r.text();
    expect(text).not.toContain('Fatal error');
    expect(readFile(path), `the streams were rewritten (answer ${r.status()} ${text.slice(0, 100)})`).toBe(before);
    expect(r.status()).toBe(400);
  });
}
