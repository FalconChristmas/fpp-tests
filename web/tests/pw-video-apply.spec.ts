import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, exists, fakeDrmConnectors, readFile, writeFile } from './pw-helpers';
import { settingInFile, snapshotSettings } from './settings-file';

// Applying the video config: POST /api/pipewire/video/groups/apply turns the
// video output groups into the consumer list fppd's VideoOutputManager reads
// (HDMI outputs from the display connectors, overlay models, RTP and RTSP
// streams) and sets the stream slots' video sink, and POST
// /api/pipewire/video/input-sources/apply turns the video input sources into
// the list its VideoInputManager reads.  The display connectors are fake
// /sys/class/drm entries (fakeDrmConnectors).  fppd is told to reload; what it
// then plays is not checked here.

test.skip(!container, "writes the run-web.sh container's video config");

const GROUPS = `${CONFIG}/pipewire-video-groups.json`;
const CONSUMERS = `${CONFIG}/pipewire-video-consumers.json`;
const SOURCES = `${CONFIG}/pipewire-video-input-sources.json`;
const SOURCES_GEN = `${CONFIG}/pipewire-video-input-sources-gen.json`;
const FILES = [GROUPS, CONSUMERS, SOURCES, SOURCES_GEN];
const SLOT_KEYS = ['PipeWireVideoSinkName', ...[2, 3, 4, 5].map((s) => `PipeWireVideoSinkName_${s}`)];

let restoreSettings: () => void;
let before: (string | null)[] = [];

test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  before = FILES.map((f) => (exists(f) ? readFile(f) : null));
});

test.afterEach(async ({ request }) => {
  // With nothing configured, both applies tell fppd to drop what it was
  // given and clear the slots' video sinks in fppd too.
  inPlayer('rm', '-f', ...FILES);
  await request.post('/api/pipewire/video/groups/apply');
  await request.post('/api/pipewire/video/input-sources/apply');
  FILES.forEach((f, i) => {
    const b = before[i];
    if (b === null) inPlayer('rm', '-f', f);
    else writeFile(f, b);
  });
  cleanupPipeWire();
  restoreSettings();
});

const slotSinks = () => SLOT_KEYS.map((k) => settingInFile(k) ?? '');

