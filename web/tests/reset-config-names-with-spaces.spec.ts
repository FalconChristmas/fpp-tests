import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: 0bad40d60 ("Fix reset config with sequences/media with
// spaces").  Reset FPP Config removed each glob's files by piping `ls` to
// `xargs rm -rf`, which split a name on its spaces: "my song.mp3" became
// "my" and "song.mp3", neither of which exists, so a sequence, song or
// video with a space in its name (or in a folder's) survived the reset.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MEDIA = '/home/fpp/media';
const FILES = ['sequences/fpp tests seq.fseq', 'music/fpp tests song.mp3', 'videos/fpp tests dir/clip one.mp4'];

const present = (f: string) => inPlayer('sh', '-c', `test -e "${MEDIA}/${f}" && echo y || echo n`).trim() === 'y';

test('resetting the sequences and media areas removes names with spaces', async ({ request }) => {
  try {
    for (const f of FILES) {
      inPlayer('sh', '-c', `mkdir -p "$(dirname "${MEDIA}/${f}")" && echo x > "${MEDIA}/${f}"`);
    }
    expect(FILES.map(present)).toEqual([true, true, true]);
    const r = await request.get('/resetConfig.php?areas=sequences,media');
    expect(r.ok()).toBe(true);
    // The control: the reset ran over both areas.
    expect(await r.text()).toContain('Area: media');
    for (const f of FILES) {
      expect(present(f), `${f} was left behind`).toBe(false);
    }
    expect(present('videos/fpp tests dir'), 'the folder with a space was left behind').toBe(false);
  } finally {
    inPlayer('sh', '-c', `cd ${MEDIA} && rm -rf "sequences/fpp tests seq.fseq" "music/fpp tests song.mp3" "videos/fpp tests dir"`);
  }
});
