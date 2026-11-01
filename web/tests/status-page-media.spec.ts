import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The status page's playlist picker lists the media files too, and picking
// one starts it as a playlist of its own (index.php, PopulatePlaylists(true)).

test.skip(!container, 'seeds files inside the run-web.sh container');

const NAME = 'fpp-tests-status-pick.wav';
const PATH = `/home/fpp/media/music/${NAME}`;

// A silent mono 8 kHz 8-bit WAV of `seconds`.
function wav(seconds: number): Buffer {
  const n = 8000 * seconds;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 128)]);
}

test.beforeEach(() => putFile(PATH, wav(60)));
test.afterEach(async ({ request }) => {
  await request.post('/api/playlists/stop');
  inPlayer('rm', '-f', PATH);
});

test('a media file picked on the status page is listed under Media and starts as a playlist', async ({ page, request }) => {
  // Regression: f8369608d.  The picker offered playlists and sequences only,
  // so a song could not be played from the status page without a playlist
  // made for it; the fppd half (any media name is a playlist) is
  // scenarios/test_playlist_direct_media.py.
  await page.goto('/index.php');
  const select = page.locator('#playlistSelect');
  await expect(select.locator(`optgroup[label="Media"] option[value="${NAME}"]`)).toHaveCount(1);
  await select.selectOption(NAME);
  const started = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/command' && r.request().method() === 'POST');
  await page.locator('[onclick="StartPlaylistNow();"]').first().click();
  expect((await started).ok()).toBe(true);
  // fppd took it: the file's own name is the playlist it reports.
  await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).current_playlist?.playlist,
    { timeout: 10_000, intervals: [100] }).toBe(NAME);
});
