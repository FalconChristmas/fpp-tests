import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, writeFile } from './pw-helpers';
import { bursts, nodeProps, nullSink, readBinary, record, startPipeWire, stopPipeWire, wavSamples } from './pw-live';
import { putFile } from './settings-file';

// Sync calibration for audio output groups: the click track the audio groups
// page plays into one group's sink to line up its cards' delays, and the
// live delay control those delays are set with.  Played and set against a
// real PipeWire in the player (pw-live.ts), whose null sinks stand in for
// the groups' combine sinks; what reached a sink is recorded off its monitor.

test.skip(!container, 'runs a PipeWire inside the run-web.sh container');

const MUSIC = '/home/fpp/media/music';
const CLICK = `${MUSIC}/fpp_sync_click.wav`;

test.afterEach(async ({ request }) => {
  await request.post('/api/pipewire/audio/sync/stop');
  stopPipeWire();
  cleanupPipeWire();
  inPlayer('rm', '-f', CLICK);
});

function groupsNamed(...names: string[]) {
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: names.map((name, i) => ({ id: i + 1, name, enabled: true, channels: 2, members: [] })),
  });
}

// Zero crossings in the first 20 ms of a click, which tell 1000 Hz (40) from 600 Hz (24).
function crossings(s: Int16Array, from: number, rate: number) {
  let n = 0;
  for (let i = from + 1; i < from + Math.round(0.02 * rate); i++) if ((s[i - 1] < 0) !== (s[i] < 0)) n++;
  return n;
}

test('the click track is made without ffmpeg or sox, and plays into the chosen group only, until stopped', async ({ request }) => {
  // Regression: 0766ae5f8. The click track was generated with ffmpeg, then
  // sox; a player with neither (FPP's images ship neither) answered "Failed
  // to generate click track" and calibration never started.  The same
  // commit made the loop that repeats it start reliably: it checked for the
  // PID file before that was written, and could end before it played once.
  expect(inPlayer('sh', '-c', 'command -v ffmpeg sox || true').trim(), 'the image has ffmpeg or sox').toBe('');
  groupsNamed('Other', 'Cal');
  startPipeWire({ objects: [nullSink('fpp_group_other'), nullSink('fpp_group_cal')] });

  const r = await request.post('/api/pipewire/audio/sync/start', { data: { groupIndex: 1 } });
  expect(r.ok(), await r.text()).toBe(true);
  expect(await r.json()).toMatchObject({ status: 'OK', sink: 'fpp_group_cal' });

  // A minute of 16-bit mono 44.1 kHz: a 20 ms click at the top of every
  // second, 1000 Hz and 600 Hz in turn, silence between.
  const wav = readBinary(CLICK);
  expect(wav.toString('ascii', 0, 4) + wav.toString('ascii', 8, 12)).toBe('RIFFWAVE');
  expect({ format: wav.readUInt16LE(20), channels: wav.readUInt16LE(22), rate: wav.readUInt32LE(24), bits: wav.readUInt16LE(34) })
    .toEqual({ format: 1, channels: 1, rate: 44100, bits: 16 });
  const s = wavSamples(wav);
  expect(s.length / 44100).toBeCloseTo(60, 2);
  const starts = bursts(s, 44100);
  expect(starts).toHaveLength(60);
  starts.forEach((t, i) => expect(t, `click ${i}`).toBeCloseTo(i, 1));
  expect([0, 1, 2, 3].map((i) => crossings(s, i * 44100, 44100))).toEqual([39, 23, 39, 23]);

  // And it is what the chosen group's sink hears, a click a second, and the
  // other group hears nothing.  (The track loops, so the two can be
  // recorded one after the other.)
  const heard = bursts(record('fpp_group_cal', 4), 48000);
  expect(heard.length, `clicks at ${heard}`).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < heard.length; i++) expect(heard[i] - heard[i - 1]).toBeCloseTo(1, 1);
  expect(bursts(record('fpp_group_other', 3), 48000), 'clicks reached the other group').toEqual([]);

  const stop = await request.post('/api/pipewire/audio/sync/stop');
  expect(stop.ok(), await stop.text()).toBe(true);
  expect(bursts(record('fpp_group_cal', 2), 48000), 'clicks after Stop').toEqual([]);
});

