import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// GET /api/channel/input/stats: the packet counts fppd keeps for each
// network input universe (fppd's own /fppd/e131stats), which the status
// page's bridge table shows.  The inputs are the test's, saved to
// ci-universes.json, which fppd reloads when it changes.

test.skip(!container, 'saves channel inputs and sends packets inside the run-web.sh container');

const CONFIG = '/home/fpp/media/config/ci-universes.json';
const inputs = (enabled: number) => JSON.stringify({ channelInputs: [{
  type: 'universes', enabled, startChannel: 1, channelCount: 1024, universes: [
    { active: 1, description: 'fpp-tests', id: 4010, universeCount: 2, startChannel: 1, channelCount: 512, type: 0, priority: 0, address: '' },
  ] }] });

// E1.31 to the player's own loopback, built by the scenarios' packets.py.
function sendE131(universe: number, count: number) {
  inPlayer('python3', '-c', `import sys; sys.path.insert(0, '/tests/scenarios')
from packets import e131, send
send([e131(${universe}, bytes(512), seq=n) for n in range(${count})], 5568)`);
}

test('the input stats list each input universe with the packets it got', async ({ request }) => {
  // Feature: fcaf6a10e ("Replace getUniverseReceivedBytes -- #944"): the
  // fppxml.php command became this endpoint.
  const before = inPlayer('sh', '-c', `cat ${CONFIG} 2>/dev/null || true`);
  const stats = async () => {
    const r = await request.get('/api/channel/input/stats');
    expect(r.status()).toBe(200);
    return r.json();
  };
  try {
    putFile(CONFIG, inputs(1));
    await expect.poll(async () => (await stats()).universes?.map((u: any) => [Number(u.id), Number(u.startChannel)]),
      { timeout: 20_000, message: 'the universes listed' }).toEqual([[4010, 1], [4011, 513]]);
    expect((await stats()).status).toBe('OK');
    sendE131(4011, 3);
    await expect.poll(async () => {
      const u = (await stats()).universes.find((x: any) => Number(x.id) === 4011);
      return [Number(u.packetsReceived), Number(u.bytesReceived)];
    }, { timeout: 10_000, message: "universe 4011's counts" }).toEqual([3, 3 * 512]);
    const u4010 = (await stats()).universes.find((x: any) => Number(x.id) === 4010);
    expect(Number(u4010.packetsReceived)).toBe(0);
    // The same as fppd's own answer.
    const own = JSON.parse(inPlayer('curl', '-s', 'http://127.0.0.1:32322/fppd/e131stats'));
    expect((await stats()).universes).toEqual(own.universes);
  } finally {
    if (before) putFile(CONFIG, before);
    else putFile(CONFIG, inputs(0));
  }
});
