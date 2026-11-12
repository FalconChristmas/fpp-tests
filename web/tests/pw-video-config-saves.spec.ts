import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, readFile } from './settings-file';
import { usesPipewireConfig } from './pw-config-files';

// The three saves behind the PipeWire video pages, posted for real and read
// back from the player's config folder (www/api/controllers/pipewire.php):
//   POST /api/pipewire/video/groups    SavePipeWireVideoGroups
//   POST /api/pipewire/video/routing   SaveVideoRoutingMatrix
//   POST /api/pipewire/rtspoutputs     SaveRTSPOutputs
// Nothing is applied: fppd reads these files only when told to.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const GROUPS = 'pipewire-video-groups.json', RTSP = 'pipewire-rtsp-outputs.json';
const write = usesPipewireConfig(GROUPS, RTSP);
const path = (name: string) => `${MEDIA}/config/${name}`;
const stored = (name: string) => JSON.parse(readFile(path(name)));
const remove = (name: string) => inPlayer('rm', '-f', path(name));
// A body sent byte for byte: given a string that is not JSON, Playwright would
// send it as a JSON string.
const raw = (body: string) => ({ data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });

const wall = { id: 7, name: 'Wall', enabled: true, videoSource: 'fpp_video_src_3_cam', members: [{ type: 'hdmi', connector: 'HDMI-A-1' }] };
const porch = { id: 2, name: 'Porch', enabled: false, videoSource: '', members: [] };

test.describe('video output groups', () => {
  test('are stored as posted, and a group without an id gets the next one', async ({ request }) => {
    remove(GROUPS);
    const r = await request.post('/api/pipewire/video/groups', { data: { videoOutputGroups: [
      wall, { name: 'New one', enabled: true, members: [] }, porch, { id: 0, name: 'New two' },
    ] } });
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ status: 'OK', message: 'Video output groups saved' });
    const groups = stored(GROUPS).videoOutputGroups;
    expect(groups).toEqual([
      wall, { name: 'New one', enabled: true, members: [], id: 8 }, porch, { id: 9, name: 'New two' },
    ]);
    expect((await (await request.get('/api/pipewire/video/groups')).json()).videoOutputGroups).toEqual(groups);
  });

  test('a body that is not a list of groups is refused and the saved groups stay', async ({ request }) => {
    write(GROUPS, { videoOutputGroups: [wall] });
    const before = readFile(path(GROUPS));
    for (const [body, message] of [
      ['{"videoOutputGroups": [', 'Invalid JSON'],
      ['{"groups": []}', "Missing 'videoOutputGroups' array"],
      ['{"videoOutputGroups": "all"}', "Missing 'videoOutputGroups' array"],
    ]) {
      const r = await request.post('/api/pipewire/video/groups', raw(body));
      expect(r.status(), body).toBe(400);
      expect(await r.json(), body).toEqual({ status: 'ERROR', message });
      expect(readFile(path(GROUPS)), body).toBe(before);
    }
  });

  test('a group that is not an object is refused, not stored', async ({ request }) => {
    test.fail(true, 'the id pass indexes each element unchecked: a PHP fatal with a 200 (FUTURE.md)');
    write(GROUPS, { videoOutputGroups: [wall] });
    const before = readFile(path(GROUPS));
    const r = await request.post('/api/pipewire/video/groups', { data: { videoOutputGroups: [porch, 'Wall', 5] } });
    const text = await r.text();
    expect(text).not.toContain('Fatal error');
    expect(r.status(), text.slice(0, 200)).toBe(400);
    expect(readFile(path(GROUPS))).toBe(before);
  });

  test('two groups with one id are not stored as they are', async ({ request }) => {
    test.fail(true, 'ids are only filled in when missing, never compared (FUTURE.md)');
    // The id is what the routing save, the playlist entries and fppd's node
    // names go by.
    write(GROUPS, { videoOutputGroups: [wall] });
    const r = await request.post('/api/pipewire/video/groups', { data: { videoOutputGroups: [wall, { ...porch, id: 7 }] } });
    const ids = stored(GROUPS).videoOutputGroups.map((g: any) => g.id);
    expect(r.status() >= 400 || new Set(ids).size === ids.length, `stored ids ${ids} (answer ${r.status()})`).toBe(true);
  });
});

