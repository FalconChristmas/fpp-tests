import { test, expect as hardExpect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, commandLog, fakeSoundCards, readFile, standInCommand, standInPwDump, writeFile } from './pw-helpers';
import { listen, stopPipeWire } from './pw-live';
import { channels, describe, graph, linked, loadGeneratedConf, props, reaches, standInNode } from './pw-load';

// FPP_TESTS_SOFT=1 makes every check soft, so a run on a fix's parent shows
// the real-PipeWire half failing as well as the PHP half before it.
const expect = process.env.FPP_TESTS_SOFT === '1' ? hardExpect.configure({ soft: true }) : hardExpect;

// Input groups (mix buses) as the API saves them and as Apply generates them
// into 96-fpp-input-groups.conf: each bus is a combine-stream sink whose
// stream.rules fan out to the output groups it is routed to, with loopbacks
// feeding it from capture devices and other sources.  For the PHP side the
// sources come from a stand-in pw-dump, and cards from fake /proc/asound
// entries (fakeSoundCards).
//
// Then the receiving end: everything an input group generates is PipeWire's
// own (combine-streams, loopbacks, null-sink tees), so the conf is loaded in
// full by a real PipeWire (pw-load.ts), with null nodes standing in for the
// output groups' sinks and the capture devices, and the real pw-dump has to
// show the bus, its links and its channels.

test.skip(!container, 'reads the generated config inside the run-web.sh container');

// Each Apply restarts fppd and waits for it to come back.
test.describe.configure({ timeout: 240_000 });

const CONF = '/etc/pipewire/pipewire.conf.d/96-fpp-input-groups.conf';
const SETTINGS = '/home/fpp/media/settings';

test.afterEach(() => {
  inPlayer('sh', '-c', `sed -i '/^PipeWireSinkName /d' ${SETTINGS}`);
  stopPipeWire();
  cleanupPipeWire();
});

// Wait until the real graph has every [from, to] in `reach` connected.
async function expectReaches(pairs: [string, string][]) {
  await expect.poll(() => {
    const g = graph();
    return pairs.filter(([a, b]) => !reaches(g, a, b)).map(([a, b]) => `${a} -> ${b}`);
  }, { timeout: 10_000, message: `not linked up:\n${describe(graph())}` }).toEqual([]);
}

function seedOutputGroups(groups: { id: number; name: string; channels?: number; enabled?: boolean }[]) {
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: groups.map((g) => ({ channels: 2, enabled: true, members: [], ...g })),
  });
}

async function saveInputGroups(request: APIRequestContext, inputGroups: unknown[]) {
  const save = await request.post('/api/pipewire/audio/input-groups', { data: { inputGroups } });
  expect(save.ok(), await save.text()).toBe(true);
}

async function applyInputGroups(request: APIRequestContext, inputGroups?: unknown[]): Promise<string> {
  if (inputGroups) await saveInputGroups(request, inputGroups);
  const apply = await request.post('/api/pipewire/audio/input-groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  return readFile(CONF);
}

function sinkName(): string {
  const line = inPlayer('sh', '-c', `grep '^PipeWireSinkName ' ${SETTINGS} || true`).trim();
  return line.replace(/^PipeWireSinkName\s*=\s*"?([^"]*)"?$/, '$1');
}

// The module block that starts at the "# <label>" comment.
function block(conf: string, label: string): string {
  const at = conf.indexOf(`# ${label}`);
  expect(at, `no "# ${label}" in:\n${conf}`).toBeGreaterThan(-1);
  const next = conf.indexOf('\n  # ', at + 1);
  return conf.slice(at, next === -1 ? undefined : next);
}

// The create-stream block of the stream.rules entry that targets `sink`.
function createStream(conf: string, sink: string): string {
  const at = conf.indexOf(`node.target = "${sink}"`);
  expect(at, `no stream rule targets ${sink}:\n${conf}`).toBeGreaterThan(-1);
  return conf.slice(at, conf.indexOf('}', at));
}

function value(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^\\s*${key.replace(/\./g, '\\.')}\\s*=\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : undefined;
}

// A capture device as pw-dump lists it.
function sourceNode(id: number, name: string, card: number, extra: Record<string, unknown> = {}) {
  return {
    id, type: 'PipeWire:Interface:Node',
    info: { state: 'idle', props: { 'node.name': name, 'node.description': `${name} desc`, 'media.class': 'Audio/Source',
      'alsa.card': card, 'audio.channels': 2, ...extra } },
  };
}

