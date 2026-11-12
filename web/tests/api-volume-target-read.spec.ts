import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { usesPipewireConfig } from './pw-config-files';

// GET /api/system/volume?target=: the level of one PipeWire node instead of
// the master (SystemGetTargetVolume).  It is read from the saved PipeWire
// config, not the live graph, so it answers for a node that is not running;
// and Volume Adjust (POST with "adjust") works from the same reading.
// api-stream-slot-volumes.spec.ts covers the setters behind POST's "volume".

test.skip(!container, 'writes PipeWire config files in the player (FPP_TESTS_WEB_CONTAINER)');

const put = usesPipewireConfig('pipewire-stream-slots.json', 'pipewire-audio-groups.json', 'pipewire-input-groups.json');

const read = (request: APIRequestContext, target: string) => request.get('/api/system/volume', { params: { target } });
async function level(request: APIRequestContext, target: string) {
  const r = await read(request, target);
  expect(r.status(), `${target}: ${await r.text()}`).toBe(200);
  const body = await r.json();
  expect(body).toMatchObject({ status: 'OK', method: 'Target', target });
  return body.volume;
}
async function unknown(request: APIRequestContext, target: string) {
  const r = await read(request, target);
  expect(r.status(), `${target}: ${await r.text()}`).toBe(404);
  expect(await r.json()).toEqual({ status: 'ERROR', message: 'Unknown volume target; see GET /api/pipewire/audio/targets' });
}

const GROUPS = {
  groups: [
    { id: 3, name: 'Front Yard!', volume: 55, members: [
      { cardId: 'USB-Audio.1', volume: 40 },
      { cardId: 'hdmi', nodeTarget: 'alsa_output.hdmi.stereo' },
    ] },
    // No volume and no members: the group's own node is all there is.
    { id: 4, name: 'Porch' },
    // No name: it is "Group".
    { id: 5, volume: 12 },
  ],
};
const INPUTS = {
  inputGroups: [
    { id: 1, name: 'Mics', members: [{ volume: 30 }, {}], routing: { 3: { volume: 65 }, 4: {} } },
    { id: 2, name: 'Bare' },
  ],
};

test("a stream slot's level is its saved fader, and 100 for a slot never set", async ({ request }) => {
  put('pipewire-stream-slots.json', { slots: { 1: 80, 2: 35 } });
  expect(await level(request, 'slot:1')).toBe(80);
  expect(await level(request, 'slot:2')).toBe(35);
  expect(await level(request, 'slot:4')).toBe(100);
});

test('a sink is found as a group, as a member by its filter node, or as a member by its own node name', async ({ request }) => {
  put('pipewire-audio-groups.json', GROUPS);
  // The group's node: its name lower-cased, anything else an underscore.
  expect(await level(request, 'sink:fpp_group_front_yard_')).toBe(55);
  expect(await level(request, 'sink:fpp_group_porch')).toBe(100);
  expect(await level(request, 'sink:fpp_group_group')).toBe(12);
  // A member's filter node is named for the group's id and the card.
  expect(await level(request, 'sink:fpp_fx_g3_usb_audio_1')).toBe(40);
  // A member with no saved level is at 100, here found by its node target.
  expect(await level(request, 'sink:alsa_output.hdmi.stereo')).toBe(100);
  expect(await level(request, 'sink:fpp_fx_g3_hdmi')).toBe(100);

  await unknown(request, 'sink:fpp_group_garage');
  await unknown(request, 'sink:fpp_fx_g4_usb_audio_1');
});

test('an input group member and a routing path are read from the input groups', async ({ request }) => {
  put('pipewire-input-groups.json', INPUTS);
  expect(await level(request, 'input:1:0')).toBe(30);
  expect(await level(request, 'input:1:1')).toBe(100);
  await unknown(request, 'input:1:2');
  // A path with no saved level, or not saved at all, is at 100.
  expect(await level(request, 'route:1:3')).toBe(65);
  expect(await level(request, 'route:1:4')).toBe(100);
  expect(await level(request, 'route:2:9')).toBe(100);
  // No such input group.
  await unknown(request, 'input:7:0');
  await unknown(request, 'route:7:3');
});

test('a target that names nothing readable is a 404', async ({ request }) => {
  put('pipewire-audio-groups.json', GROUPS);
  put('pipewire-input-groups.json', INPUTS);
  // Too few parts, and a type there is no such thing as.
  for (const target of ['sink', 'input:1', 'route:1', 'card:0', 'nonsense']) await unknown(request, target);
});

test('with no config, or one that is not what it should be, sinks and inputs are unknown', async ({ request }) => {
  // The files' absence is this player's normal state; usesPipewireConfig
  // puts back whatever was there.
  inPlayer('rm', '-f', '/home/fpp/media/config/pipewire-audio-groups.json', '/home/fpp/media/config/pipewire-input-groups.json');
  await unknown(request, 'sink:fpp_group_porch');
  await unknown(request, 'input:1:0');
  await unknown(request, 'route:1:3');
  put('pipewire-audio-groups.json', ['not', 'groups']);
  put('pipewire-input-groups.json', { groups: [] });
  await unknown(request, 'sink:fpp_group_porch');
  await unknown(request, 'input:1:0');
});

test('Volume Adjust on a target that cannot be read is refused, not applied from zero', async ({ request }) => {
  put('pipewire-audio-groups.json', GROUPS);
  const r = await request.post('/api/system/volume', { data: { target: 'sink:fpp_group_garage', adjust: 10 } });
  expect(r.status()).toBe(400);
  expect(await r.json()).toEqual({ status: 'ERROR', message: 'Could not read current volume for target' });
  // The object form of a target reads the same way.
  const o = await request.post('/api/system/volume', { data: { target: { type: 'input', id: 9, id2: 0 }, adjust: -5 } });
  expect(o.status()).toBe(400);
  expect((await o.json()).message).toBe('Could not read current volume for target');
});
