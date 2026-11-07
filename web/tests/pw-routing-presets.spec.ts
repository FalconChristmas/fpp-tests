import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, exists, readFile, standInPwDump, writeFile } from './pw-helpers';

// The Pipewire routing presets API: POST /api/pipewire/audio/routing/presets
// saves the input groups' routing (and the enabled video groups' sources) as a
// named preset, GET lists them, POST .../presets/load puts one back into the
// saved config for the next Apply, and DELETE removes one.  Also POST
// /api/pipewire/audio/routing/volume, the routing fader, as far as the saved
// config and its answers go: the container runs no PipeWire, so its graph is a
// stand-in pw-dump.  The live preset apply is pw-routing-preset-command.spec.ts.

test.skip(!container, "writes the run-web.sh container's Pipewire config");

const PRESETS = `${CONFIG}/routing-presets`;
const INPUT_GROUPS = `${CONFIG}/pipewire-input-groups.json`;
const OUTPUT_GROUPS = `${CONFIG}/pipewire-audio-groups.json`;
const VIDEO_GROUPS = `${CONFIG}/pipewire-video-groups.json`;

let videoGroupsBefore: string | null = null;

test.beforeEach(() => {
  videoGroupsBefore = exists(VIDEO_GROUPS) ? readFile(VIDEO_GROUPS) : null;
});

test.afterEach(() => {
  inPlayer('rm', '-rf', PRESETS);
  if (videoGroupsBefore === null) inPlayer('rm', '-f', VIDEO_GROUPS);
  else writeFile(VIDEO_GROUPS, videoGroupsBefore);
  cleanupPipeWire();
});

const bus = (routing: Record<string, unknown>, outputs = [1, 2]) => ({
  id: 1, name: 'Bus', enabled: true, channels: 2, outputs, routing,
  effects: { eq: { enabled: true, bands: [{ type: 'peaking', freq: 1000, gain: -3, q: 1 }] } },
});
const mic = { id: 2, name: 'Mic', enabled: true, channels: 1, outputs: [2], routing: { 2: { volume: 80, mute: false } } };

function inputGroups() {
  return JSON.parse(readFile(INPUT_GROUPS)).inputGroups;
}

test('a preset keeps each input group\'s routing and effects, and the enabled video groups\' sources', async ({ request }) => {
  writeFile(INPUT_GROUPS, { inputGroups: [bus({ 1: { volume: 30, mute: false }, 2: { volume: 100, mute: true } }), mic] });
  writeFile(VIDEO_GROUPS, { videoOutputGroups: [
    { id: 1, name: 'Wall', enabled: true, videoSource: 'fppd_video_1' },
    { id: 2, name: 'Spare', enabled: false, videoSource: 'fppd_video_2' },
  ] });

  // The name is cut down to letters, digits, space, _ and -.
  const save = await request.post('/api/pipewire/audio/routing/presets',
    { data: { name: ' Show/Night: 1 ', description: 'quiet bus' } });
  expect(await save.json()).toMatchObject({ status: 'OK', name: 'ShowNight 1' });

  const preset = JSON.parse(readFile(`${PRESETS}/ShowNight 1.json`));
  expect(preset).toMatchObject({ name: 'ShowNight 1', description: 'quiet bus' });
  expect(preset.routing).toEqual([
    { inputGroupId: 1, inputGroupName: 'Bus', outputs: [1, 2],
      routing: { 1: { volume: 30, mute: false }, 2: { volume: 100, mute: true } }, effects: bus({}).effects },
    { inputGroupId: 2, inputGroupName: 'Mic', outputs: [2], routing: mic.routing, effects: [] },
  ]);
  expect(preset.videoRouting).toEqual([{ groupId: 1, groupName: 'Wall', videoSource: 'fppd_video_1' }]);

  const list = await (await request.get('/api/pipewire/audio/routing/presets')).json();
  expect(list.presets).toEqual([expect.objectContaining({ name: 'ShowNight 1', description: 'quiet bus' })]);
});

test('loading a preset puts its routing back on the groups it names and leaves the rest', async ({ request }) => {
  writeFile(INPUT_GROUPS, { inputGroups: [bus({ 1: { volume: 30, mute: false } }), mic] });
  writeFile(VIDEO_GROUPS, { videoOutputGroups: [{ id: 1, name: 'Wall', enabled: true, videoSource: 'fppd_video_1' }] });
  expect((await request.post('/api/pipewire/audio/routing/presets', { data: { name: 'Night' } })).ok()).toBe(true);

  // Change everything the preset holds, and the Mic, which it holds too but
  // the edited preset below no longer names.
  writeFile(INPUT_GROUPS, { inputGroups: [
    { ...bus({ 1: { volume: 90, mute: true } }, [2]), effects: {} },
    { ...mic, routing: { 2: { volume: 10, mute: true } } },
  ] });
  writeFile(VIDEO_GROUPS, { videoOutputGroups: [{ id: 1, name: 'Wall', enabled: true, videoSource: 'none' }] });
  const preset = JSON.parse(readFile(`${PRESETS}/Night.json`));
  preset.routing = preset.routing.filter((r: { inputGroupId: number }) => r.inputGroupId === 1);
  preset.routing.push({ inputGroupId: 9, outputs: [1], routing: {} }); // no such group
  writeFile(`${PRESETS}/Night.json`, preset);

  const load = await (await request.post('/api/pipewire/audio/routing/presets/load', { data: { name: 'Night' } })).json();
  expect(load).toMatchObject({ status: 'OK', applied: 1, videoApplied: 1, needsApply: true });

  const [b, m] = inputGroups();
  expect(b).toMatchObject({ outputs: [1, 2], routing: { 1: { volume: 30, mute: false } }, effects: bus({}).effects });
  expect(m.routing).toEqual({ 2: { volume: 10, mute: true } });
  expect(JSON.parse(readFile(VIDEO_GROUPS)).videoOutputGroups[0].videoSource).toBe('fppd_video_1');
});