test('an input group saved through the API becomes a mix bus sink', async ({ request }) => {
  // Feature: 2854e3ca2. Input groups: saved and read back through
  // /api/pipewire/audio/input-groups, the capture sources listed by
  // /api/pipewire/audio/sources, and Apply writes 96-fpp-input-groups.conf
  // with a combine-stream sink per group.
  fakeSoundCards([{ id: 'Mic' }]);
  standInPwDump([sourceNode(50, 'alsa_input.usb-fpp_tests_mic-00.analog-stereo', 0)]);
  const sources = await request.get('/api/pipewire/audio/sources');
  expect(sources.ok(), await sources.text()).toBe(true);
  expect((await sources.json()).map((s: any) => [s.name, s.cardId]))
    .toEqual([['alsa_input.usb-fpp_tests_mic-00.analog-stereo', 'Mic']]);

  seedOutputGroups([{ id: 1, name: 'Out' }]);
  const groups = [{ id: 1, name: 'Show Bus', enabled: true, channels: 2, outputs: [1],
    members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1', name: 'Media' }] }];
  await saveInputGroups(request, groups);
  const got = await request.get('/api/pipewire/audio/input-groups');
  expect(got.ok(), await got.text()).toBe(true);
  const back = (await got.json()).inputGroups;
  expect(back.map((g: any) => [g.name, g.outputs, g.members.map((m: any) => m.sourceId)]))
    .toEqual([['Show Bus', [1], ['fppd_stream_1']]]);

  const conf = await applyInputGroups(request);
  const bus = block(conf, 'Input Group: Show Bus');
  expect(bus).toContain('libpipewire-module-combine-stream');
  expect(value(bus, 'combine.mode'), bus).toBe('sink');
  expect(value(bus, 'node.name'), bus).toBe('"fpp_input_show_bus"');

  loadGeneratedConf([standInNode('fpp_group_out')], ['fpp_input_show_bus']);
  expect(props(graph(), 'fpp_input_show_bus')['media.class']).toBe('Audio/Sink');
  await expectReaches([['fpp_input_show_bus', 'fpp_group_out']]);
});

test("a bus's stream rules fan out to the output group sinks it is routed to", async ({ request }) => {
  // Regression: 64364ef94. The bus's stream.rules matched its own sources
  // (fpp_loopback_ig*, fppd_stream_*) and a separate loopback per route
  // copied the bus into each output group; combine-stream rules pick the
  // sinks the bus plays TO, so those matched nothing.  They now match each
  // routed output group's sink, and a bus routed to no enabled output group
  // is skipped.
  seedOutputGroups([{ id: 1, name: 'Front' }, { id: 2, name: 'Back' }, { id: 3, name: 'Off', enabled: false }]);
  const conf = await applyInputGroups(request, [
    { id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1, 2],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] },
    { id: 2, name: 'Nowhere', enabled: true, channels: 2, outputs: [3],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_2' }] },
  ]);
  const bus = block(conf, 'Input Group: Bus');
  for (const sink of ['fpp_group_front', 'fpp_group_back']) {
    const rule = bus.slice(bus.lastIndexOf('{ matches', bus.indexOf(`node.name = "${sink}"`)));
    expect(rule, `no rule matches ${sink}:\n${bus}`).toMatch(new RegExp(`media\\.class = "Audio/Sink"\\s+node\\.name = "${sink}"`));
    expect(value(createStream(bus, sink), 'node.target')).toBe(`"${sink}"`);
  }
  expect(bus).not.toContain('fpp_loopback_ig');
  expect(conf).not.toContain('fpp_route_ig1_to_og');
  expect(conf).toContain('# Input Group: Nowhere (SKIPPED');

  loadGeneratedConf([standInNode('fpp_group_front'), standInNode('fpp_group_back')], ['fpp_input_bus']);
  await expectReaches([['fpp_input_bus', 'fpp_group_front'], ['fpp_input_bus', 'fpp_group_back']]);
  const g = graph();
  expect(linked(g, 'output.fpp_input_bus_fpp_group_front', 'fpp_group_front'), describe(g)).toBe(true);
  expect(g.nodes.has('fpp_input_nowhere'), 'the bus routed nowhere was built').toBe(false);
});

test('a capture member feeds the bus at its own level, settable live', async ({ request }) => {
  // Regression: 54101241b. A member's volume was computed but never written
  // into its loopback, so every source joined the bus at full level.  Phase 2
  // also added /api/pipewire/audio/input-groups/volume, which sets the level
  // on the running loopback and saves it.
  seedOutputGroups([{ id: 1, name: 'Out' }]);
  const conf = await applyInputGroups(request, [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1],
    members: [{ type: 'capture', name: 'Mic', cardId: 'Mic', nodeName: 'alsa_input.usb-fpp_tests_mic-00.analog-stereo',
      volume: 50 }] }]);
  const loop = block(conf, 'Loopback: Mic');
  const playback = loop.slice(loop.indexOf('playback.props'));
  expect(value(playback, 'channelmix.volume'), loop).toBe('0.5');

  // In a real PipeWire: the loopback captures the device into the bus.  (Its
  // channelmix.volume is in the node's properties, but PipeWire does not apply
  // it; pw-saved-levels-after-restart.spec.ts measures that.)
  const mic = 'alsa_input.usb-fpp_tests_mic-00.analog-stereo';
  loadGeneratedConf([standInNode('fpp_group_out'), standInNode(mic, { mediaClass: 'Audio/Source' })],
    ['fpp_input_bus', 'output.fpp_loopback_ig1_mic']);
  await expectReaches([[mic, 'fpp_input_bus'], ['fpp_input_bus', 'fpp_group_out']]);
  expect(props(graph(), 'output.fpp_loopback_ig1_mic')['channelmix.volume']).toBe(0.5);

  // The live control, against the same PipeWire: the level lands on the
  // loopback's playback stream and is saved.
  listen('fpp_input_bus');
  const r = await request.post('/api/pipewire/audio/input-groups/volume', { data: { groupId: 1, memberIndex: 0, volume: 40 } });
  expect(r.ok(), await r.text()).toBe(true);
  const body = await r.json();
  expect(body.status, JSON.stringify(body)).toBe('OK');
  expect(body.nodeName).toBe('fpp_loopback_ig1_mic');
  const saved = JSON.parse(readFile(`${CONFIG}/pipewire-input-groups.json`)).inputGroups[0].members[0];
  expect(saved.volume).toBe(40);
  await expect.poll(() => {
    const n = graph().nodes.get('output.fpp_loopback_ig1_mic');
    return Object.assign({}, ...(n?.info?.params?.Props ?? [])).channelVolumes;
  }, { timeout: 5_000 }).toEqual([0.4, 0.4].map((v) => expect.closeTo(v, 3)));
});

