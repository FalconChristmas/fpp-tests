import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// Two small API answers nothing tested:
//   GET /api/effects/ALL            every effect and sequence that can be run
//                                   as an effect, by name (effects.php)
//   DELETE /api/channel/input/stats  clear fppd's bridge input counters
//                                   (channel.php), the Status page's Clear button

test.skip(!container, 'seeds files inside the run-web.sh container');

const files = [
  `${MEDIA}/effects/fpp-tests-fx-b.eseq`, `${MEDIA}/effects/fpp-tests-fx-A.eseq`, `${MEDIA}/effects/fpp-tests-fx-notes.txt`,
  `${MEDIA}/sequences/fpp-tests-fx-seq.fseq`, `${MEDIA}/sequences/fpp-tests-fx-seq.fseq.bak`,
];
const clean = () => inPlayer('sh', '-c', `rm -f -- "${MEDIA}"/effects/fpp-tests-fx-* "${MEDIA}"/sequences/fpp-tests-fx-*`);
test.beforeEach(() => {
  inPlayer('mkdir', '-p', `${MEDIA}/effects`, `${MEDIA}/sequences`);
  clean();
  for (const f of files) putFile(f, 'x');
});
test.afterEach(clean);

test('effects/ALL lists effects and sequences together by name, sorted, and effects lists only the effects', async ({ request }) => {
  const mine = (l: string[]) => l.filter((n) => n.startsWith('fpp-tests-fx-'));
  const all = await (await request.get('/api/effects/ALL')).json();
  expect(mine(all)).toEqual(['fpp-tests-fx-A', 'fpp-tests-fx-b', 'fpp-tests-fx-seq']);
  expect([...all].sort(), 'the whole list is sorted').toEqual(all);
  const effects = await (await request.get('/api/effects')).json();
  expect(mine(effects).sort()).toEqual(['fpp-tests-fx-A', 'fpp-tests-fx-b']);
});

test('clearing the input statistics is passed to fppd, and the statistics still read afterwards', async ({ request }) => {
  const r = await request.delete('/api/channel/input/stats');
  expect(r.status()).toBe(200);
  expect(await r.json()).toMatchObject({ Status: 'OK', Message: 'Stats Cleared' });
  const stats = await (await request.get('/api/channel/input/stats')).json();
  expect(stats.status).toBe('OK');
  expect(Array.isArray(stats.universes)).toBe(true);
  for (const u of stats.universes) expect(Number(u.packetsReceived ?? 0), JSON.stringify(u)).toBe(0);
});
