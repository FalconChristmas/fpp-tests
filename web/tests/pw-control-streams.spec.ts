import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// GET /api/pipewire/control/streams: the five media stream slots.  With nothing
// playing and no PipeWire graph, each is idle with no media.

const MUSIC = '/home/fpp/media/music/fpp-tests-pw.wav';
const PLAYLIST = 'fpp-tests-pw';

test('idle, it lists the five slots with their node names', async ({ request }) => {
  const body = await (await request.get('/api/pipewire/control/streams')).json();
  expect(body.status).toBe('OK');
  expect(body.streams).toEqual([1, 2, 3, 4, 5].map((slot) => ({
    slot, nodeName: `fppd_stream_${slot}`, status: 'idle', mediaFilename: '',
  })));
});

test.describe('in the player', () => {
  test.skip(!container, 'plays a file and reads fppd inside the container');

  test('a playlist playing media shows in slot 1, with its times', async ({ request }) => {
    // Regression: 86685958b. The route asked fppd for /api/fppd/status, a 404 on fppd's own
    // server, and read media_filename, which a playing playlist doesn't report.
    // So slot 1 never had a file name or times.
    inPlayer('php', '-r', `$n = 44100 * 2 * 60; file_put_contents('${MUSIC}', 'RIFF' . pack('V', 36 + $n) . 'WAVEfmt ' . pack('VvvVVvv', 16, 1, 1, 44100, 88200, 2, 16) . 'data' . pack('V', $n) . str_repeat("\\0", $n));`);
    try {
      const saved = await request.post(`/api/playlist/${PLAYLIST}`, { data: {
        name: PLAYLIST, version: 3, repeat: 0, loopCount: 0, empty: false, desc: '',
        leadIn: [], leadOut: [],
        mainPlaylist: [{ type: 'media', enabled: 1, playOnce: 0, mediaName: 'fpp-tests-pw.wav', videoOut: '--Default--' }],
      } });
      expect(saved.ok(), await saved.text()).toBe(true);
      const started = await request.post('/api/command', { data: { command: 'Start Playlist', args: [PLAYLIST, 'false', 'false'] } });
      expect(started.ok(), await started.text()).toBe(true);

      let slot: any;
      await expect.poll(async () => {
        slot = (await (await request.get('/api/pipewire/control/streams')).json()).streams[0];
        return slot.mediaFilename;
      }, { message: 'slot 1 names the file', timeout: 15000 }).toBe('fpp-tests-pw.wav');
      expect(slot.status).toBe('playing');
      expect(typeof slot.secondsElapsed).toBe('number');
      expect(slot.secondsRemaining).toBeGreaterThan(0);
    } finally {
      await request.post('/api/command', { data: { command: 'Stop Now', args: [] } });
      await request.delete(`/api/playlist/${PLAYLIST}`);
      inPlayer('rm', '-f', MUSIC);
    }
  });

  test('setting slot 1 changes fppd\'s volume', async ({ request }) => {
    // Regression: 86685958b. The route posted to /api/command, a 404 on fppd's own server,
    // ignored the answer, and said applied: true with the volume unchanged.
    const restore = snapshotSettings();
    const before = (await (await request.get('/api/fppd/status')).json()).volume;
    const target = before === 37 ? 38 : 37;
    setSettingInFile('MediaBackend', 'pipewire');
    try {
      const r = await request.post('/api/pipewire/control/streams/1/volume', { data: { volume: target } });
      expect(r.ok(), await r.text()).toBe(true);
      expect(await r.json()).toMatchObject({ status: 'OK', applied: true, control: 'fppd', volume: target });
      await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).volume, { timeout: 5000 }).toBe(target);
    } finally {
      await request.post('/api/command', { data: { command: 'Volume Set', args: [String(before)] } });
      restore();
    }
  });
});
