import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// An Image entry may name a directory (a path ending in "/"): the player
// shows a different image from it each time the entry plays.  The playlist
// validator has to take such an entry as playable.

test.skip(!container, 'seeds a directory inside the run-web.sh container');

const NAME = 'fpp-tests-image-dir';
const DIR = '/home/fpp/media/images/fpp-tests-image-dir';

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
  inPlayer('rm', '-rf', DIR);
});

test('an Image entry naming a directory validates, a missing file does not', async ({ request }) => {
  // Regression: 051d8aee9.  Image entries had to name a file in the images
  // list, so a directory (path ending in "/") was refused as "Invalid Image"
  // and the playlist could not be used.
  inPlayer('sh', '-c', `mkdir -p ${DIR} && printf x > ${DIR}/a.png`);
  const issues = async (imagePath: string) => {
    const saved = await request.post(`/api/playlist/${NAME}`, {
      data: {
        name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
        mainPlaylist: [{ type: 'image', enabled: 1, playOnce: 0, imagePath, modelName: 'fpp-tests-model' }],
      },
    });
    expect(saved.ok(), `storing ${imagePath}: ${saved.status()}`).toBe(true);
    const all = await (await request.get('/api/playlists/validate')).json();
    const p = all.find((x: { name: unknown }) => String(x.name) === NAME);
    expect(p, JSON.stringify(all)).toBeTruthy();
    return p;
  };
  const dir = await issues(`${DIR}/`);
  expect(dir.valid, JSON.stringify(dir)).toBe(true);
  // The controls: a file there is fine, a name that is not there is not.
  const file = await issues(`${DIR}/a.png`);
  expect(file.valid, JSON.stringify(file)).toBe(true);
  const missing = await issues(`${DIR}/nothing.png`);
  expect(missing.valid, JSON.stringify(missing)).toBe(false);
  const gone = await issues(`${DIR}-gone/`);
  expect(gone.valid, JSON.stringify(gone)).toBe(false);
});
