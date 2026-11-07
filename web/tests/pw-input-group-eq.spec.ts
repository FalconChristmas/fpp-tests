import { test, expect } from './fixtures';
import { container } from './container';
import { CONFIG, cleanupPipeWire, commandLog, readFile, standInCommand, standInPwDump, writeFile } from './pw-helpers';

// The input group effects and the live state of the Pipewire mixer:
// POST /api/pipewire/audio/input-groups/effects saves a group's effects for the
// next Apply, POST .../input-groups/eq/update moves an EQ band on the running
// filter-chain with pw-cli (a stand-in here, logging what it was asked) and
// saves it, GET /api/pipewire/audio/node-states maps every mixer control to the
// state of the node carrying its audio, and GET .../stream/status says which
// stream slots are playing.  The container runs no PipeWire: the graph is a
// stand-in pw-dump.

test.skip(!container, "writes the run-web.sh container's Pipewire config");

const INPUT_GROUPS = `${CONFIG}/pipewire-input-groups.json`;
const OUTPUT_GROUPS = `${CONFIG}/pipewire-audio-groups.json`;

test.afterEach(() => cleanupPipeWire());

const eq = (bands: unknown[]) => ({ eq: { enabled: true, bands } });
const band = (freq: number) => ({ type: 'peaking', freq, gain: 0, q: 1 });

function node(id: number, name: string, state = 'running', target?: string) {
  const props: Record<string, unknown> = { 'node.name': name };
  if (target) props['node.target'] = target;
  return { id, type: 'PipeWire:Interface:Node', info: { state, props } };
}

function inputGroups() {
  return JSON.parse(readFile(INPUT_GROUPS)).inputGroups;
}

test('a group\'s effects are saved for the next apply, and only on a group that exists', async ({ request }) => {
  const save = (data: unknown) => request.post('/api/pipewire/audio/input-groups/effects', { data });

  expect((await save({ groupId: 1 })).status()).toBe(400);
  expect(await (await save({ groupId: 1, effects: {} })).json())
    .toMatchObject({ status: 'error', message: 'No input groups configured' });

  writeFile(INPUT_GROUPS, { inputGroups: [{ id: 1, name: 'Bus', channels: 2 }, { id: 2, name: 'Mic', channels: 1 }] });
  expect(await (await save({ groupId: 7, effects: {} })).json())
    .toMatchObject({ status: 'error', message: 'Input group 7 not found' });

  const effects = eq([band(120), band(4000)]);
  expect(await (await save({ groupId: '2', effects })).json()).toMatchObject({ status: 'OK', needsApply: true });
  const [b, m] = inputGroups();
  expect(b.effects).toBeUndefined();
  expect(m.effects).toEqual(effects);
});

test('an EQ band move sets that band on each of the group\'s channels and saves it', async ({ request }) => {
  writeFile(INPUT_GROUPS, { inputGroups: [
    { id: 1, name: 'Other', channels: 2, effects: eq([band(100)]) },
    { id: 3, name: 'Surround', channels: 4, effects: eq([band(100), band(1000)]) },
  ] });
  standInPwDump([node(51, 'fpp_fx_ig_1'), node(57, 'fpp_fx_ig_3')]);
  standInCommand('pw-cli', '');

  const r = await request.post('/api/pipewire/audio/input-groups/eq/update',
    { data: { groupId: 3, band: 1, freq: 2500, gain: -4.5, q: 0.7 } });
  expect(await r.json()).toMatchObject({ status: 'OK', message: 'EQ band 1 updated' });

  const calls = commandLog('pw-cli');
  const expected: string[] = [];
  for (const ch of ['l', 'r', 'c', 'lfe']) {
    expected.push(`set-param 57 Props { "eq_${ch}_1:Freq": 2500 }`,
      `set-param 57 Props { "eq_${ch}_1:Gain": -4.5 }`,
      `set-param 57 Props { "eq_${ch}_1:Q": 0.7 }`);
  }
  expect(calls).toEqual(expected);

  const [other, surround] = inputGroups();
  expect(surround.effects.eq.bands).toEqual([band(100), { type: 'peaking', freq: 2500, gain: -4.5, q: 0.7 }]);
  expect(other.effects.eq.bands).toEqual([band(100)]);
});

