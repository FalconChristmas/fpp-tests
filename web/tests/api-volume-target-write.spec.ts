import { test, expect } from './fixtures';
import { container } from './container';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { listen, nullSink, sinkVolume, startPipeWire, stopPipeWire } from './pw-live';

// POST /api/system/volume with a "target" moves one level in the PipeWire
// graph instead of the master: what the Volume Set and Volume Adjust commands
// send (www/api/controllers/system.php SystemSetAudio, SystemSetTargetedAudio;
// stream slots are in pw-slot-volume.spec.ts, the reads in
// api-volume-target-read.spec.ts).  Here an output group and its card, on a
// real PipeWire in the player: the level is read back from the sink and from
// the saved groups, and the master is seen not to move.

test.skip(!container, 'runs a PipeWire inside the run-web.sh container');

const FILE = `${CONFIG}/pipewire-audio-groups.json`;
const GROUP = 'fpp_group_yard';
const CARD = 'fpp_fx_g1_card_a';
const seed = () => ({ groups: [{ id: 1, name: 'Yard', enabled: true, channels: 2, volume: 60, members: [{ cardId: 'Card-A', volume: 90 }] }] });
const stored = () => JSON.parse(readFile(FILE)).groups[0];
const URL = '/api/system/volume';

let master = 0;
test.beforeEach(async ({ request }) => {
  master = (await (await request.get(URL)).json()).volume;
  writeFile(FILE, seed());
  startPipeWire({ objects: [nullSink(GROUP), nullSink(CARD)] });
  listen(GROUP);
  listen(CARD);
});
test.afterEach(async ({ request }) => {
  stopPipeWire();
  cleanupPipeWire();
  await request.post(URL, { data: { volume: master } });
});
const masterNow = async (request: any) => (await (await request.get(URL)).json()).volume;

test('a sink target sets that group or card, saved with it, and the master stays', async ({ request }) => {
  let r = await request.post(URL, { data: { target: `sink:${GROUP}`, volume: 35 } });
  expect(await r.json()).toEqual({ status: 'OK' });
  expect(sinkVolume(GROUP)).toBe(35);
  expect(stored()).toMatchObject({ volume: 35, members: [{ cardId: 'Card-A', volume: 90 }] });

  // The object form of the same address, for the card.
  r = await request.post(URL, { data: { target: { type: 'sink', id: CARD }, volume: 20 } });
  expect(await r.json()).toEqual({ status: 'OK' });
  expect(sinkVolume(CARD)).toBe(20);
  expect(stored()).toMatchObject({ volume: 35, members: [{ cardId: 'Card-A', volume: 20, mute: false }] });
  expect(await masterNow(request), 'the master moved').toBe(master);
});

test('an adjustment is made from the target\'s saved level and held to 0-100', async ({ request }) => {
  for (const [adjust, want] of [[-15, 45], [70, 100], ['-30', 70], [-500, 0]] as const) {
    const r = await request.post(URL, { data: { target: `sink:${GROUP}`, adjust } });
    expect(await r.json(), String(adjust)).toEqual({ status: 'OK' });
    expect(sinkVolume(GROUP), String(adjust)).toBe(want);
    expect(stored().volume, String(adjust)).toBe(want);
  }
  // A target's level stops at 100 here, though the group fader itself goes to 150.
  const r = await request.post(URL, { data: { target: `sink:${GROUP}`, volume: 140 } });
  expect(await r.json()).toEqual({ status: 'OK' });
  expect(sinkVolume(GROUP)).toBe(100);
  expect(await masterNow(request)).toBe(master);
});

test('a target that is not an address is refused, and nothing moves', async ({ request }) => {
  const before = readFile(FILE);
  for (const target of ['sink', 'slot', 'input:1', 'route:1', 'master', '', 'card:0', { type: 'sink' }, { id: GROUP }, ['sink', GROUP], 7]) {
    const r = await request.post(URL, { data: { target, volume: 10 } });
    expect(r.status(), JSON.stringify(target)).toBe(400);
    expect(await r.json(), JSON.stringify(target)).toEqual({ status: 'ERROR', message: 'Unrecognized volume target; see GET /api/pipewire/audio/targets' });
  }
  // An adjustment to a sink nobody saved has nothing to start from.
  const r = await request.post(URL, { data: { target: 'sink:fpp_group_nobody', adjust: 5 } });
  expect(r.status()).toBe(400);
  expect(await r.json()).toEqual({ status: 'ERROR', message: 'Could not read current volume for target' });

  expect(readFile(FILE)).toBe(before);
  expect(sinkVolume(GROUP)).toBe(100);
  expect(await masterNow(request)).toBe(master);
});

test('a target with no level given is refused, not set to 75', async ({ request }) => {
  test.fail(true, 'the level starts at 75 and is only replaced when the body has one (FUTURE.md)');
  const r = await request.post(URL, { data: { target: `sink:${GROUP}` } });
  expect(stored().volume, `the group was set (answer ${r.status()} ${await r.text()})`).toBe(60);
  expect(r.status()).toBe(400);
});

test('a body that is not a level leaves the master where it was', async ({ request }) => {
  test.fail(true, 'no volume, or no JSON at all, is a master volume of 75 (FUTURE.md)');
  await request.post(URL, { data: { volume: 12 } });
  expect(await masterNow(request)).toBe(12);
  for (const body of ['{}', '{"volum": 30}', '', 'loud']) {
    const r = await request.post(URL, { data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });
    expect(await masterNow(request), `${JSON.stringify(body)}: the master was set (answer ${r.status()} ${await r.text()})`).toBe(12);
    expect(r.status(), body).toBe(400);
  }
});
