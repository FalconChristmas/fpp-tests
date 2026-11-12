import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { settingInFile, setSettingInFile } from './settings-file';
import { listen, loopback, nodeProps, nullSink, sinkMuted, sinkVolume, startPipeWire, stopPipeWire } from './pw-live';

// The setters of /api/pipewire/control that pw-live-volume.spec.ts leaves:
// an output group's mute, a member card's volume, an input group member's
// volume and mute, and a routing path's.  Each saves what it sets and applies
// it to the running graph when there is one; the output group ones are
// checked against a real PipeWire in the player (pw-live.ts), the rest
// against the saved config, with no PipeWire running.

test.skip(!container, 'runs a PipeWire inside the run-web.sh container');

const OUTPUT = `${CONFIG}/pipewire-audio-groups.json`, INPUT = `${CONFIG}/pipewire-input-groups.json`;
const groups = () => JSON.parse(readFile(OUTPUT)).groups;
const inputGroups = () => JSON.parse(readFile(INPUT)).inputGroups;
const C = '/api/pipewire/control';

const keys = ['MediaBackend', 'AudioBackend'];
let saved: (string | undefined)[] = [];
test.beforeEach(() => {
  saved = keys.map(settingInFile);
  for (const k of keys) setSettingInFile(k, 'pipewire');
});
test.afterEach(() => {
  keys.forEach((k, i) => setSettingInFile(k, saved[i]));
  stopPipeWire();
  cleanupPipeWire();
});

async function post(request: APIRequestContext, path: string, data: unknown, status = 200) {
  const r = await request.post(`${C}/${path}`, { data });
  expect(r.status(), `${path} ${JSON.stringify(data)}: ${await r.text()}`).toBe(status);
  return r.json();
}
const refused = async (request: APIRequestContext, path: string, data: unknown, status: number, message: string) =>
  expect(await post(request, path, data, status)).toEqual({ status: 'ERROR', message });

const MUTE_HOW = "Provide 'mute' (bool) or 'toggle': true";

function outputGroup() {
  writeFile(OUTPUT, { groups: [
    { id: 7, name: 'Front Yard', enabled: true, channels: 2, members: [{ cardId: 'S3', channels: 2 }, { cardId: 'Idle' }] },
    { id: 9, name: 'Bare' },
  ] });
  startPipeWire({ objects: [nullSink('fpp_group_front_yard'), nullSink('fpp_fx_g7_s3')] });
  listen('fpp_group_front_yard');
  listen('fpp_fx_g7_s3');
}

test("an output group's mute is set or toggled on its sink, and saved", async ({ request }) => {
  outputGroup();
  expect(await post(request, 'groups/7/mute', { mute: true }))
    .toEqual({ status: 'OK', groupId: 7, nodeName: 'fpp_group_front_yard', mute: true, applied: true });
  expect(sinkMuted('fpp_group_front_yard')).toBe(true);
  expect(sinkMuted('fpp_fx_g7_s3'), "the group's mute muted its card").toBe(false);
  expect(groups()[0].mute).toBe(true);

  // A toggle goes by what is saved.
  expect((await post(request, 'groups/7/mute', { toggle: true })).mute).toBe(false);
  expect(sinkMuted('fpp_group_front_yard')).toBe(false);
  expect(groups()[0].mute).toBe(false);
  expect((await post(request, 'groups/7/mute', { toggle: true })).mute).toBe(true);
  expect((await post(request, 'groups/7/mute', { mute: false })).mute).toBe(false);
  expect(sinkMuted('fpp_group_front_yard')).toBe(false);

  // A group whose sink is not running is saved, and says it was not applied.
  expect(await post(request, 'groups/9/mute', { mute: true })).toMatchObject({ nodeName: 'fpp_group_bare', mute: true, applied: false });
  expect(groups()[1].mute).toBe(true);
  // The rest of the file is as it was.
  expect(groups()[0].members).toEqual([{ cardId: 'S3', channels: 2 }, { cardId: 'Idle' }]);

  await refused(request, 'groups/7/mute', {}, 400, MUTE_HOW);
  await refused(request, 'groups/7/mute', { toggle: false }, 400, MUTE_HOW);
  await refused(request, 'groups/8/mute', { mute: true }, 404, 'Output group 8 not found');
});