test('calibration is sent to the chosen group, and an unknown group is refused', async ({ request }) => {
  // Regression: 8511f0327. The click track was handed to fppd's Play Media,
  // which played it wherever fppd's media goes, whatever group the page
  // asked to calibrate, and any group index was taken.  The track is put in
  // place first: before 0766ae5f8 it came from ffmpeg, which the image does
  // not have.  (What the group's sink then hears is checked above; on
  // 8511f0327 itself, with ffmpeg stood in, nothing reached it, and
  // 0766ae5f8 rewrote that playback.)
  const click = Buffer.alloc(44 + 2 * 44100);
  click.write('RIFF', 0); click.writeUInt32LE(click.length - 8, 4); click.write('WAVEfmt ', 8);
  click.writeUInt32LE(16, 16); click.writeUInt16LE(1, 20); click.writeUInt16LE(1, 22);
  click.writeUInt32LE(44100, 24); click.writeUInt32LE(88200, 28); click.writeUInt16LE(2, 32); click.writeUInt16LE(16, 34);
  click.write('data', 36); click.writeUInt32LE(click.length - 44, 40);
  putFile(CLICK, click);
  groupsNamed('Front', 'Back');

  const r = await request.post('/api/pipewire/audio/sync/start', { data: { groupIndex: 1 } });
  expect(r.ok(), await r.text()).toBe(true);
  expect(await r.json()).toMatchObject({ status: 'OK', sink: 'fpp_group_back' });

  const bad = await request.post('/api/pipewire/audio/sync/start', { data: { groupIndex: 5 } });
  expect((await bad.json()).status).toBe('ERROR');
});

test("a card's delay is changed on its running filter-chain without a restart", async ({ request }) => {
  // Feature: 5fa712a8a. Calibrating group timings: each member gets a delay
  // stage in its filter-chain (fpp_fx_g<group>_<card>), and POST
  // /api/pipewire/audio/delay/update moves it live through pw-cli set-param
  // while the click track plays.  The filter-chain is the shape FPP
  // generates for a member's delay.
  const delay = (ch: string) => `{ type = builtin label = delay name = delay_${ch} config = { "max-delay" = 2.0 } control = { "Delay (s)" = 0.0 } }`;
  startPipeWire({
    objects: [nullSink('fpp_alsa_s3')],
    modules: [`{ name = libpipewire-module-filter-chain args = { node.description = "FX: S3"
      filter.graph = { nodes = [ ${delay('l')} ${delay('r')} ] inputs = [ "delay_l:In" "delay_r:In" ] outputs = [ "delay_l:Out" "delay_r:Out" ] }
      capture.props = { node.name = "fpp_fx_g1_s3" media.class = Audio/Sink audio.channels = 2 audio.position = [ FL FR ] }
      playback.props = { node.name = "fpp_fx_g1_s3_out" node.passive = true target.object = "fpp_alsa_s3" audio.channels = 2 audio.position = [ FL FR ] } } }`],
    waitFor: ['fpp_fx_g1_s3', 'fpp_fx_g1_s3_out'],
  });
  const delays = () => {
    const list: unknown[] = nodeProps('fpp_fx_g1_s3').params ?? [];
    const out: Record<string, number> = {};
    for (let i = 0; i + 1 < list.length; i += 2) out[String(list[i])] = Math.round(Number(list[i + 1]) * 1000) / 1000;
    return out;
  };
  expect(delays()['delay_l:Delay (s)'], JSON.stringify(nodeProps('fpp_fx_g1_s3'))).toBe(0);

  const r = await request.post('/api/pipewire/audio/delay/update', { data: { groupId: 1, cardId: 'S3', delayMs: 250, channels: 2 } });
  expect(r.ok(), await r.text()).toBe(true);
  expect((await r.json()).status).toBe('OK');
  await expect.poll(delays).toMatchObject({ 'delay_l:Delay (s)': 0.25, 'delay_r:Delay (s)': 0.25 });
});
