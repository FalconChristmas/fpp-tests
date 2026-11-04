import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// GET /api/file/<dir>/<name> takes three options: ?tail=N for the last lines,
// ?play=1 to be played rather than downloaded, and ?attach=1 to download an
// image that would otherwise be shown.

test.skip(!container, 'seeds files inside the run-web.sh container');

const UPLOADS = '/home/fpp/media/upload';
const IMAGES = '/home/fpp/media/images';
const TEXT = 'fpp-tests-options.txt';
const AUDIO = 'fpp-tests-options.mp3';
const IMAGE = 'fpp-tests-options.png';
const BODY = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';

test.beforeEach(() => {
  inPlayer('mkdir', '-p', UPLOADS, IMAGES);
  putFile(`${UPLOADS}/${TEXT}`, BODY);
  putFile(`${UPLOADS}/${AUDIO}`, 'not really audio');
  putFile(`${IMAGES}/${IMAGE}`, 'not really an image');
});
test.afterEach(() => inPlayer('rm', '-f', `${UPLOADS}/${TEXT}`, `${UPLOADS}/${AUDIO}`, `${IMAGES}/${IMAGE}`));

test('tail, play and attach each change what /api/file sends', async ({ request }) => {
  // Regression: b6ef39172 ("Move TailFle and GetFile API").  Soft, so each
  // option that stops working shows on its own line.
  const get = (path: string) => request.get(`/api/file/${path}`);

  let r = await get(`Uploads/${TEXT}`);
  expect.soft(await r.text(), 'with no options, the whole file').toBe(BODY);
  expect.soft(r.headers()['content-disposition'], 'with no options, a download').toContain(TEXT);

  r = await get(`Uploads/${TEXT}?tail=3`);
  expect.soft(await r.text(), 'tail=3').toBe('line 17\nline 18\nline 19\n');

  r = await get(`Uploads/${AUDIO}`);
  expect.soft(r.headers()['content-type'], 'not played: plain bytes').toContain('application/binary');
  r = await get(`Uploads/${AUDIO}?play=1`);
  expect.soft(r.headers()['content-type'], 'play=1').toContain('audio/mpeg');
  expect.soft(r.headers()['content-disposition'], 'play=1 is no download').toBeUndefined();

  r = await get(`Images/${IMAGE}`);
  expect.soft(r.headers()['content-type'], 'an image').toContain('image/png');
  expect.soft(r.headers()['content-disposition'], 'an image is shown').toBeUndefined();
  r = await get(`Images/${IMAGE}?attach=1`);
  expect.soft(r.headers()['content-disposition'], 'attach=1').toContain(IMAGE);
});
