import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, exists, readFile, standInPwDump, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// GET /api/pipewire/graph: the PipeWire graph as pipewire-graph.php draws it.
// The nodes from pw-dump are labelled and tagged from FPP's own config (input
// groups, video groups), WirePlumber's copies of ALSA cards FPP drives itself
// are dropped, and the parts no PipeWire node stands for are added: a
// placeholder for each idle media stream slot, linked to where its audio
// would go, and the video sources and outputs from the video config files.
// The graph itself is a stand-in pw-dump.  (What the page then draws is
// pw-graph.spec.ts.)

test.skip(!container, "writes the run-web.sh container's Pipewire config");

const VIDEO_FILES = ['pipewire-video-groups.json', 'pipewire-video-consumers.json'].map((f) => `${CONFIG}/${f}`);

let restoreSettings: () => void;
let videoFilesBefore: (string | null)[] = [];
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  // The sink an idle first slot is drawn linked to when there are no input groups.
  setSettingInFile('PipeWireSinkName', undefined);
  videoFilesBefore = VIDEO_FILES.map((f) => (exists(f) ? readFile(f) : null));
});
test.afterEach(() => {
  cleanupPipeWire();
  VIDEO_FILES.forEach((f, i) => {
    const before = videoFilesBefore[i];
    if (before === null) inPlayer('rm', '-f', f);
    else writeFile(f, before);
  });
  restoreSettings();
});

type Node = { id: number; name: string; description: string; mediaClass: string; state: string;
  factory?: string; properties: Record<string, unknown> };
type Port = { id: number; nodeId: number; name: string; direction: string; channel: string };
type Link = { id: number; outputNodeId: number; outputPortId: number; inputNodeId: number; inputPortId: number; state: string };
type Graph = { nodes: Node[]; ports: Port[]; links: Link[] };

function node(id: number, name: string, mediaClass: string, extra: Record<string, unknown> = {}, state = 'idle') {
  return { id, type: 'PipeWire:Interface:Node', info: { state, props: { 'node.name': name, 'media.class': mediaClass, ...extra } } };
}
function port(id: number, nodeId: number, name: string, direction: 'input' | 'output') {
  return { id, type: 'PipeWire:Interface:Port', info: { direction, props: { 'node.id': nodeId, 'port.name': name } } };
}
function link(id: number, out: [number, number], inp: [number, number]) {
  return { id, type: 'PipeWire:Interface:Link', info: {
    'output-node-id': out[0], 'output-port-id': out[1], 'input-node-id': inp[0], 'input-port-id': inp[1], state: 'active' } };
}

async function graph(request: import('@playwright/test').APIRequestContext, query = ''): Promise<Graph> {
  return (await request.get(`/api/pipewire/graph${query}`)).json();
}
const named = (g: Graph, name: string) => g.nodes.find((n) => n.name === name)!;

test('nodes are labelled from their names and tagged from the video groups', async ({ request }) => {
  writeFile(`${CONFIG}/pipewire-video-groups.json`, { videoOutputGroups: [{ id: 3, name: 'Main Wall' }] });
  standInPwDump([
    node(1, 'aes67_stage_feed_send', 'Audio/Sink'),
    node(2, 'fppd_video_stream_2', 'Stream/Output/Video', { 'node.description': 'fppd' }),
    node(3, 'fpp_video_group_3_main_wall_m1_hdmi', 'Stream/Input/Video', { 'node.description': 'fppd' }),
    node(4, 'fpp_video_group_9_spare_m2_drm', 'Stream/Input/Video'),
    node(5, 'alsa_output.platform-hdmi.hdmi-stereo', 'Audio/Sink', { 'node.nick': 'vc4-hdmi-0' }),
    node(6, 'alsa_output.usb-x.analog-stereo', 'Audio/Sink',
      { 'node.nick': 'USB Speaker', 'device.profile.description': 'Analog Stereo', 'node.description': 'Built-in' }),
    node(7, 'fpp_midi', 'Midi/Bridge'),
    node(8, 'no_class', ''),
  ]);
  const g = await graph(request);
  const desc = Object.fromEntries(g.nodes.filter((n) => n.factory !== 'virtual').map((n) => [n.name, n.description]));
  expect(desc).toEqual({
    aes67_stage_feed_send: 'AES67: Stage Feed (send)',
    fppd_video_stream_2: 'FPP Video Stream 2',
    fpp_video_group_3_main_wall_m1_hdmi: 'Video Out: Main Wall #1 (HDMI)',
    fpp_video_group_9_spare_m2_drm: 'Video Out: Spare #2 (DRM)',
    'alsa_output.platform-hdmi.hdmi-stereo': 'vc4-hdmi-0',
    'alsa_output.usb-x.analog-stereo': 'USB Speaker (Analog Stereo)',
  });
  expect(named(g, 'fppd_video_stream_2').properties).toMatchObject({ 'fpp.video.stream': true, 'fpp.video.slot': 2 });
  expect(named(g, 'fpp_video_group_3_main_wall_m1_hdmi').properties)
    .toMatchObject({ 'fpp.video.consumer': true, 'fpp.video.groupId': 3, 'fpp.video.groupName': 'Main Wall' });
  expect(named(g, 'fpp_video_group_9_spare_m2_drm').properties).not.toHaveProperty('fpp.video.groupName');

  // ?all=1 keeps the nodes that are not audio or video.
  const all = await graph(request, '?all=1');
  expect(all.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['fpp_midi', 'no_class']));
});