test("a member card's volume is set on its own sink, up to 150%, and saved", async ({ request }) => {
  outputGroup();
  expect(await post(request, 'groups/7/members/S3/volume', { volume: 75 })).toEqual({
    status: 'OK', groupId: 7, cardId: 'S3', nodeName: 'fpp_fx_g7_s3', volume: 75, applied: true, message: 'Volume set to 75%',
  });
  expect(sinkVolume('fpp_fx_g7_s3')).toBe(75);
  expect(sinkVolume('fpp_group_front_yard'), "the card's level moved the group").toBe(100);
  expect(groups()[0].members[0]).toEqual({ cardId: 'S3', channels: 2, volume: 75 });

  expect((await post(request, 'groups/7/members/S3/volume', { volume: 400 })).volume).toBe(150);
  expect(sinkVolume('fpp_fx_g7_s3')).toBe(150);
  expect((await post(request, 'groups/7/members/S3/volume', { volume: -5 })).volume).toBe(0);
  expect(sinkVolume('fpp_fx_g7_s3')).toBe(0);
  expect(groups()[0].members[0].volume).toBe(0);

  // A card with no filter-chain running has no sink of its own to set.
  expect(await post(request, 'groups/7/members/Idle/volume', { volume: 60 })).toMatchObject({
    nodeName: 'fpp_fx_g7_idle', volume: 60, applied: false,
    message: 'Volume saved; member sink not running (EQ/filter chain may be inactive)',
  });
  expect(groups()[0].members[1].volume).toBe(60);

  await refused(request, 'groups/7/members/S3/volume', {}, 400, "Missing 'volume'");
  await refused(request, 'groups/7/members/X9/volume', { volume: 10 }, 404, "Card 'X9' not found in group 7");
  // A group with no members, and no such group.
  await refused(request, 'groups/9/members/S3/volume', { volume: 10 }, 404, "Card 'S3' not found in group 9");
  await refused(request, 'groups/8/members/S3/volume', { volume: 10 }, 404, "Card 'S3' not found in group 8");
});

const BUS = { inputGroups: [
  { id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [], members: [
    { type: 'alsa_capture', name: 'Mic', channels: 2, volume: 100, mute: true },
    { type: 'fppd_stream' },
  ] },
] };

test("an input group member's volume is saved, clears its mute, and says why it was not applied", async ({ request }) => {
  writeFile(INPUT, BUS);
  expect(await post(request, 'input-groups/1/members/0/volume', { volume: 40 })).toEqual({
    status: 'OK', inputGroupId: 1, memberIndex: 0, volume: 40, applied: false,
    message: 'Volume saved; loopback not running (Apply input groups to activate)',
  });
  expect(inputGroups()[0].members[0]).toMatchObject({ name: 'Mic', volume: 40, mute: false });
  // The media stream is no loopback; and the level stops at 100 here.
  expect(await post(request, 'input-groups/1/members/1/volume', { volume: 130 })).toMatchObject({
    volume: 100, applied: false, message: 'Volume saved; primary fppd stream volume is governed by fppd, not a loopback',
  });
  expect(inputGroups()[0].members[1]).toEqual({ type: 'fppd_stream', volume: 100, mute: false });

  await refused(request, 'input-groups/1/members/0/volume', {}, 400, "Missing 'volume'");
  await refused(request, 'input-groups/1/members/5/volume', { volume: 10 }, 404, 'Member 5 not found in input group 1');
  await refused(request, 'input-groups/9/members/0/volume', { volume: 10 }, 404, 'Member 0 not found in input group 9');
});

test("an input group member's mute is saved beside its level, which it keeps", async ({ request }) => {
  writeFile(INPUT, BUS);
  await post(request, 'input-groups/1/members/0/volume', { volume: 40 });
  expect(await post(request, 'input-groups/1/members/0/mute', { mute: true }))
    .toEqual({ status: 'OK', inputGroupId: 1, memberIndex: 0, mute: true, applied: false });
  expect(inputGroups()[0].members[0]).toMatchObject({ volume: 40, mute: true });
  expect((await post(request, 'input-groups/1/members/0/mute', { toggle: true })).mute).toBe(false);
  expect(inputGroups()[0].members[0]).toMatchObject({ volume: 40, mute: false });
  // A member never muted toggles on.
  expect((await post(request, 'input-groups/1/members/1/mute', { toggle: true })).mute).toBe(true);

  await refused(request, 'input-groups/1/members/0/mute', {}, 400, MUTE_HOW);
  await refused(request, 'input-groups/1/members/5/mute', { mute: true }, 404, 'Member 5 not found in input group 1');
  await refused(request, 'input-groups/9/members/0/mute', { mute: true }, 404, 'Member 0 not found in input group 9');
});

test.describe("an input group member's fader on a running loopback", () => {
  const live = () => {
    writeFile(INPUT, { inputGroups: [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [],
      members: [{ type: 'alsa_capture', name: 'Mic', channels: 2, volume: 100 }] }] });
    startPipeWire({
      objects: [nullSink('fpp_input_bus'), nullSink('fpp_tests_mic')],
      modules: [loopback('fpp_loopback_ig1_mic', { 'target.object': 'fpp_tests_mic', 'stream.capture.sink': true },
        { 'target.object': 'fpp_input_bus' })],
      waitFor: ['input.fpp_loopback_ig1_mic', 'output.fpp_loopback_ig1_mic'],
    });
  };
  const level = () => nodeProps('output.fpp_loopback_ig1_mic').channelVolumes;

  test('moves the level through /api/pipewire/audio (the control)', async ({ request }) => {
    live();
    const r = await request.post('/api/pipewire/audio/input-groups/volume', { data: { groupId: 1, memberIndex: 0, volume: 40 } });
    expect(r.ok(), await r.text()).toBe(true);
    await expect.poll(level).toEqual([0.4, 0.4]);
  });

  test('moves the level through /api/pipewire/control', async ({ request }) => {
    // The control API sets channelmix.volume on the loopback's nodes, which a
    // running node accepts and does nothing with (da73dbec6 moved the audio
    // API to channelVolumes on the playback half for that reason), so it
    // answers applied: true and the level stays where it was.  In FUTURE.md.
    test.fail(true, 'the control API reports a level as applied that the loopback never took (FUTURE.md)');
    live();
    const body = await post(request, 'input-groups/1/members/0/volume', { volume: 40 });
    expect(body.applied).toBe(true);
    await expect.poll(level, { timeout: 4000 }).toEqual([0.4, 0.4]);
  });
});

