import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, commandLog, exists, readFile, standInAt, standInCommand, standInPwDump, writeFile } from './pw-helpers';
import { snapshotSettings } from './settings-file';

// POST /api/pipewire/audio/routing/presets/live-apply: a routing preset put
// onto the running graph.  When it keeps every input group's outputs and EQ
// band count, its routing levels and EQ bands are set on the running nodes
// (with pw-cli, a stand-in here, against a stand-in pw-dump) and saved;
// otherwise it is saved and the input groups are applied in full.  The live
// end to end, through the fppd command and a real PipeWire, is
// pw-routing-preset-command.spec.ts.

test.skip(!container, "writes the run-web.sh container's Pipewire config");

// The full apply restarts fppd and waits for it to come back.
test.describe.configure({ timeout: 240_000 });

const PRESETS = `${CONFIG}/routing-presets`;
const INPUT_GROUPS = `${CONFIG}/pipewire-input-groups.json`;
const OUTPUT_GROUPS = `${CONFIG}/pipewire-audio-groups.json`;
const VIDEO_GROUPS = `${CONFIG}/pipewire-video-groups.json`;
const VIDEO_CONSUMERS = `${CONFIG}/pipewire-video-consumers.json`;

let restoreSettings: () => void;
let videoBefore: (string | null)[] = [];
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  videoBefore = [VIDEO_GROUPS, VIDEO_CONSUMERS].map((f) => (exists(f) ? readFile(f) : null));
});
test.afterEach(() => {
  inPlayer('rm', '-rf', PRESETS);
  [VIDEO_GROUPS, VIDEO_CONSUMERS].forEach((f, i) => {
    const b = videoBefore[i];
    if (b === null) inPlayer('rm', '-f', f);
    else writeFile(f, b);
  });
  cleanupPipeWire();
  restoreSettings();
});

const eq = (bands: unknown[]) => ({ eq: { enabled: true, bands } });
const liveApply = (name: unknown) =>
  ({ data: name === undefined ? {} : { name } });

function setUp(preset: Record<string, unknown>) {
  writeFile(OUTPUT_GROUPS, { groups: [
    { id: 1, name: 'Out', channels: 2, enabled: true, members: [] },
    { id: 2, name: 'Side', channels: 2, enabled: true, members: [] },
  ] });
  writeFile(INPUT_GROUPS, { inputGroups: [
    { id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1, 2], routing: {},
      effects: eq([{ type: 'peaking', freq: 100, gain: 0, q: 1 }, { type: 'peaking', freq: 5000, gain: 0, q: 1 }]) },
    { id: 2, name: 'Mic', enabled: true, channels: 1, outputs: [2], routing: { 2: { volume: 10, mute: true } } },
  ] });
  writeFile(VIDEO_GROUPS, { videoOutputGroups: [
    { id: 1, name: 'Wall', enabled: true, videoSource: 'fpp_video_src_1_a', members: [] },
    { id: 2, name: 'Side', enabled: true, videoSource: 'fpp_video_src_2_b', members: [] },
  ] });
  writeFile(`${PRESETS}/${preset.name}.json`, preset);
}

function routeNode(id: number, name: string, target: Record<string, string>, channels = 2) {
  return { id, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': name, ...target },
    params: { Props: [{ volume: 1 }, { channelVolumes: Array(channels).fill(1) }] } } };
}

test('a preset that keeps the topology sets its levels and EQ on the running nodes, and saves them', async ({ request }) => {
  const busEq = eq([{ type: 'peaking', freq: 2000, gain: -6, q: 0.5 }, { type: 'highshelf' }]);
  setUp({ name: 'Live', routing: [
    // The same outputs in another order are the same topology.
    { inputGroupId: 1, outputs: [2, 1], routing: { 1: { volume: 40 }, 2: { volume: 80, mute: true } }, effects: busEq },
    { inputGroupId: 2, outputs: [2] }, // no routing saved: full level
    { inputGroupId: 9, outputs: [1] }, // no such group
  ], videoRouting: [
    { groupId: 1, videoSource: 'fpp_video_src_3_c' },
    { groupId: 2, videoSource: 'fpp_video_src_2_b' }, // unchanged
    { groupId: 5, videoSource: 'x' },                 // no such group
  ] });
  standInPwDump([
    { id: 69, type: 'PipeWire:Interface:Link', info: {} },
    { id: 70, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'fpp_fx_ig_1' } } },
    routeNode(71, 'output.fpp_route_ig_1_fpp_group_out', { 'node.target': 'fpp_group_out' }, 4),
    routeNode(72, 'fpp_route_ig_1.1', { 'target.object': 'fpp_group_side' }),
    routeNode(73, 'output.fpp_input_mic_fpp_group_side', { 'node.target': 'fpp_group_side' }),
    routeNode(74, 'output.fpp_input_mic_fpp_group_out', { 'node.target': 'fpp_group_out' }), // not one of its outputs
  ]);
  // The Mic's node refuses the level, so it is not counted.
  standInCommand('pw-cli', 'case "$*" in *"set-param 73 "*) echo "Error: failed" ;; esac\n');

  const r = await (await request.post('/api/pipewire/audio/routing/presets/live-apply', liveApply('Live'))).json();
  expect(r).toEqual({
    status: 'OK', preset: 'Live', applied: 2, volumeChanges: 2, eqChanges: 2, liveApplied: true, restarted: false,
    message: "Preset 'Live' live-applied (2 groups, 2 volume changes, 2 EQ updates, 1 video source change(s) applied)",
  });

  const eqCalls = (band: number, f: number, g: number, q: number) => ['l', 'r'].flatMap((ch) => [
    `set-param 70 Props { "eq_${ch}_${band}:Freq": ${f} }`,
    `set-param 70 Props { "eq_${ch}_${band}:Gain": ${g} }`,
    `set-param 70 Props { "eq_${ch}_${band}:Q": ${q} }`,
  ]);
  expect(commandLog('pw-cli')).toEqual([
    'set-param 72 Props { channelVolumes: [ 0, 0 ] }',            // Side, muted
    'set-param 71 Props { channelVolumes: [ 0.4, 0.4, 0.4, 0.4 ] }', // Out, on all four channels
    ...eqCalls(0, 2000, -6, 0.5),
    ...eqCalls(1, 1000, 0, 1),                                    // a band with nothing set
    'set-param 73 Props { channelVolumes: [ 1, 1 ] }',
  ]);

  const [bus, mic] = JSON.parse(readFile(INPUT_GROUPS)).inputGroups;
  expect(bus).toMatchObject({ outputs: [2, 1], routing: { 1: { volume: 40 }, 2: { volume: 80, mute: true } }, effects: busEq });
  expect(mic).toMatchObject({ outputs: [2], routing: [] });
  expect(JSON.parse(readFile(VIDEO_GROUPS)).videoOutputGroups.map((g: { videoSource: string }) => g.videoSource))
    .toEqual(['fpp_video_src_3_c', 'fpp_video_src_2_b']);
});