test('the enabled groups\' members become consumers, each named for its group and place in it', async ({ request }) => {
  fakeDrmConnectors([
    { card: 1, name: 'HDMI-A-2', status: 'disconnected', id: 34 },
    { card: 1, name: 'HDMI-A-1', status: 'connected', id: 33, modes: ['1920x1080', '1280x720'] },
    { card: 1, name: 'Writeback-1', status: 'unknown', id: 40 }, // not a display
    { card: 0, name: 'Virtual-1' },                               // no status: not listed
  ]);
  writeFile(GROUPS, { videoOutputGroups: [
    { id: 1, name: 'Main Wall', enabled: true, videoSource: 'fpp_video_src_1_cam', streamSlots: ['2', 4], members: [
      { type: 'hdmi', connector: 'HDMI-A-1', region: 'left', scaling: 'stretch' },
      // Percentages, clamped to the frame.
      { type: 'hdmi', connector: 'HDMI-A-2', region: 'custom', cropX: 10, cropY: -5, cropWidth: 200, cropHeight: 30 },
      { type: 'hdmi', connector: 'HDMI-A-9' },   // no such connector
      { type: 'overlay', overlayModel: 'Matrix' },
      { type: 'overlay' },                       // no model
      { type: 'rtp' },
      { type: '' },                              // not counted
      { type: 'ndi' },                           // not a type there is
    ] },
    { id: 2, name: 'Stream Out', enabled: true, members: [
      { type: 'rtsp', mountPoint: 'show cam!' },
      { type: 'rtsp', mountPoint: '/' },
      { type: 'rtsp', mountPoint: '/showcam', videoEncoding: 'vp9', audioEnabled: true, width: 1920, height: 1080,
        framerate: 25, videoBitrate: 8000, audioBitrate: 96000 },
    ] },
    { id: 3, name: 'Off', enabled: false, members: [{ type: 'rtp' }] },
    { id: 4, name: 'Empty', enabled: true, members: [] },
  ] });

  const r = await (await request.post('/api/pipewire/video/groups/apply')).json();
  expect(r).toMatchObject({ status: 'OK', message: '2 video output group(s) with 7 consumer(s) configured' });

  const wall = { groupId: 1, groupName: 'Main Wall', groupNodeName: 'fpp_video_group_1_main_wall',
    sourceNode: 'fpp_video_src_1_cam', streamSlots: [2, 4] };
  const out = { groupId: 2, groupName: 'Stream Out', groupNodeName: 'fpp_video_group_2_stream_out' };
  const rtsp = (m: number, mountPoint: string, extra: Record<string, unknown> = {}) => ({
    ...out, type: 'rtsp', pipeWireNodeName: `fpp_video_group_2_stream_out_m${m}_rtsp`, mountPoint,
    videoEncoding: 'h264', videoBitrate: 4000, width: 1280, height: 720, framerate: 30,
    audioEnabled: false, audioBitrate: 128000, audioNodeName: `fpp_rtsp_audio_2_${m}`, name: `RTSP ${mountPoint}`, ...extra,
  });
  const expected = [
    { ...wall, type: 'hdmi', pipeWireNodeName: 'fpp_video_group_1_main_wall_m1_hdmi', connector: 'HDMI-A-1',
      cardPath: '/dev/dri/card1', connectorId: 33, width: 1920, height: 1080, scaling: 'stretch',
      crop: { x: 0, y: 0, width: 0.5, height: 1 }, name: 'HDMI-A-1' },
    { ...wall, type: 'hdmi', pipeWireNodeName: 'fpp_video_group_1_main_wall_m2_hdmi', connector: 'HDMI-A-2',
      cardPath: '/dev/dri/card1', connectorId: 34, width: 0, height: 0, scaling: 'fit',
      crop: { x: 0.1, y: 0, width: 0.9, height: 0.3 }, name: 'HDMI-A-2' },
    { ...wall, type: 'overlay', pipeWireNodeName: 'fpp_video_group_1_main_wall_m4_overlay', overlayModel: 'Matrix',
      name: 'Overlay: Matrix' },
    { ...wall, type: 'rtp', pipeWireNodeName: 'fpp_video_group_1_main_wall_m6_rtp', address: '239.0.0.1', port: 5004,
      encoding: 'h264', name: 'RTP 239.0.0.1:5004 (H264)' },
    rtsp(1, '/showcam'),
    rtsp(2, '/group2_m2'),
    // The same path as the first: made unique.  An encoding fppd has no
    // encoder for falls back to H.264.
    rtsp(3, '/showcam_g2m3', { audioEnabled: true, width: 1920, height: 1080, framerate: 25, videoBitrate: 8000, audioBitrate: 96000 }),
  ];
  expect(r.consumers).toEqual(expected);
  expect(JSON.parse(readFile(CONSUMERS))).toEqual(expected);

  // The groups are saved with their node names, and the RTSP members with the
  // path as cleaned up and the audio node to route to.
  const saved = JSON.parse(readFile(GROUPS)).videoOutputGroups;
  expect(saved.map((g: { pipeWireNodeName?: string }) => g.pipeWireNodeName))
    .toEqual(['fpp_video_group_1_main_wall', 'fpp_video_group_2_stream_out', undefined, undefined]);
  expect(saved[1].members.map((m: { mountPoint: string; audioNodeName: string }) => [m.mountPoint, m.audioNodeName])).toEqual([
    ['/showcam', 'fpp_rtsp_audio_2_1'], ['/group2_m2', 'fpp_rtsp_audio_2_2'], ['/showcam_g2m3', 'fpp_rtsp_audio_2_3'],
  ]);

  // A group with no stream slots of its own takes video from every slot.
  expect(slotSinks()).toEqual(Array(5).fill('fpp_video_bus'));

  // The connectors the output group page offers: connected first.
  const { connectors } = await (await request.get('/api/pipewire/video/connectors')).json();
  expect(connectors.map((c: { connector: string; connected: boolean }) => [c.connector, c.connected]))
    .toEqual([['HDMI-A-1', true], ['HDMI-A-2', false]]);
});

test('only the stream slots the groups name are given a video sink', async ({ request }) => {
  writeFile(GROUPS, { videoOutputGroups: [
    { id: 1, name: 'A', enabled: true, streamSlots: [2], members: [{ type: 'overlay', overlayModel: 'M1' }] },
    { id: 2, name: 'B', enabled: true, streamSlots: ['4'], members: [{ type: 'rtp', address: '239.1.1.1', port: '6000', encoding: 'h265' }] },
    { id: 3, name: 'C', enabled: false, members: [{ type: 'overlay', overlayModel: 'M2' }] },
  ] });
  const r = await (await request.post('/api/pipewire/video/groups/apply')).json();
  expect(r.consumers.map((c: { name: string }) => c.name)).toEqual(['Overlay: M1', 'RTP 239.1.1.1:6000 (H265)']);
  expect(slotSinks()).toEqual(['', 'fpp_video_bus', '', 'fpp_video_bus', '']);

  // Groups with nothing in them: every slot's video sink is cleared.
  writeFile(GROUPS, { videoOutputGroups: [{ id: 1, name: 'A', enabled: true, members: [] }] });
  expect(await (await request.post('/api/pipewire/video/groups/apply')).json())
    .toMatchObject({ message: '0 video output group(s) with 0 consumer(s) configured', consumers: [] });
  expect(slotSinks()).toEqual(Array(5).fill(''));
});

test('with no video groups saved, or none in the file, every slot\'s video sink is cleared', async ({ request }) => {
  writeFile(GROUPS, { videoOutputGroups: [{ id: 1, name: 'A', enabled: true, members: [{ type: 'rtp' }] }] });
  await request.post('/api/pipewire/video/groups/apply');
  expect(slotSinks()).toEqual(Array(5).fill('fpp_video_bus'));

  writeFile(GROUPS, { videoOutputGroups: [] });
  expect(await (await request.post('/api/pipewire/video/groups/apply')).json())
    .toEqual({ status: 'OK', message: 'Video output groups cleared' });
  expect(slotSinks()).toEqual(Array(5).fill(''));

  inPlayer('rm', '-f', GROUPS);
  expect(await (await request.post('/api/pipewire/video/groups/apply')).json())
    .toEqual({ status: 'OK', message: 'No video output groups configured' });
});

