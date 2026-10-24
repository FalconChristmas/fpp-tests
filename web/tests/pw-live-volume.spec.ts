import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { settingInFile, setSettingInFile } from './settings-file';
import { listen, loopback, nodeProps, nullSink, sinkMuted, sinkVolume, startPipeWire, stopPipeWire } from './pw-live';

// The real-time level controls -- output group and member faders, input
// group members, a filter-chain's EQ and the /api/pipewire/control facade --
// against a real PipeWire in the player (pw-live.ts).  Null sinks and
// loopbacks named the way FPP names its own stand in for the group sinks,
// filter-chains and loopbacks a player builds; each check reads the level
// back from PipeWire, not from what the PHP said it did.

test.skip(!container, 'runs a PipeWire inside the run-web.sh container');

test.afterEach(() => {
  stopPipeWire();
  cleanupPipeWire();
});

const groups = () => JSON.parse(readFile(`${CONFIG}/pipewire-audio-groups.json`)).groups;
const inputGroups = () => JSON.parse(readFile(`${CONFIG}/pipewire-input-groups.json`)).inputGroups;

test("an output group's fader moves its sink, and pipewire.php has no ${} PHP 9 cannot parse", async ({ request }) => {
  // Regression: b294d88c9. The pactl volume commands were built with
  // "${volume}%", which PHP 8.2 deprecated and PHP 9 drops: a compile-time
  // notice in every request that loads the API (the player's php.ini keeps
  // deprecations out of the log), and on PHP 9 a parse error that would take
  // the whole API down.  The level itself still interpolated.
  const lint = inPlayer('sh', '-c', 'php -d error_reporting=-1 -d display_errors=1 -d log_errors=0 ' +
    '-l /opt/fpp/www/api/controllers/pipewire.php 2>&1 || true');
  expect(lint).toContain('No syntax errors');
  expect(lint).not.toMatch(/Deprecated/);

  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Yard', enabled: true, channels: 2, members: [] }],
  });
  startPipeWire({ objects: [nullSink('fpp_group_yard')] });
  listen('fpp_group_yard');
  const r = await request.post('/api/pipewire/audio/group/volume', { data: { sink: 'fpp_group_yard', volume: 40 } });
  expect(r.ok(), await r.text()).toBe(true);
  expect((await r.json()).status).toBe('OK');
  expect(sinkVolume('fpp_group_yard')).toBe(40);
});

// The control API and the audio groups page answer only under the Advanced
// PipeWire backend: MediaBackend, which was AudioBackend before the media
// backends were split.
test.describe('with the Advanced PipeWire backend', () => {
  const keys = ['MediaBackend', 'AudioBackend'];
  let saved: (string | undefined)[] = [];
  test.beforeEach(() => {
    saved = keys.map(settingInFile);
    for (const k of keys) setSettingInFile(k, 'pipewire');
  });
  test.afterEach(() => keys.forEach((k, i) => setSettingInFile(k, saved[i])));

  test('the control API addresses an output group and its card by id, applies live and saves', async ({ request }) => {
    // Feature: dcd4c4df7. /api/pipewire/control/* takes friendly ids (group
    // id, ALSA card id) instead of node names, reads the live level back from
    // PipeWire, and saves what it sets so the boot-time restore applies it.
    writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
      groups: [{ id: 7, name: 'Front Yard', enabled: true, channels: 2, members: [{ cardId: 'S3', channels: 2 }] }],
    });
    startPipeWire({ objects: [nullSink('fpp_group_front_yard'), nullSink('fpp_fx_g7_s3')] });
    listen('fpp_group_front_yard');
    listen('fpp_fx_g7_s3');

    const st = await request.get('/api/pipewire/control/status');
    expect(st.ok(), await st.text()).toBe(true);
    expect(await st.json()).toMatchObject({ status: 'OK', backend: 'pipewire', pipewireActive: true, outputGroupCount: 1 });

    const vol = await request.post('/api/pipewire/control/groups/7/volume', { data: { volume: 35 } });
    expect(vol.ok(), await vol.text()).toBe(true);
    expect(await vol.json()).toMatchObject({ status: 'OK', nodeName: 'fpp_group_front_yard', volume: 35, applied: true });
    expect(sinkVolume('fpp_group_front_yard')).toBe(35);
    expect(groups()[0].volume).toBe(35);

    const mute = await request.post('/api/pipewire/control/groups/7/members/S3/mute', { data: { mute: true } });
    expect(mute.ok(), await mute.text()).toBe(true);
    expect(sinkMuted('fpp_fx_g7_s3')).toBe(true);
    expect(sinkMuted('fpp_group_front_yard'), 'the member mute muted the group').toBe(false);

    const got = await request.get('/api/pipewire/control/groups/7');
    expect(got.ok(), await got.text()).toBe(true);
    const g = (await got.json()).group;
    expect(g).toMatchObject({ nodeName: 'fpp_group_front_yard', liveVolume: 35, configVolume: 35, volumeSource: 'live', running: true });
    expect(g.members[0]).toMatchObject({ cardId: 'S3', nodeName: 'fpp_fx_g7_s3', liveMute: true, configMute: true });

    expect((await request.post('/api/pipewire/control/groups/8/volume', { data: { volume: 35 } })).status()).toBe(404);
  });

  test('a group or member saved at volume 0 shows 0% on the audio groups page', async ({ page }) => {
    // Regression: eca159bb8. The page drew a level as "volume || 100", so a
    // group or card saved at 0 showed (and its slider started at) 100%.
    writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
      groups: [{ id: 1, name: 'Yard', enabled: true, channels: 2, volume: 0,
        members: [{ cardId: 'S3', cardName: 'S3', channels: 2, volume: 0 }] }],
    });
    await page.goto('/pipewire-audio.php');
    const values = page.locator('.volume-value');
    await expect(values.first()).toBeVisible({ timeout: 15_000 });
    await expect(values).toHaveText(['0%', '0%']);
  });
});