test('a preset with no name, or none left once cleaned, is refused, and an unknown one is not found', async ({ request }) => {
  writeFile(INPUT_GROUPS, { inputGroups: [mic] });
  for (const data of [{}, { name: '  ' }, { name: '/:*' }]) {
    const r = await request.post('/api/pipewire/audio/routing/presets', { data });
    expect(r.status(), JSON.stringify(data)).toBe(400);
  }
  expect(exists(PRESETS) && inPlayer('ls', '-A', PRESETS).trim() !== '').toBe(false);

  const load = await request.post('/api/pipewire/audio/routing/presets/load', { data: { name: 'Nope' } });
  expect(load.status()).toBe(404);
  const del = await request.delete('/api/pipewire/audio/routing/presets/Nope');
  expect(del.status()).toBe(404);
});

test('deleting a preset removes it from the list', async ({ request }) => {
  writeFile(INPUT_GROUPS, { inputGroups: [mic] });
  for (const name of ['Keep', 'Gone']) {
    expect((await request.post('/api/pipewire/audio/routing/presets', { data: { name } })).ok()).toBe(true);
  }
  const del = await request.delete('/api/pipewire/audio/routing/presets/Gone');
  expect(await del.json()).toMatchObject({ status: 'OK' });
  const names: string[] = await (await request.get('/api/pipewire/audio/routing/presets/names')).json();
  expect(names).toEqual(['Keep']);
});

test('a routing fader move is saved for the next apply, clamped, and a mute keeps the level', async ({ request }) => {
  writeFile(INPUT_GROUPS, { inputGroups: [bus({ 1: { volume: 30, mute: false } }, [1])] });
  writeFile(OUTPUT_GROUPS, { groups: [{ id: 1, name: 'Out', channels: 2, enabled: true, members: [] }] });
  // A graph with no routing stream for this path: nothing to move live.
  standInPwDump([{ id: 40, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'fpp_group_out' } } }]);
  const vol = (data: Record<string, unknown>) => request.post('/api/pipewire/audio/routing/volume', { data });

  expect(await (await vol({ inputGroupId: 1, outputGroupId: 1, volume: 140 })).json())
    .toMatchObject({ status: 'warning', volume: 100 });
  expect(inputGroups()[0].routing['1']).toEqual({ volume: 100, mute: false });

  await vol({ inputGroupId: 1, outputGroupId: 1, volume: 55 });
  await vol({ inputGroupId: 1, outputGroupId: 1, volume: 0, mute: true });
  expect(inputGroups()[0].routing['1']).toEqual({ volume: 55, mute: true });
});

test('a routing fader move that names nothing it can find is an error and saves nothing', async ({ request }) => {
  writeFile(INPUT_GROUPS, { inputGroups: [bus({ 1: { volume: 30, mute: false } }, [1])] });
  inPlayer('rm', '-f', OUTPUT_GROUPS);
  const vol = async (data: Record<string, unknown>) =>
    (await request.post('/api/pipewire/audio/routing/volume', { data })).json();

  expect(await vol({ inputGroupId: 1, volume: 50 })).toMatchObject({ status: 'error', message: expect.stringMatching(/Missing/) });
  expect(await vol({ inputGroupId: 1, outputGroupId: 1, volume: 50 }))
    .toMatchObject({ status: 'error', message: 'Config files not found' });

  writeFile(OUTPUT_GROUPS, { groups: [{ id: 1, name: 'Out', channels: 2, enabled: true, members: [] }] });
  expect(await vol({ inputGroupId: 1, outputGroupId: 7, volume: 50 }))
    .toMatchObject({ status: 'error', message: 'Output group not found' });
  standInPwDump([]);
  writeFile('/usr/local/bin/pw-dump', '#!/bin/sh\n'); // prints nothing, as with no PipeWire running
  expect(await vol({ inputGroupId: 1, outputGroupId: 1, volume: 50 }))
    .toMatchObject({ status: 'error', message: 'Cannot connect to PipeWire' });
  expect(inputGroups()[0].routing['1'].volume).toBe(30);
});