test('a capture member targets its own card\'s node, not every node that looks like it', async ({ request }) => {
  // Regression: b63a87743. A capture member's loopback targeted the regex
  // "~alsa_input.*<cardId>.*", which also matches a second card of the same
  // model (Device and Device_1): the loopback could capture the wrong one.
  // The exact node of the member's card is looked up instead.
  fakeSoundCards([{ id: 'Device' }, { id: 'Device_1' }]);
  standInPwDump([
    sourceNode(50, 'alsa_input.usb-C-Media_USB_Audio_Device-00.analog-stereo', 0),
    sourceNode(51, 'alsa_input.usb-C-Media_USB_Audio_Device-00.analog-stereo.2', 1),
  ]);
  seedOutputGroups([{ id: 1, name: 'Out' }]);
  const conf = await applyInputGroups(request, [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1],
    members: [{ type: 'capture', name: 'Second', cardId: 'Device_1' }] }]);
  const loop = block(conf, 'Loopback: Second');
  const capture = loop.slice(loop.indexOf('capture.props'), loop.indexOf('playback.props'));
  expect(value(capture, 'node.target'), loop).toBe('"alsa_input.usb-C-Media_USB_Audio_Device-00.analog-stereo.2"');

  const first = 'alsa_input.usb-C-Media_USB_Audio_Device-00.analog-stereo';
  const second = `${first}.2`;
  loadGeneratedConf([standInNode('fpp_group_out'), standInNode(first, { mediaClass: 'Audio/Source' }),
    standInNode(second, { mediaClass: 'Audio/Source' })], ['input.fpp_loopback_ig1_second']);
  await expectReaches([[second, 'fpp_input_bus']]);
  expect(linked(graph(), first, 'input.fpp_loopback_ig1_second'), 'the other card is captured too').toBe(false);
});

test('a 6-channel bus routed to a 6-channel group keeps all six channels', async ({ request }) => {
  // Regression: c836d2cf5. The bus's stream to an output group named no
  // channel layout, so combine-stream made it stereo: a 5.1 bus into a 5.1
  // output group carried only FL and FR.
  seedOutputGroups([{ id: 1, name: 'Surround', channels: 6 }]);
  const conf = await applyInputGroups(request, [{ id: 1, name: 'Bus', enabled: true, channels: 6, outputs: [1],
    members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }]);
  const rule = createStream(conf, 'fpp_group_surround');
  expect(value(rule, 'audio.position'), rule).toBe('[ FL FR FC LFE RL RR ]');
  expect(value(rule, 'combine.audio.position'), rule).toBe('[ FL FR FC LFE RL RR ]');

  const six = ['FL', 'FR', 'FC', 'LFE', 'RL', 'RR'];
  loadGeneratedConf([standInNode('fpp_group_surround', { positions: six })], ['output.fpp_input_bus_fpp_group_surround']);
  await expectReaches([['fpp_input_bus', 'fpp_group_surround']]);
  const g = graph();
  expect(channels(g, 'output.fpp_input_bus_fpp_group_surround', 'output')).toEqual(six);
  expect(g.links.filter(([a, b]) => a === 'output.fpp_input_bus_fpp_group_surround' && b === 'fpp_group_surround').length,
    describe(g)).toBe(6);
});