test('an EQ band move sets only what it is given, and says so when pw-cli fails', async ({ request }) => {
  // A group not in the saved config is taken as stereo, and nothing is saved.
  standInPwDump([node(60, 'fpp_fx_ig_5')]);
  standInCommand('pw-cli', 'echo "Error: \\"set-param\\": failed"\n');

  const r = await request.post('/api/pipewire/audio/input-groups/eq/update', { data: { groupId: 5, band: 0, gain: 2 } });
  expect(await r.json()).toMatchObject({ status: 'error', message: 'Some EQ params failed to update' });
  expect(commandLog('pw-cli')).toEqual([
    'set-param 60 Props { "eq_l_0:Gain": 2 }',
    'set-param 60 Props { "eq_r_0:Gain": 2 }',
  ]);
});

test('an EQ band move with nothing to move is an error and runs no pw-cli', async ({ request }) => {
  writeFile(INPUT_GROUPS, { inputGroups: [{ id: 1, name: 'Bus', channels: 2, effects: eq([band(100)]) }] });
  standInCommand('pw-cli', '');
  const move = async (data: unknown) =>
    (await request.post('/api/pipewire/audio/input-groups/eq/update', { data })).json();

  expect(await move({ groupId: 1 })).toMatchObject({ status: 'error', message: 'Missing groupId or band' });

  standInPwDump([]);
  writeFile('/usr/local/bin/pw-dump', '#!/bin/sh\n'); // prints nothing, as with no PipeWire running
  expect(await move({ groupId: 1, band: 0, gain: 3 })).toMatchObject({ status: 'error', message: 'Cannot connect to PipeWire' });

  standInPwDump([node(51, 'fpp_fx_ig_2'), { id: 52, type: 'PipeWire:Interface:Link', info: {} }]);
  expect(await move({ groupId: 1, band: 0, gain: 3 })).toMatchObject({
    status: 'error', message: "Filter-chain node 'fpp_fx_ig_1' not found. Apply input groups first.",
  });
  expect(commandLog('pw-cli')).toEqual([]);
  expect(inputGroups()[0].effects.eq.bands).toEqual([band(100)]);
});