test("an input group member's level is found on the loopback's halves", async ({ request }) => {
  // Regression: 019e622e8. A loopback module makes input.<name> and
  // output.<name> and no node called <name>; the member volume looked for
  // <name> alone and answered "Loopback node ... not found" for every member.
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [],
      members: [{ type: 'alsa_capture', name: 'Mic', channels: 2, volume: 100 }] }],
  });
  startPipeWire({
    objects: [nullSink('fpp_input_bus'), nullSink('fpp_tests_mic')],
    modules: [loopback('fpp_loopback_ig1_mic', { 'target.object': 'fpp_tests_mic', 'stream.capture.sink': true },
      { 'target.object': 'fpp_input_bus' })],
    waitFor: ['input.fpp_loopback_ig1_mic', 'output.fpp_loopback_ig1_mic'],
  });

  const r = await request.post('/api/pipewire/audio/input-groups/volume', { data: { groupId: 1, memberIndex: 0, volume: 40 } });
  expect(r.ok(), await r.text()).toBe(true);
  const body = await r.json();
  expect(body.status, JSON.stringify(body)).toBe('OK');
  expect(body.nodeName).toBe('fpp_loopback_ig1_mic');
  expect(inputGroups()[0].members[0].volume).toBe(40);
});

test("an input group member's level lands on the loopback's playback side, and a mute is a zero there", async ({ request }) => {
  // The receiving end of the member fader, da73dbec6: channelVolumes on
  // output.<name> alone (channelmix.volume on a running node is accepted and
  // changes nothing, and on both halves the level applied twice).
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [],
      members: [{ type: 'alsa_capture', name: 'Mic', channels: 2, volume: 100 }] }],
  });
  startPipeWire({
    objects: [nullSink('fpp_input_bus'), nullSink('fpp_tests_mic')],
    modules: [loopback('fpp_loopback_ig1_mic', { 'target.object': 'fpp_tests_mic', 'stream.capture.sink': true },
      { 'target.object': 'fpp_input_bus' })],
    waitFor: ['input.fpp_loopback_ig1_mic', 'output.fpp_loopback_ig1_mic'],
  });
  const levels = () => ({
    out: nodeProps('output.fpp_loopback_ig1_mic').channelVolumes,
    in: nodeProps('input.fpp_loopback_ig1_mic').channelVolumes,
  });
  const post = async (data: object) => {
    const r = await request.post('/api/pipewire/audio/input-groups/volume', { data: { groupId: 1, memberIndex: 0, ...data } });
    expect(r.ok(), await r.text()).toBe(true);
    expect((await r.json()).status).toBe('OK');
  };

  await post({ volume: 40 });
  await expect.poll(levels).toEqual({ out: [0.4, 0.4], in: [1, 1] });
  await post({ volume: 40, mute: true });
  await expect.poll(levels).toEqual({ out: [0, 0], in: [1, 1] });
  await post({ volume: 40, mute: false });
  await expect.poll(levels).toEqual({ out: [0.4, 0.4], in: [1, 1] });
});