test('WirePlumber\'s own nodes for a card FPP drives are dropped, with their ports and links', async ({ request }) => {
  standInPwDump([
    node(10, 'fpp_alsa_s3', 'Audio/Sink', { 'api.alsa.path': 'hw:S3' }),
    node(11, 'alsa_output.usb-S3.analog-stereo', 'Audio/Sink', { 'api.alsa.path': 'hw:S3,0' }),
    node(12, 'alsa_output.usb-S3.iec958', 'Audio/Sink', { 'api.alsa.path': 'front:4,0', 'object.path': 'alsa:acp:S3:4:playback' }),
    node(13, 'alsa_output.platform-other.analog-stereo', 'Audio/Sink', { 'api.alsa.path': 'hw:Other,0' }),
    node(14, 'fppd_stream_1', 'Stream/Output/Audio', {}, 'running'),
    port(20, 11, 'playback_FL', 'input'), port(21, 13, 'playback_FL', 'input'), port(22, 14, 'output_FL', 'output'),
    link(30, [14, 22], [11, 20]), link(31, [14, 22], [13, 21]),
  ]);
  const g = await graph(request);
  const real = g.nodes.filter((n) => n.factory !== 'virtual').map((n) => n.id);
  expect(real).toEqual([10, 13, 14]);
  expect(g.ports.map((p) => p.id)).toEqual(expect.arrayContaining([21, 22]));
  expect(g.ports.map((p) => p.id)).not.toContain(20);
  expect(g.links.map((l) => l.id)).toEqual([31]);
});