test('a preset with nothing to change live still saves, and touches no video', async ({ request }) => {
  setUp({ name: 'Same', routing: [{ inputGroupId: 2, outputs: [2], routing: { 2: { volume: 50 } } }],
    videoRouting: [{ groupId: 1, videoSource: 'fpp_video_src_1_a' }] });
  const videoBefore = readFile(VIDEO_GROUPS);
  standInCommand('pw-cli', '');
  standInPwDump([]);
  writeFile('/usr/local/bin/pw-dump', '#!/bin/sh\n'); // no PipeWire running: nothing to set

  const r = await (await request.post('/api/pipewire/audio/routing/presets/live-apply', liveApply('Same'))).json();
  expect(r).toMatchObject({ status: 'OK', applied: 1, volumeChanges: 0, eqChanges: 0,
    message: "Preset 'Same' live-applied (1 groups, 0 volume changes, 0 EQ updates)" });
  expect(commandLog('pw-cli')).toEqual([]);
  expect(JSON.parse(readFile(INPUT_GROUPS)).inputGroups[1].routing).toEqual({ 2: { volume: 50 } });
  expect(readFile(VIDEO_GROUPS)).toBe(videoBefore);
});

test('a preset that is missing, or has nothing to apply to, is refused', async ({ request }) => {
  const post = (data: unknown) => request.post('/api/pipewire/audio/routing/presets/live-apply', { data });

  expect((await post({})).status()).toBe(400);
  const missing = await post({ name: '../Gone' });
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toMatchObject({ message: "Preset 'Gone' not found" });

  writeFile(`${PRESETS}/Bare.json`, { name: 'Bare' });
  inPlayer('rm', '-f', INPUT_GROUPS);
  expect(await (await post({ name: 'Bare' })).json()).toMatchObject({ status: 'error', message: 'No input groups configured' });
  writeFile(INPUT_GROUPS, { inputGroups: [] });
  expect(await (await post({ name: 'Bare' })).json())
    .toMatchObject({ status: 'error', message: 'Invalid preset or config data' });
});

test('a preset that changes outputs or EQ bands is saved and the input groups applied in full', async ({ request }) => {
  setUp({ name: 'Rewire', routing: [
    // One band fewer on the bus, and the Mic given EQ and sent somewhere else.
    { inputGroupId: 1, outputs: [1, 2], routing: { 1: { volume: 70 } }, effects: eq([{ type: 'peaking', freq: 300, gain: 2, q: 1 }]) },
    { inputGroupId: 2, outputs: [1], effects: eq([{ type: 'lowshelf', freq: 80, gain: -3, q: 0.7 }]) },
  ], videoRouting: [{ groupId: 2, videoSource: 'fpp_video_src_9_z' }, { groupId: 1 }] });
  // The PipeWire services are not restarted for real.
  standInAt('/usr/bin/systemctl', 'exit 0\n');

  const r = await request.post('/api/pipewire/audio/routing/presets/live-apply', { ...liveApply('Rewire'), timeout: 180_000 });
  expect(r.ok(), await r.text()).toBe(true);
  expect(await r.json()).not.toHaveProperty('liveApplied');

  const [bus, mic] = JSON.parse(readFile(INPUT_GROUPS)).inputGroups;
  expect(bus).toMatchObject({ outputs: [1, 2], routing: { 1: { volume: 70 } } });
  expect(bus.effects.eq.bands).toHaveLength(1);
  expect(mic).toMatchObject({ outputs: [1], routing: [] });
  expect(mic.effects.eq.bands).toHaveLength(1);
  expect(JSON.parse(readFile(VIDEO_GROUPS)).videoOutputGroups.map((g: { videoSource: string }) => g.videoSource))
    .toEqual(['', 'fpp_video_src_9_z']);
  // Applied in full: the input groups' PipeWire config is written.
  expect(commandLog('systemctl').some((l) => /restart fpp-pipewire/.test(l)), commandLog('systemctl').join('\n')).toBe(true);
});