test('each mixer control gets the state of the node that carries its audio', async ({ request }) => {
  writeFile(OUTPUT_GROUPS, { groups: [
    { id: 1, name: 'Front Speakers', members: [{ cardId: 'Headphones' }, { cardId: '' }] },
    { id: 2, name: 'Yard', members: [] },
  ] });
  writeFile(INPUT_GROUPS, { inputGroups: [
    // EQ on: its bus is the routing hub.
    { id: 1, name: 'Show', effects: eq([band(100)]), members: [
      { type: 'fppd_stream', sourceId: 'fppd_stream_2' },      // no loopback: its source stream
      { type: 'fppd_stream', sourceId: 'fppd_stream_3' },      // nor a source: the bus
      { type: 'capture', name: 'USB Mic' },                    // a loopback of its own
    ] },
    // EQ off (or with no bands): its bus is fpp_input_<slug>.
    { id: 2, name: 'Line In', effects: { eq: { enabled: true, bands: [] } }, members: [
      { type: 'capture', name: 'Deck' },                       // output.-prefixed loopback
      { type: 'capture' },                                     // no loopback: the bus
    ] },
  ] });
  standInPwDump([
    node(1, 'fppd_stream_1', 'running'),
    node(2, 'fppd_stream_2', 'idle'),
    node(3, 'fpp_group_front_speakers', 'running'),
    node(4, 'fpp_fx_g1_headphones', 'suspended'),
    node(5, 'fpp_route_ig_1', 'running'),
    node(6, 'fpp_loopback_ig1_usb_mic', 'error'),
    node(7, 'fpp_input_line_in', 'idle'),
    node(8, 'output.fpp_loopback_ig2_deck', 'running'),
    // Routing paths: found by node.target, and the bus name in theirs.
    node(9, 'output.fpp_route_ig_1.0', 'running', 'fpp_group_front_speakers'),
    node(10, 'output.fpp_input_line_in.1', 'suspended', 'fpp_group_yard'),
    node(11, 'output.something_else', 'error', 'fpp_group_front_speakers'),
    { id: 12, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'fpp_no_state' } } },
    { id: 13, type: 'PipeWire:Interface:Node', info: { state: 'running', props: {} } },
    { id: 14, type: 'PipeWire:Interface:Port', info: { props: { 'node.name': 'not_a_node' } } },
  ]);

  const r = await (await request.get('/api/pipewire/audio/node-states')).json();
  expect(r.status).toBe('OK');
  expect(r.nodes).toMatchObject({ fppd_stream_1: 'running', fpp_no_state: 'unknown' });
  expect(Object.keys(r.nodes)).not.toContain('not_a_node');
  expect(Object.keys(r.nodes)).toHaveLength(12);

  expect(r.entities).toEqual({
    'slot:1': 'running', 'slot:2': 'idle', 'slot:3': 'unknown', 'slot:4': 'unknown', 'slot:5': 'unknown',
    'sink:fpp_group_front_speakers': 'running',
    'sink:fpp_fx_g1_headphones': 'suspended',
    'sink:fpp_group_yard': 'unknown',
    'input:1:0': 'idle', 'input:1:1': 'running', 'input:1:2': 'error',
    'route:1:1': 'running', 'route:1:2': 'unknown',
    'input:2:0': 'running', 'input:2:1': 'idle',
    'route:2:1': 'unknown', 'route:2:2': 'suspended',
  });
});

test('node states with no PipeWire, or with no groups saved, have nothing but the slots', async ({ request }) => {
  standInPwDump([]);
  writeFile('/usr/local/bin/pw-dump', '#!/bin/sh\n');
  expect(await (await request.get('/api/pipewire/audio/node-states')).json())
    .toEqual({ status: 'error', message: 'Cannot connect to PipeWire', nodes: [] });

  standInPwDump([]);
  writeFile('/tmp/fpp-tests-pw-dump.json', 'not json');
  expect(await (await request.get('/api/pipewire/audio/node-states')).json())
    .toMatchObject({ status: 'error', message: 'Invalid PipeWire dump' });

  standInPwDump([node(1, 'fppd_stream_4', 'idle')]);
  writeFile(INPUT_GROUPS, { notInputGroups: [] });
  const r = await (await request.get('/api/pipewire/audio/node-states')).json();
  expect(r.entities).toEqual({
    'slot:1': 'unknown', 'slot:2': 'unknown', 'slot:3': 'unknown', 'slot:4': 'idle', 'slot:5': 'unknown',
  });
});

test('a stream slot is playing while its node is in the graph', async ({ request }) => {
  standInPwDump([node(1, 'fppd_stream_2'), node(2, 'fppd_stream_5', 'idle'), node(3, 'fppd_stream_9')]);
  const slots = await (await request.get('/api/pipewire/audio/stream/status')).json();
  expect(slots).toHaveLength(5);
  expect(slots[1]).toEqual({
    slot: 2, nodeName: 'fppd_stream_2', nodeDescription: 'FPP Media Stream 2', status: 'playing', mediaFilename: '',
  });
  expect(slots.map((s: { status: string }) => s.status).slice(1)).toEqual(['playing', 'idle', 'idle', 'playing']);

  standInPwDump([]);
  writeFile('/usr/local/bin/pw-dump', '#!/bin/sh\n');
  const none = await (await request.get('/api/pipewire/audio/stream/status')).json();
  expect(none.map((s: { status: string }) => s.status).slice(1)).toEqual(['idle', 'idle', 'idle', 'idle']);
});