test.describe('video routing', () => {
  test('sets the source of the groups it names and leaves everything else as saved', async ({ request }) => {
    write(GROUPS, { somethingElse: 'kept', videoOutputGroups: [wall, porch, { id: 9, name: 'Garage', enabled: true, videoSource: 'old' }] });
    const r = await request.post('/api/pipewire/video/routing', { data: { assignments: [
      { groupId: 7, videoSource: 'fpp_video_src_4_roof' },
      { groupId: 9 },                                    // no source: cleared
      { groupId: 41, videoSource: 'fpp_video_src_4_roof' }, // no such group
    ] } });
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ status: 'OK', message: '2 video group(s) updated' });
    expect(stored(GROUPS)).toEqual({ somethingElse: 'kept', videoOutputGroups: [
      { ...wall, videoSource: 'fpp_video_src_4_roof' }, porch, { id: 9, name: 'Garage', enabled: true, videoSource: '' },
    ] });
  });

  test('is refused without assignments, or with no groups saved to route', async ({ request }) => {
    write(GROUPS, { videoOutputGroups: [wall] });
    const before = readFile(path(GROUPS));
    for (const body of ['{"assign": []}', '{"assignments": "x"}', 'nonsense']) {
      const r = await request.post('/api/pipewire/video/routing', raw(body));
      expect(r.status(), body).toBe(400);
      expect(await r.json(), body).toEqual({ status: 'error', message: 'Missing assignments array' });
    }
    expect(readFile(path(GROUPS))).toBe(before);

    write(GROUPS, { outputs: [] });
    let r = await request.post('/api/pipewire/video/routing', { data: { assignments: [{ groupId: 7, videoSource: 'x' }] } });
    expect(await r.json()).toEqual({ status: 'error', message: 'Invalid video groups config' });
    expect(stored(GROUPS)).toEqual({ outputs: [] });

    remove(GROUPS);
    r = await request.post('/api/pipewire/video/routing', { data: { assignments: [{ groupId: 7, videoSource: 'x' }] } });
    expect(await r.json()).toEqual({ status: 'error', message: 'No video output groups configured' });
    expect(exists(path(GROUPS)), 'a groups file was made').toBe(false);
  });

  test('an assignment that is not an object, or a source that is not a name, is refused', async ({ request }) => {
    test.fail(true, 'assignments are indexed unchecked: a PHP fatal with a 200 (FUTURE.md)');
    write(GROUPS, { videoOutputGroups: [wall] });
    const before = readFile(path(GROUPS));
    for (const assignments of [['7'], [{ groupId: 7, videoSource: { node: 'x' } }], [{ videoSource: 'x' }]]) {
      const r = await request.post('/api/pipewire/video/routing', { data: { assignments } });
      const text = await r.text();
      expect(text, JSON.stringify(assignments)).not.toContain('Fatal error');
      expect(readFile(path(GROUPS)), `${JSON.stringify(assignments)} changed the file (answer ${r.status()} ${text.slice(0, 120)})`).toBe(before);
      expect(r.status(), JSON.stringify(assignments)).toBe(400);
    }
  });
});

test.describe('RTSP server settings', () => {
  test('are stored, with a port or latency out of range put back to the default', async ({ request }) => {
    remove(RTSP);
    expect(await (await request.get('/api/pipewire/rtspoutputs')).json()).toEqual({ enabled: false, port: 8554 });

    let r = await request.post('/api/pipewire/rtspoutputs', { data: { enabled: true, port: 9000, latencyMs: 250, mounts: [{ path: '/x' }], extra: 1 } });
    expect(await r.json()).toEqual({ status: 'OK' });
    // Only the three settings are kept.
    expect(stored(RTSP)).toEqual({ enabled: true, port: 9000, latencyMs: 250 });
    expect(await (await request.get('/api/pipewire/rtspoutputs')).json()).toEqual({ enabled: true, port: 9000, latencyMs: 250 });

    for (const [sent, kept] of [
      [{ enabled: 1, port: 80, latencyMs: -1 }, { enabled: true, port: 8554, latencyMs: 40 }],
      [{ enabled: 0, port: 70000, latencyMs: 5001 }, { enabled: false, port: 8554, latencyMs: 40 }],
      [{ port: 1024, latencyMs: 0 }, { enabled: false, port: 1024, latencyMs: 0 }],
      [{ enabled: true, port: 65535, latencyMs: 5000 }, { enabled: true, port: 65535, latencyMs: 5000 }],
      [{ enabled: true }, { enabled: true, port: 8554, latencyMs: 40 }],
    ] as const) {
      r = await request.post('/api/pipewire/rtspoutputs', { data: sent });
      expect(r.status(), JSON.stringify(sent)).toBe(200);
      expect(stored(RTSP), JSON.stringify(sent)).toEqual(kept);
    }

    // A file from before the mounts moved to the groups: they are not handed out.
    write(RTSP, { enabled: true, port: 8554, mounts: [{ path: '/old' }] });
    expect(await (await request.get('/api/pipewire/rtspoutputs')).json()).toEqual({ enabled: true, port: 8554 });
  });

  test('a body that is not JSON is refused and the saved settings stay', async ({ request }) => {
    write(RTSP, { enabled: true, port: 9000, latencyMs: 250 });
    const before = readFile(path(RTSP));
    const r = await request.post('/api/pipewire/rtspoutputs', raw('{"enabled": tru'));
    expect(r.status()).toBe(400);
    expect(await r.json()).toEqual({ status: 'ERROR', message: 'Invalid JSON' });
    expect(readFile(path(RTSP))).toBe(before);
  });

  test('a body that is not a settings object does not switch the server off', async ({ request }) => {
    test.fail(true, 'any JSON value is taken as settings, so the defaults (disabled) are written (FUTURE.md)');
    write(RTSP, { enabled: true, port: 9000, latencyMs: 250 });
    const before = readFile(path(RTSP));
    for (const body of ['[]', '"on"', '7']) {
      const r = await request.post('/api/pipewire/rtspoutputs', raw(body));
      const text = await r.text();
      expect(text, body).not.toContain('Fatal error');
      expect(readFile(path(RTSP)), `${body} replaced the settings (answer ${r.status()})`).toBe(before);
      expect(r.status(), body).toBe(400);
    }
  });
});