test('muting an input group member keeps its level for the unmute', async ({ request }) => {
  // Regression: c7c7581cc. The mixer mutes a member by sending volume 0; the
  // API saved that 0 as the member's level and kept no mute flag, so the mute
  // did not survive a reload and unmuting had no level to go back to.
  // (The member's node here is a bare <name>, which the API has looked for
  // since before 019e622e8 added the loopback's halves.)
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [],
      members: [{ type: 'alsa_capture', name: 'Mic', channels: 2, volume: 70 }] }],
  });
  startPipeWire({ objects: [nullSink('fpp_loopback_ig1_mic')] });
  const post = async (data: object) => {
    const r = await request.post('/api/pipewire/audio/input-groups/volume', { data: { groupId: 1, memberIndex: 0, ...data } });
    expect(r.ok(), await r.text()).toBe(true);
    expect((await r.json()).status).toBe('OK');
    return inputGroups()[0].members[0];
  };

  expect(await post({ volume: 0, mute: true })).toMatchObject({ volume: 70, mute: true });
  expect(await post({ volume: 70, mute: false })).toMatchObject({ volume: 70, mute: false });
  // A fader move clears a mute and saves the level.
  await post({ volume: 0, mute: true });
  expect(await post({ volume: 55 })).toMatchObject({ volume: 55, mute: false });
});

test("a card's EQ is changed on its running filter-chain without a restart", async ({ request }) => {
  // Feature: 7a5b37368. POST /api/pipewire/audio/eq/update sets the bands of
  // a member's running EQ filter-chain through pw-cli set-param.  The
  // filter-chain is the shape FPP generates for a card's EQ, under the name
  // 7a5b37368 gave it (fpp_eq_g<group>_<card>, still looked up after the
  // later fpp_fx_ name).
  const band = (ch: string) => `{ type = builtin label = bq_peaking name = eq_${ch}_0 control = { "Freq" = 1000 "Q" = 1.0 "Gain" = 0 } }`;
  startPipeWire({
    objects: [nullSink('fpp_alsa_s3')],
    modules: [`{ name = libpipewire-module-filter-chain args = { node.description = "EQ: S3"
      filter.graph = { nodes = [ ${band('l')} ${band('r')} ] inputs = [ "eq_l_0:In" "eq_r_0:In" ] outputs = [ "eq_l_0:Out" "eq_r_0:Out" ] }
      capture.props = { node.name = "fpp_eq_g1_s3" media.class = Audio/Sink audio.channels = 2 audio.position = [ FL FR ] }
      playback.props = { node.name = "fpp_eq_g1_s3_out" node.passive = true target.object = "fpp_alsa_s3" audio.channels = 2 audio.position = [ FL FR ] } } }`],
    waitFor: ['fpp_eq_g1_s3', 'fpp_eq_g1_s3_out'],
  });
  const params = () => {
    const list: unknown[] = nodeProps('fpp_eq_g1_s3').params ?? [];
    const out: Record<string, number> = {};
    for (let i = 0; i + 1 < list.length; i += 2) out[String(list[i])] = Math.round(Number(list[i + 1]) * 100) / 100;
    return out;
  };
  expect(params()['eq_l_0:Gain'], JSON.stringify(nodeProps('fpp_eq_g1_s3'))).toBe(0);

  const r = await request.post('/api/pipewire/audio/eq/update', {
    data: { groupId: 1, cardId: 'S3', channels: 2, bands: [{ freq: 2500, q: 2, gain: 6 }] } });
  expect(r.ok(), await r.text()).toBe(true);
  expect((await r.json()).status).toBe('OK');
  await expect.poll(params).toMatchObject({
    'eq_l_0:Freq': 2500, 'eq_l_0:Q': 2, 'eq_l_0:Gain': 6, 'eq_r_0:Freq': 2500, 'eq_r_0:Q': 2, 'eq_r_0:Gain': 6 });

  // A card with no running filter-chain is told to apply first.
  const none = await request.post('/api/pipewire/audio/eq/update', {
    data: { groupId: 1, cardId: 'T9', channels: 2, bands: [{ freq: 2500, q: 2, gain: 6 }] } });
  expect((await none.json()).status).toBe('NOT_RUNNING');
});