test('an idle stream slot is a placeholder linked to the input groups it feeds, or a fan-out for several', async ({ request }) => {
  writeFile(`${CONFIG}/pipewire-input-groups.json`, { inputGroups: [
    { id: 1, name: 'Show Bus', enabled: true, outputs: [1, 2],
      members: [{ type: 'fppd_stream' }, { type: 'fppd_stream', sourceId: 'fppd_stream_2' }] },
    { id: 2, name: 'Mic Mix', enabled: true, members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_2' }, { type: 'capture', name: 'Mic' }] },
    { id: 3, name: 'Off', enabled: false, members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_3' }] },
    { id: 4, name: 'Empty', enabled: true },
  ] });
  standInPwDump([
    node(1, 'fppd_stream_1', 'Stream/Output/Audio', {}, 'running'),
    node(2, 'fpp_input_show_bus', 'Audio/Sink'),
    node(3, 'fpp_tee_fppd_stream_2', 'Audio/Sink'),
    node(4, 'fpp_route_ig_1', 'Audio/Sink'),
    node(5, 'fpp_fx_ig_1_out', 'Stream/Output/Audio'),
    node(6, 'output.fpp_loopback_ig2_mic', 'Stream/Output/Audio'),
    node(7, 'fpp_input_unknown', 'Audio/Sink'),
    port(40, 3, 'playback_FL', 'input'), port(41, 3, 'monitor_FL', 'output'),
  ]);
  const g = await graph(request);

  expect(named(g, 'fpp_input_show_bus').properties).toMatchObject({
    'fpp.inputGroup': true, 'fpp.inputGroup.id': 1, 'fpp.inputGroup.members': 2, 'fpp.inputGroup.outputs': 2 });
  expect(named(g, 'fpp_input_unknown').properties).not.toHaveProperty('fpp.inputGroup');
  expect(named(g, 'fpp_route_ig_1').properties).toMatchObject({ 'fpp.routingHub': true, 'fpp.inputGroup.id': 1 });
  expect(named(g, 'fpp_fx_ig_1_out').properties).toMatchObject({ 'fpp.inputGroup.eq': true, 'fpp.inputGroup.id': 1 });
  expect(named(g, 'output.fpp_loopback_ig2_mic').properties).toMatchObject({ 'fpp.inputGroup.loopback': true, 'fpp.inputGroup.id': 2 });
  expect(named(g, 'fpp_tee_fppd_stream_2').properties).toMatchObject({ 'fpp.tee': true, 'fpp.tee.slot': 2 });

  // The playing slot is the live node, given its targets.
  const live = named(g, 'fppd_stream_1');
  expect(live).toMatchObject({ id: 1, state: 'running' });
  expect(live.properties).toMatchObject({ 'fpp.stream.slot': 1, 'fpp.stream.target': 'fpp_input_show_bus',
    'fpp.stream.targets': ['fpp_input_show_bus'] });

  // The idle ones are placeholders above every real id, slot 2 linked to the
  // fan-out that splits it between its two groups (its one FL input), and the
  // rest to nothing: a disabled group's member counts for nothing.
  const placeholders = g.nodes.filter((n) => n.factory === 'virtual');
  expect(placeholders.map((n) => n.name)).toEqual(['fppd_stream_2', 'fppd_stream_3', 'fppd_stream_4', 'fppd_stream_5']);
  const slot2 = placeholders[0];
  expect(slot2).toMatchObject({ id: 10041, description: 'FPP Media Stream 2', mediaClass: 'Stream/Output/Audio', state: 'not-running' });
  expect(slot2.properties).toMatchObject({ 'fpp.stream.virtual': true, 'fpp.stream.targets': ['fpp_tee_fppd_stream_2'] });
  const slot2Ports = g.ports.filter((p) => p.nodeId === slot2.id);
  expect(slot2Ports.map((p) => p.channel)).toEqual(['FL', 'FR']);
  expect(g.links).toEqual([{ id: expect.any(Number), outputNodeId: slot2.id, outputPortId: slot2Ports[0].id,
    inputNodeId: 3, inputPortId: 40, state: 'not-running' }]);
  expect(placeholders[1].properties['fpp.stream.targets']).toEqual([]);
});

test('with no input groups, the first idle slot is linked to the configured sink', async ({ request }) => {
  setSettingInFile('PipeWireSinkName', 'fpp_group_main');
  standInPwDump([
    node(5, 'fpp_group_main', 'Audio/Sink'),
    port(6, 5, 'playback_FL', 'input'), port(7, 5, 'playback_FR', 'input'), port(8, 5, 'playback_FL', 'input'),
    port(9, 5, 'monitor_FL', 'output'),
    node(60, 'fpp_capture', 'Audio/Source'), port(61, 60, 'capture_FL', 'output'),
    link(70, [60, 61], [5, 6]),
  ]);
  const g = await graph(request);
  const slot1 = named(g, 'fppd_stream_1');
  expect(slot1).toMatchObject({ id: 10070, factory: 'virtual' });
  expect(slot1.properties['fpp.stream.target']).toBe('fpp_group_main');
  const fromSlot1 = g.links.filter((l) => l.outputNodeId === slot1.id);
  expect(fromSlot1.map((l) => [l.inputNodeId, l.inputPortId])).toEqual([[5, 6], [5, 7]]);
  expect(named(g, 'fppd_stream_2').properties['fpp.stream.targets']).toEqual([]);
});

test('the video sources and outputs in the video config are drawn, lit while their streams play', async ({ request }) => {
  writeFile(`${CONFIG}/pipewire-video-input-sources.json`, { videoInputSources: [
    { id: 1, name: 'Cam', enabled: true, type: 'v4l2src', pipeWireNodeName: 'fpp_vsrc_cam',
      audioPipeWireNodeName: 'fpp_vsrc_cam_audio', width: 1280, height: 720, framerate: 30 },
    { id: 2, name: 'Tube', enabled: true, type: 'urisrc', pipeWireNodeName: 'fpp_vsrc_tube', audioPipeWireNodeName: 'gone' },
    { id: 3, name: 'Bars', enabled: true, type: 'videotestsrc', pipeWireNodeName: 'fpp_vsrc_bars' },
    { id: 4, enabled: true, pipeWireNodeName: 'fpp_vsrc_plain' },
    { id: 5, name: 'Off', enabled: false, pipeWireNodeName: 'fpp_vsrc_off' },
    { id: 6, name: 'Unnamed', enabled: true },
    { id: 7, name: 'Live', enabled: true, pipeWireNodeName: 'fpp_vsrc_live' }, // already a PipeWire node
  ] });
  writeFile(`${CONFIG}/pipewire-video-consumers.json`, [
    { sourceNode: 'fpp_vsrc_cam', pipeWireNodeName: 'fpp_vout_cam', connector: 'HDMI-A-1', width: 1920, height: 1080,
      type: 'hdmi', groupId: 2, groupName: 'Wall' },
    { sourceNode: 'fpp_vsrc_cam' },
    { sourceNode: 'fpp_vsrc_cam', pipeWireNodeName: 'fpp_vout_live' },
    { sourceNode: 'fpp_vsrc_tube', pipeWireNodeName: 'fpp_vout_tube' },
    // Fed from the media stream slots instead.
    { pipeWireNodeName: 'fpp_vout_slots', connector: 'HDMI-A-2', width: 1280, height: 720, streamSlots: [1, 3, 4] },
    { pipeWireNodeName: 'fpp_vout_any', width: 640 },
    { pipeWireNodeName: 'fpp_vout_live' },
    {},
  ]);
  standInPwDump([
    node(1, 'fpp_vsrc_cam_audio', 'Stream/Output/Audio', {}, 'running'),
    node(2, 'fpp_vsrc_live', 'Video/Source'),
    node(3, 'fpp_vout_live', 'Video/Sink'),
    // Video streams stay suspended in PipeWire: their audio twin says whether they play.
    node(4, 'fppd_video_stream_1', 'Stream/Output/Video', {}, 'suspended'), port(5, 4, 'output_video', 'output'),
    node(6, 'fppd_stream_1', 'Stream/Output/Audio', {}, 'idle'),
    node(7, 'fppd_video_stream_2', 'Stream/Output/Video', {}, 'suspended'), port(8, 7, 'output_video', 'output'),
    node(9, 'fppd_video_stream_3', 'Stream/Output/Video', {}, 'running'), // no port to link from
  ]);
  const g = await graph(request);
  const v = (name: string) => named(g, name);

  expect(g.nodes.filter((n) => n.name.startsWith('fpp_vsrc_') && n.factory === 'virtual').map((n) => [n.name, n.description]))
    .toEqual([['fpp_vsrc_cam', 'Cam (USB Camera)'], ['fpp_vsrc_tube', 'Tube (YouTube)'],
      ['fpp_vsrc_bars', 'Bars (Test Pattern)'], ['fpp_vsrc_plain', 'Video Source']]);
  expect(v('fpp_vsrc_cam')).toMatchObject({ mediaClass: 'Video/Source', state: 'running' });
  expect(v('fpp_vsrc_cam').properties).toMatchObject({ 'fpp.video.slot': 1, 'fpp.video.virtual': true, 'video.format': '1280x720@30fps' });
  expect(v('fpp_vsrc_tube')).toMatchObject({ state: 'not-running', properties: expect.objectContaining({ 'video.format': '' }) });
  expect(g.nodes.filter((n) => n.name === 'fpp_vsrc_live' || n.name === 'fpp_vout_live')).toHaveLength(2);

  expect(v('fpp_vout_cam')).toMatchObject({ description: 'HDMI-A-1 (1920x1080)', mediaClass: 'Video/Sink', state: 'running' });
  expect(v('fpp_vout_cam').properties).toEqual({ 'fpp.video.consumer': true, 'fpp.hdmi.direct': true,
    'fpp.hdmi.connector': 'HDMI-A-1', 'fpp.video.groupId': 2, 'fpp.video.groupName': 'Wall' });
  expect(v('fpp_vout_tube')).toMatchObject({ description: 'Video Output', state: 'not-running' });
  expect(v('fpp_vout_slots')).toMatchObject({ description: 'HDMI-A-2 (1280x720)', state: 'running' });
  // No slots of its own: linked to every video stream, and lit by none.
  expect(v('fpp_vout_any')).toMatchObject({ description: 'Video Output', state: 'not-running' });

  const into = (name: string) => g.links.filter((l) => l.inputNodeId === v(name).id).map((l) => [l.outputNodeId, l.state]);
  expect(into('fpp_vout_cam')).toEqual([[v('fpp_vsrc_cam').id, 'active']]);
  expect(into('fpp_vout_tube')).toEqual([[v('fpp_vsrc_tube').id, 'not-running']]);
  // Slot 3's stream has no port to link from, and slot 4 has no stream.
  expect(into('fpp_vout_slots')).toEqual([[4, 'active']]);
  expect(into('fpp_vout_any')).toEqual([[4, 'active'], [7, 'not-running']]);
});

test('with no PipeWire, or a dump that is not JSON, the graph is empty', async ({ request }) => {
  standInPwDump([]);
  writeFile('/usr/local/bin/pw-dump', '#!/bin/sh\n');
  expect(await graph(request)).toEqual({ nodes: [], ports: [], links: [] });
  standInPwDump([]);
  writeFile('/tmp/fpp-tests-pw-dump.json', 'not json');
  expect(await graph(request)).toEqual({ nodes: [], ports: [], links: [] });
});
