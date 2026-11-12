import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, exists, readFile, writeFile } from './pw-helpers';
import { nullSink, startPipeWire, stopPipeWire } from './pw-live';

// POST /api/pipewire/audio/input-groups/volume moves one member's send into
// its input group (the member faders of the mixer;
// www/api/controllers/pipewire.php SetInputGroupMemberVolume; the level
// landing on the loopback is in pw-live-volume.spec.ts).  What it answers
// when there is nothing to move, and that nothing is saved as moved.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const FILE = `${CONFIG}/pipewire-input-groups.json`;
const URL = '/api/pipewire/audio/input-groups/volume';
const seed = () => ({ inputGroups: [
  { id: 1, name: 'Mics', members: [
    { type: 'capture', name: 'Lead Mic', volume: 80 },
    { type: 'fppd_stream', sourceId: 'fppd_stream_3', volume: 70 },
    { type: 'fppd_stream', volume: 65 },
  ] },
  { id: 2, name: 'Music', members: [{ type: 'capture', name: 'Deck', volume: 50 }] },
] });

test.beforeEach(() => writeFile(FILE, seed()));
test.afterEach(() => {
  stopPipeWire();
  cleanupPipeWire();
});

const post = async (request: any, data: unknown) => {
  const r = await request.post(URL, { data });
  expect(r.status()).toBe(200);
  return r.json();
};

test('a call that does not say which member, or names one that is not there, is refused by name', async ({ request }) => {
  const before = readFile(FILE);
  for (const data of [{}, { groupId: 1, memberIndex: 0 }, { groupId: 1, volume: 40 }, { memberIndex: 0, volume: 40 }, []]) {
    expect(await post(request, data), JSON.stringify(data)).toEqual({ status: 'error', message: 'Missing groupId, memberIndex, or volume' });
  }
  expect(await post(request, { groupId: 9, memberIndex: 0, volume: 40 })).toEqual({ status: 'error', message: 'Input group 9 not found' });
  expect(await post(request, { groupId: 2, memberIndex: 1, volume: 40 })).toEqual({ status: 'error', message: 'Member index 1 not found' });
  expect(await post(request, { groupId: 2, memberIndex: -1, volume: 40 })).toEqual({ status: 'error', message: 'Member index -1 not found' });
  expect(readFile(FILE)).toBe(before);
});

test('with no input groups saved, or a file that is not input groups, it says so and makes no file', async ({ request }) => {
  writeFile(FILE, { groups: [] });
  expect(await post(request, { groupId: 1, memberIndex: 0, volume: 40 })).toEqual({ status: 'error', message: 'Invalid input groups config' });
  expect(JSON.parse(readFile(FILE))).toEqual({ groups: [] });
  inPlayer('rm', '-f', FILE);
  expect(await post(request, { groupId: 1, memberIndex: 0, volume: 40 })).toEqual({ status: 'error', message: 'No input groups configured' });
  expect(exists(FILE)).toBe(false);
});

test('with no PipeWire running the level is not saved as set', async ({ request }) => {
  const before = readFile(FILE);
  expect(await post(request, { groupId: 1, memberIndex: 0, volume: 40 })).toEqual({ status: 'error', message: 'Cannot connect to PipeWire' });
  expect(await post(request, { groupId: 1, memberIndex: 0, volume: 40, mute: true })).toEqual({ status: 'error', message: 'Cannot connect to PipeWire' });
  expect(readFile(FILE)).toBe(before);
});

test('a member with no loopback in the graph is named, and a stream that feeds the bus directly is sent to its slot', async ({ request }) => {
  startPipeWire({ objects: [nullSink('fpp_tests_unrelated')] });
  const before = readFile(FILE);
  expect(await post(request, { groupId: 1, memberIndex: 0, volume: 40 })).toEqual({ status: 'error',
    message: "Loopback node 'fpp_loopback_ig1_lead_mic' not found in PipeWire (is it muted or not applied?)" });
  expect(await post(request, { groupId: 1, memberIndex: 1, volume: 40 })).toEqual({ status: 'error',
    message: 'fppd_stream_3 feeds this bus directly, so it has no send level of its own. Set the source on media stream slot 3, or the bus output on this group.',
    nodeName: 'fppd_stream_3', slot: 3, directToBus: true });
  // A stream member saved without its source is slot 1.
  expect(await post(request, { groupId: 1, memberIndex: 2, volume: 40 })).toMatchObject({ status: 'error', nodeName: 'fppd_stream_1', slot: 1, directToBus: true });
  expect(readFile(FILE)).toBe(before);
});

test('a member index that is not a number is refused, not taken as the first member', async ({ request }) => {
  test.fail(true, 'intval() of anything is an index: "second" is member 0 (FUTURE.md)');
  // No PipeWire: the answer shows how far the call got.
  const got = await post(request, { groupId: 1, memberIndex: 'second', volume: 40 });
  expect(got.message).not.toBe('Cannot connect to PipeWire');
  expect(got).toMatchObject({ status: 'error' });
});