test('the video input sources become the list fppd starts them from, with their settings checked', async ({ request }) => {
  // Only cheap sources are left enabled: fppd is told to start them.
  writeFile(SOURCES, { videoInputSources: [
    { id: 1, name: 'Bars', type: 'videotestsrc' },
    { id: 2, name: 'Cam', type: 'v4l2src', enabled: false, device: '/dev/video2', powerLineFrequency: 1,
      exposureMode: 'manual', exposureTime100us: 20000, dynamicFramerate: 1, width: 1280, height: 720, framerate: 30,
      audioEnabled: true },
    { id: 3, type: 'v4l2src', enabled: false, powerLineFrequency: 5, exposureMode: 'weird', exposureTime100us: 50, dynamicFramerate: 0 },
    { id: 4, name: 'Door', type: 'rtspsrc', enabled: false, uri: 'rtsp://cam.invalid/1' },
    { id: 5, name: 'No URI', type: 'rtspsrc' },
    { id: 6, name: 'Tube', type: 'urisrc', enabled: false, uri: 'https://example.invalid/v.mp4', bufferSec: '1.5' },
    { id: 7, name: 'No URI either', type: 'urisrc' },
    { id: 8, name: 'Net', type: 'rtpsrc', port: 80, enabled: true },
    { id: 9, name: 'Untyped' },
    { id: 10, name: 'Capture Card', type: 'hdmisrc' },
  ] });
  const r = await (await request.post('/api/pipewire/video/input-sources/apply')).json();
  expect(r).toMatchObject({ status: 'OK', message: '2 video input source(s) configured' });

  const base = (id: number, name: string, slug: string, type: string) => ({
    id, name, type, pipeWireNodeName: `fpp_video_src_${id}_${slug}`, enabled: true, width: 320, height: 240, framerate: 10,
    audioEnabled: false, audioPipeWireNodeName: `fpp_audio_src_${id}_${slug}`,
  });
  const expected = [
    { ...base(1, 'Bars', 'bars', 'videotestsrc'), pattern: 'smpte' },
    { ...base(2, 'Cam', 'cam', 'v4l2src'), enabled: false, width: 1280, height: 720, framerate: 30, audioEnabled: true,
      device: '/dev/video2', powerLineFrequency: 1, exposureMode: 'manual', exposureTime100us: -1, dynamicFramerate: 1 },
    { ...base(3, 'Source 3', 'source', 'v4l2src'), enabled: false,
      device: '/dev/video0', powerLineFrequency: -1, exposureMode: 'camera', exposureTime100us: 50, dynamicFramerate: 0 },
    { ...base(4, 'Door', 'door', 'rtspsrc'), enabled: false, uri: 'rtsp://cam.invalid/1', latency: 200 },
    { ...base(6, 'Tube', 'tube', 'urisrc'), enabled: false, uri: 'https://example.invalid/v.mp4', bufferSec: 1.5 },
    { ...base(8, 'Net', 'net', 'rtpsrc'), port: 5004, encoding: 'H264', multicastGroup: '' },
  ];
  expect(r.sources).toEqual(expected);
  expect(JSON.parse(readFile(SOURCES_GEN))).toEqual(expected);

  // The sources are saved with their node names; one with no type is left as it was.
  const saved = JSON.parse(readFile(SOURCES)).videoInputSources;
  expect(saved.map((s: { pipeWireNodeName?: string }) => s.pipeWireNodeName)).toEqual([
    'fpp_video_src_1_bars', 'fpp_video_src_2_cam', 'fpp_video_src_3_source', 'fpp_video_src_4_door',
    'fpp_video_src_5_no_uri', 'fpp_video_src_6_tube', 'fpp_video_src_7_no_uri_either', 'fpp_video_src_8_net',
    undefined, 'fpp_video_src_10_capture_card',
  ]);
});

test('with no video input sources, the list fppd reads is removed', async ({ request }) => {
  writeFile(SOURCES, { videoInputSources: [{ id: 1, name: 'Bars', type: 'videotestsrc', enabled: false }] });
  await request.post('/api/pipewire/video/input-sources/apply');
  expect(exists(SOURCES_GEN)).toBe(true);

  writeFile(SOURCES, { videoInputSources: [] });
  expect(await (await request.post('/api/pipewire/video/input-sources/apply')).json())
    .toEqual({ status: 'OK', message: 'Video input sources cleared' });
  expect(exists(SOURCES_GEN)).toBe(false);

  writeFile(SOURCES_GEN, []);
  inPlayer('rm', '-f', SOURCES);
  expect(await (await request.post('/api/pipewire/video/input-sources/apply')).json())
    .toEqual({ status: 'OK', message: 'No video input sources configured' });
  expect(exists(SOURCES_GEN)).toBe(false);
});