test.describe('a routing path', () => {
  test.beforeEach(() => {
    writeFile(OUTPUT, { groups: [{ id: 1, name: 'Front' }] });
    writeFile(INPUT, { inputGroups: [{ id: 5, name: 'Mic', enabled: true, outputs: [1] }, { id: 6, name: 'Line', routing: { 1: { volume: 20 } } }] });
  });
  const path = async (request: APIRequestContext, ig: number) =>
    (await (await request.get(`${C}/routing`)).json()).matrix.find((m: any) => m.inputGroupId === ig).paths[0];

  test('has its level saved, between 0 and 100, with no route running to apply it to', async ({ request }) => {
    expect(await post(request, 'routing/5/1/volume', { volume: 60 })).toEqual({
      status: 'OK', inputGroupId: 5, outputGroupId: 1, volume: 60, applied: false,
      message: 'Saved; route not active (Apply input groups)',
    });
    expect(inputGroups()[0].routing).toEqual({ 1: { volume: 60 } });
    expect(await path(request, 5)).toMatchObject({ outputGroupId: 1, connected: true, volume: 60, mute: false });
    expect((await post(request, 'routing/5/1/volume', { volume: 250 })).volume).toBe(100);
    expect((await post(request, 'routing/5/1/volume', { volume: -1 })).volume).toBe(0);
    expect(inputGroups()[0].routing).toEqual({ 1: { volume: 0 } });
    // The other group's path is its own.
    expect(inputGroups()[1].routing).toEqual({ 1: { volume: 20 } });
    await refused(request, 'routing/5/1/volume', {}, 400, "Missing 'volume'");
  });

  test('has its mute saved beside its level', async ({ request }) => {
    expect(await post(request, 'routing/6/1/mute', { mute: true }))
      .toEqual({ status: 'OK', inputGroupId: 6, outputGroupId: 1, mute: true, applied: false });
    expect(inputGroups()[1].routing).toEqual({ 1: { volume: 20, mute: true } });
    expect(await path(request, 6)).toMatchObject({ volume: 20, mute: true });
    expect((await post(request, 'routing/6/1/mute', { toggle: true })).mute).toBe(false);
    expect(inputGroups()[1].routing).toEqual({ 1: { volume: 20, mute: false } });
    // A path with nothing saved toggles on, and gains no level by it.
    expect((await post(request, 'routing/5/1/mute', { toggle: true })).mute).toBe(true);
    expect(inputGroups()[0].routing).toEqual({ 1: { mute: true } });
    await refused(request, 'routing/5/1/mute', {}, 400, MUTE_HOW);
  });

  test('between an input group and an output group there are (the control)', async ({ request }) => {
    expect((await post(request, 'routing/5/1/volume', { volume: 30 })).status).toBe('OK');
  });

  test('between groups that do not exist is refused, not "Saved"', async ({ request }) => {
    // Nothing is looked up before the answer: an input group the player does
    // not have is "Saved; route not active" with nothing saved.  In FUTURE.md.
    test.fail(true, 'a level for a path between unknown groups is answered as saved (FUTURE.md)');
    const before = readFile(INPUT);
    const r = await request.post(`${C}/routing/99/1/volume`, { data: { volume: 30 } });
    expect(JSON.parse(readFile(INPUT))).toEqual(JSON.parse(before));
    expect(r.status()).toBe(404);
  });
});

test('under any other backend every setter is a 409 that names the backend, and nothing is saved', async ({ request }) => {
  for (const k of keys) setSettingInFile(k, 'alsa');
  writeFile(OUTPUT, { groups: [{ id: 7, name: 'Front Yard', members: [{ cardId: 'S3' }] }] });
  writeFile(INPUT, BUS);
  const before = [readFile(OUTPUT), readFile(INPUT)];
  for (const [path, data] of [
    ['groups/7/mute', { mute: true }],
    ['groups/7/members/S3/volume', { volume: 10 }],
    ['input-groups/1/members/0/volume', { volume: 10 }],
    ['input-groups/1/members/0/mute', { mute: false }],
    ['routing/1/7/volume', { volume: 10 }],
    ['routing/1/7/mute', { mute: true }],
  ] as const) {
    await refused(request, path, data, 409, 'PipeWire backend is not active (MediaBackend=alsa)');
  }
  expect([readFile(OUTPUT), readFile(INPUT)]).toEqual(before);
});
