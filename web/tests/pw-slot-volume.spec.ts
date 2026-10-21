import { test, expect } from './fixtures';
import { container } from './container';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';

// The per-slot volume API the PipeWire mixer drives: /api/pipewire/audio/
// stream/volume, and the target-aware /api/system/volume in front of it.
// Nothing is playing in the container, so every slot is idle: fppd's Set Slot
// Volume answers "Slot N not active" with HTTP 500, which is what shows the
// command really reached it.

test.skip(!container, 'reads the saved slot volumes inside the run-web.sh container');

test.afterEach(cleanupPipeWire);

async function master(request: any): Promise<number> {
  const r = await request.get('/api/system/volume');
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).volume;
}

function savedSlots(): Record<string, number> {
  const text = readFile(`${CONFIG}/pipewire-stream-slots.json`);
  return text ? JSON.parse(text).slots : {};
}

test('slot 1 is a fader of its own, sent to fppd as Set Slot Volume', async ({ request }) => {
  // Regression: d8869e1d2. The slot volume was posted to fppd's own server at
  // /api/command, a 404 there (the /api prefix is Apache's), and the API
  // answered OK whatever happened: slot 1 could never be set.
  // Regression: ecbaa46e7. Slot 1 was sent as the global "Volume Set", so
  // moving slot 1 moved the master with it.
  const set = await request.post('/api/system/volume', { data: { volume: 61 } });
  expect(set.ok(), await set.text()).toBe(true);
  expect(await master(request)).toBe(61);

  const r = await request.post('/api/pipewire/audio/stream/volume', { data: { slot: 1, volume: 33 } });
  expect(r.ok(), await r.text()).toBe(true);
  const body = await r.json();
  // fppd was asked, and refused: the idle slot has no stream.  A 404 here would
  // mean the command went to a path fppd does not serve.
  expect(body.status, JSON.stringify(body)).toBe('error');
  expect(body.message).toContain('HTTP 500');
  expect(savedSlots()['1']).toBe(33);
  expect(await master(request), 'setting slot 1 moved the master volume').toBe(61);

  // Read back through the target-aware GET: slot 1's own saved level, not the master.
  const got = await request.get('/api/system/volume?target=slot:1');
  expect(got.ok(), await got.text()).toBe(true);
  expect((await got.json()).volume).toBe(33);
});

test('a volume target addresses one slot and leaves the master alone', async ({ request }) => {
  // Feature: 1cf21f45d. /api/system/volume takes an optional "target"
  // (slot:N, sink:<node>, input:<group>:<member>, route:<in>:<out>); without
  // one it is the master, as before.
  await request.post('/api/system/volume', { data: { volume: 58 } });
  writeFile(`${CONFIG}/pipewire-stream-slots.json`, { slots: { '2': 40 } });

  const r = await request.post('/api/system/volume', { data: { target: 'slot:2', volume: 44 } });
  expect(r.ok(), await r.text()).toBe(true);
  expect(savedSlots()['2']).toBe(44);
  expect(await master(request)).toBe(58);

  // "adjust" is a step from the target's own level.
  const adj = await request.post('/api/system/volume', { data: { target: 'slot:2', adjust: -4 } });
  expect(adj.ok(), await adj.text()).toBe(true);
  expect(savedSlots()['2']).toBe(40);
  expect(await master(request)).toBe(58);

  const bad = await request.post('/api/system/volume', { data: { target: 'nothing:1', volume: 10 } });
  expect(bad.status()).toBe(400);
  expect(await master(request)).toBe(58);
});

test('a mix bus volume and mute are saved with the input group', async ({ request }) => {
  // Feature: da73dbec6. The input group (mix bus) level has its own endpoint,
  // and it persists into pipewire-input-groups.json so fppinit can restore it
  // when the combine sink is rebuilt.  (pactl has no PipeWire to reach in the
  // container, so the live half reports an error; the saved half is checked.)
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 3, name: 'Bus', enabled: true, channels: 2, outputs: [], members: [] }],
  });
  const vol = await request.post('/api/pipewire/audio/input-group/volume', { data: { groupId: 3, volume: 40 } });
  expect(vol.ok(), await vol.text()).toBe(true);
  expect((await vol.json()).nodeName).toBe('fpp_input_bus');
  let ig = JSON.parse(readFile(`${CONFIG}/pipewire-input-groups.json`)).inputGroups[0];
  expect(ig.volume).toBe(40);
  expect(ig.mute).toBe(false);

  const mute = await request.post('/api/pipewire/audio/input-group/volume', { data: { groupId: 3, volume: 40, mute: true } });
  expect(mute.ok(), await mute.text()).toBe(true);
  ig = JSON.parse(readFile(`${CONFIG}/pipewire-input-groups.json`)).inputGroups[0];
  expect(ig.mute).toBe(true);
  expect(ig.volume, 'a mute changed the saved level').toBe(40);
});