test('one media stream taken by two buses goes through a tee to both', async ({ request }) => {
  // Regression: 8df908f77. fppd's stream plays to one sink, so with
  // fppd_stream_1 in two input groups only the first got it (PipeWireSinkName
  // names one bus).  A null sink now stands in as the stream's target and a
  // loopback from its monitor feeds each bus.
  seedOutputGroups([{ id: 1, name: 'Out' }]);
  const conf = await applyInputGroups(request, [
    { id: 1, name: 'Bus A', enabled: true, channels: 2, outputs: [1], members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] },
    { id: 2, name: 'Bus B', enabled: true, channels: 2, outputs: [1], members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] },
  ]);
  expect(sinkName()).toBe('fpp_tee_fppd_stream_1');
  const tee = conf.slice(conf.lastIndexOf('{ factory = adapter', conf.indexOf('node.name = "fpp_tee_fppd_stream_1"')));
  expect(value(tee, 'factory.name'), conf).toBe('support.null-audio-sink');
  for (const [id, bus] of [[1, 'fpp_input_bus_a'], [2, 'fpp_input_bus_b']]) {
    const at = conf.indexOf(`node.name = "fpp_loopback_ig${id}_fppd_stream_1"`);
    expect(at, `no loopback from the tee into ${bus}:\n${conf}`).toBeGreaterThan(-1);
    const loop = conf.slice(at, conf.indexOf('libpipewire-module-loopback', at) === -1 ? undefined : conf.indexOf('libpipewire-module-loopback', at));
    const capture = loop.slice(loop.indexOf('capture.props'), loop.indexOf('playback.props'));
    const playback = loop.slice(loop.indexOf('playback.props'));
    expect(value(capture, 'node.target')).toBe('"fpp_tee_fppd_stream_1"');
    expect(value(capture, 'stream.capture.sink')).toBe('true');
    expect(value(playback, 'node.target')).toBe(`"${bus}"`);
  }

  // In a real PipeWire: the sink fppd is pointed at exists, and it feeds both buses.
  loadGeneratedConf([standInNode('fpp_group_out')], ['fpp_tee_fppd_stream_1', 'fpp_input_bus_a', 'fpp_input_bus_b']);
  expect(props(graph(), 'fpp_tee_fppd_stream_1')['media.class']).toBe('Audio/Sink');
  await expectReaches([['fpp_tee_fppd_stream_1', 'fpp_input_bus_a'], ['fpp_tee_fppd_stream_1', 'fpp_input_bus_b'],
    ['fpp_input_bus_a', 'fpp_group_out'], ['fpp_input_bus_b', 'fpp_group_out']]);
});

test('the routing matrix saves a level and a mute per path, and Apply honours them', async ({ request }) => {
  // Feature: 15e3d607a. /api/pipewire/audio/routing: which output groups each
  // input group feeds, at what level, muted or not.  A path's level becomes
  // channelmix.volume on the bus's stream to that group; a muted path gets no
  // stream at all.
  seedOutputGroups([{ id: 1, name: 'Front' }, { id: 2, name: 'Back' }]);
  await saveInputGroups(request, [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [],
    members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }]);
  const save = await request.post('/api/pipewire/audio/routing', { data: { routes: [
    { inputGroupId: 1, outputGroupId: 1, connected: true, volume: 60, mute: false },
    { inputGroupId: 1, outputGroupId: 2, connected: true, volume: 100, mute: true },
  ] } });
  expect(save.ok(), await save.text()).toBe(true);
  const got = await request.get('/api/pipewire/audio/routing');
  expect(got.ok(), await got.text()).toBe(true);
  const paths = (await got.json()).matrix[0].paths.map((p: any) => [p.outputGroupId, p.connected, p.volume, p.mute]);
  expect(paths).toEqual([[1, true, 60, false], [2, true, 100, true]]);

  const conf = await applyInputGroups(request);
  expect(value(createStream(conf, 'fpp_group_front'), 'channelmix.volume')).toBe('0.6');
  expect(conf, 'the muted path still has a stream').not.toContain('node.target = "fpp_group_back"');

  loadGeneratedConf([standInNode('fpp_group_front'), standInNode('fpp_group_back')], ['fpp_input_bus']);
  await expectReaches([['fpp_input_bus', 'fpp_group_front']]);
  expect(reaches(graph(), 'fpp_input_bus', 'fpp_group_back'), 'the muted path is linked').toBe(false);
});
