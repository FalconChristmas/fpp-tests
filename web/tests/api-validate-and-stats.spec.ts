import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

const MEDIA = '/home/fpp/media';
const PL = 'fpp-tests-validate';

function seed(rel: string) {
  inPlayer('sh', '-c', `mkdir -p "$(dirname ${MEDIA}/${rel})" && printf x > "${MEDIA}/${rel}"`);
}

test.describe('playlist validation', () => {
  test.skip(!container, 'seeds files inside the run-web.sh container');

  async function validate(request: any, main: object[]) {
    await request.delete(`/api/playlist/${PL}`);
    const p = await request.post(`/api/playlist/${PL}`, {
      data: { name: PL, version: 4, leadIn: [], mainPlaylist: main, leadOut: [], playlistInfo: {} } });
    expect(p.ok()).toBe(true);
    const all = await (await request.get('/api/playlists/validate')).json();
    return all.find((x: { name: string }) => x.name === PL);
  }
  test.afterEach(async ({ request }) => {
    await request.delete(`/api/playlist/${PL}`);
    inPlayer('rm', '-f', `${MEDIA}/music/fpp-tests-v.mp3`, `${MEDIA}/videos/fpp-tests-v.mp4`, `${MEDIA}/images/fpp-tests-v.png`);
  });

  test('an image, a video and a song that are not there are each flagged, and the ones that are not', async ({ request }) => {
    // f3a56c4f0 (images), aeea6993c (videos), 88bee8f93 (the music path).
    seed('music/fpp-tests-v.mp3');
    seed('videos/fpp-tests-v.mp4');
    seed('images/fpp-tests-v.png');
    const entry = (type: string, key: string, name: string) => ({ type, [key]: name, enabled: 1, playOnce: 0 });
    const missing = await validate(request, [
      entry('image', 'imagePath', 'fpp-tests-gone.png'),
      entry('media', 'mediaName', 'fpp-tests-gone.mp4'),
      entry('media', 'mediaName', 'fpp-tests-gone.mp3'),
    ]);
    expect(missing.valid).toBe(false);
    expect(missing.messages.join('\n')).toMatch(/Image 'fpp-tests-gone.png' not found/);
    expect(missing.messages.join('\n')).toMatch(/Media 'fpp-tests-gone.mp4' not found/);
    expect(missing.messages.join('\n')).toMatch(/Media 'fpp-tests-gone.mp3' not found/);

    const there = await validate(request, [
      entry('image', 'imagePath', 'fpp-tests-v.png'),
      entry('media', 'mediaName', 'fpp-tests-v.mp4'),
      entry('media', 'mediaName', 'fpp-tests-v.mp3'),
    ]);
    expect(there.messages, JSON.stringify(there)).toEqual([]);
    expect(there.valid).toBe(true);
  });
});

test('the usage statistics carry a timezone and use the corrected panel key', async ({ request }) => {
  // 0ea240633 (timezone section), 4e589d334 (output_pannel -> output_panel).
  const d = await (await request.get('/api/statistics/usage?force=1')).json();
  expect(d.timezone).toMatch(/^[+-]\d{4} \S+$/);
  expect(d).toHaveProperty('output_panel');
  expect(d).not.toHaveProperty('output_pannel');
});

test('a channel output file that is not one of the known names is refused', async ({ request }) => {
  // 4264ada4d: the answer names the file.
  const r = await request.get('/api/channel/output/not-a-channel-file');
  expect((await r.json()).status).toBe('Invalid file not-a-channel-file');
});

test('a plugin setting is written and read back through the API', async ({ request }) => {
  // d70aea014 (#945): GET/PUT /api/plugin/:name/settings/:key.
  const put = await request.put('/api/plugin/fpp-tests-plug/settings/Colour', { data: 'teal' });
  expect(put.ok()).toBe(true);
  try {
    const got = await request.get('/api/plugin/fpp-tests-plug/settings/Colour');
    expect(got.ok()).toBe(true);
    expect(await got.text()).toContain('teal');
    if (container) {
      expect(inPlayer('sh', '-c', `cat ${MEDIA}/config/plugin.fpp-tests-plug`)).toContain('Colour');
    }
  } finally {
    if (container) inPlayer('rm', '-f', `${MEDIA}/config/plugin.fpp-tests-plug`);
  }
});
