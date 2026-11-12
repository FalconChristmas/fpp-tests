import { test, expect } from './fixtures';
import { container } from './container';
import { CONFIG, cleanupPipeWire, exists, readFile, writeFile } from './pw-helpers';
import { listen, nullSink, sinkMuted, sinkVolume, startPipeWire, stopPipeWire } from './pw-live';

// POST /api/pipewire/audio/group/volume moves a sink's level or mute and
// writes it into the saved output groups, finding the group or the member
// card the sink belongs to by its node name
// (www/api/controllers/pipewire.php SetPipeWireGroupVolume; the group fader
// itself is in pw-live-volume.spec.ts).  Against a real PipeWire in the
// player with null sinks named as FPP names its own: the level is read back
// from PipeWire and from the file.

test.skip(!container, 'runs a PipeWire inside the run-web.sh container');

const FILE = `${CONFIG}/pipewire-audio-groups.json`;
const URL = '/api/pipewire/audio/group/volume';
const GROUP = 'fpp_group_yard';
const CARD = 'fpp_fx_g1_usb_card_1';       // group 1's card "USB-Card.1"
const DIRECT = 'fpp_tests_direct_node';   // a member that targets a node itself
const STRAY = 'fpp_tests_stray';          // a sink no group has
const SINKS = [GROUP, CARD, DIRECT, STRAY, 'fpp_group_porch'];

const seed = () => ({ somethingElse: 'kept', groups: [
  { id: 1, name: 'Yard', enabled: true, channels: 2, volume: 100, mute: false, members: [
    { cardId: 'USB-Card.1', volume: 90, mute: true },
    { cardId: 'other', nodeTarget: DIRECT, volume: 80 },
  ] },
  { id: 2, name: 'Porch', enabled: true, channels: 2, volume: 70, members: [{ cardId: 'USB-Card.1', volume: 60 }] },
] });
const stored = () => JSON.parse(readFile(FILE));

test.beforeEach(() => {
  writeFile(FILE, seed());
  startPipeWire({ objects: SINKS.map((s) => nullSink(s)) });
  for (const s of SINKS) listen(s);
});
test.afterEach(() => {
  stopPipeWire();
  cleanupPipeWire();
});

test('a member card\'s fader moves its own sink and is saved on that member of that group only', async ({ request }) => {
  const r = await request.post(URL, { data: { sink: CARD, volume: 55 } });
  expect(await r.json()).toEqual({ status: 'OK' });
  expect(sinkVolume(CARD)).toBe(55);

  const want = seed();
  // A level is an unmute: the saved mute goes with it.
  want.groups[0].members[0] = { cardId: 'USB-Card.1', volume: 55, mute: false };
  expect(stored()).toEqual(want);
  expect(sinkVolume(GROUP), 'the group moved with its member').toBe(100);
});

test('a member that targets a node directly is found by that node, and the level is held to 0-150', async ({ request }) => {
  for (const [sent, kept] of [[400, 150], [-20, 0], ['65', 65]] as const) {
    const r = await request.post(URL, { data: { sink: DIRECT, volume: sent } });
    expect(await r.json(), String(sent)).toEqual({ status: 'OK' });
    expect(sinkVolume(DIRECT), String(sent)).toBe(kept);
    expect(stored().groups[0].members[1], String(sent)).toEqual({ cardId: 'other', nodeTarget: DIRECT, volume: kept, mute: false });
  }
  expect(stored().groups[1]).toEqual(seed().groups[1]);
});

test('a mute is a mute: the sink\'s level and the saved level stay for the unmute', async ({ request }) => {
  let r = await request.post(URL, { data: { sink: GROUP, volume: 30, mute: true } });
  expect(await r.json()).toEqual({ status: 'OK' });
  expect(sinkMuted(GROUP)).toBe(true);
  expect(sinkVolume(GROUP)).toBe(100);
  expect(stored().groups[0]).toMatchObject({ volume: 100, mute: true });

  r = await request.post(URL, { data: { sink: CARD, volume: 0, mute: false } });
  expect(await r.json()).toEqual({ status: 'OK' });
  expect(sinkMuted(CARD)).toBe(false);
  expect(stored().groups[0].members[0]).toEqual({ cardId: 'USB-Card.1', volume: 90, mute: false });
  expect(stored().groups[0], 'the group was unmuted by its member').toMatchObject({ volume: 100, mute: true });
});

test('a call without a sink or a level, or for a sink PipeWire does not have, saves nothing', async ({ request }) => {
  const before = readFile(FILE);
  for (const data of [{ volume: 40 }, { sink: GROUP }, {}, { sink: GROUP, mute: true }]) {
    const r = await request.post(URL, { data });
    expect(r.status(), JSON.stringify(data)).toBe(400);
    expect(await r.json()).toEqual({ status: 'ERROR', message: 'Missing sink or volume' });
  }
  // A group that is saved but not running: nothing took the level, so it is not saved as taken.
  writeFile(FILE, { groups: [{ id: 3, name: 'Gone', volume: 100, members: [] }] });
  const gone = readFile(FILE);
  const r = await request.post(URL, { data: { sink: 'fpp_group_gone', volume: 40 } });
  expect(await r.json()).toMatchObject({ status: 'ERROR', message: 'Failed to set volume' });
  expect(readFile(FILE)).toBe(gone);
  writeFile(FILE, JSON.parse(before));

  expect(sinkVolume(GROUP)).toBe(100);
  expect(sinkMuted(GROUP)).toBe(false);
});

test('a sink no group has takes the level, and the saved groups are not rewritten', async ({ request }) => {
  const before = readFile(FILE);
  // A name that is one shell word only if it is quoted.
  for (const sink of [STRAY, `${STRAY}; touch /tmp/fpp-tests-group-volume-ran`]) {
    const r = await request.post(URL, { data: { sink, volume: 45 } });
    expect((await r.json()).status, sink).toBe(sink === STRAY ? 'OK' : 'ERROR');
  }
  expect(sinkVolume(STRAY)).toBe(45);
  expect(readFile(FILE)).toBe(before);
  expect(exists('/tmp/fpp-tests-group-volume-ran'), 'the sink name was run as a command').toBe(false);
});

test('a level that is not a number is refused, not taken as silence', async ({ request }) => {
  test.fail(true, 'intval() of anything is a level: "loud" is 0 (FUTURE.md)');
  const r = await request.post(URL, { data: { sink: GROUP, volume: 'loud' } });
  expect(sinkVolume(GROUP), `the group was set (answer ${r.status()} ${await r.text()})`).toBe(100);
  expect(stored().groups[0].volume).toBe(100);
  expect(r.status()).toBe(400);
});
