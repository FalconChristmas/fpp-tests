import { test, expect } from './fixtures';
import { createHash } from 'crypto';
import { container, docker, inPlayer } from './container';

// A File Manager upload goes to api/file/upload in chunks (FilePond, every
// file chunked).  The bytes of the last chunk are sent, and the progress
// reads 100%, before the server has written the chunk and answered, which on
// a slow SD card takes a while; the item then looked stuck at 100%.
//
// The test makes the server slow: PatchFile() stores each chunk under a
// lock per target file (/tmp/fpp-upload-<md5 of its path>.lock), and the
// test holds that lock from inside the player until it lets go.

test.skip(!container, 'holds the upload lock inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const RELEASE = '/tmp/fpp-tests-upload-release';

test('an upload whose last chunk is still being written reads "Saving to disk"', async ({ page }) => {
  // Regression: 9096da9dc.  Nothing relabelled the item between 100% sent
  // and the server's answer.
  const name = 'fpp-tests-saving.mp3';
  const target = inPlayer('realpath', `${MEDIA}/upload`).trim() + '/' + name;
  const lock = `/tmp/fpp-upload-${createHash('md5').update(target).digest('hex')}.lock`;
  inPlayer('rm', '-f', RELEASE);
  docker('exec', '-d', container, 'flock', lock, 'sh', '-c', `touch ${RELEASE}.held; while [ ! -e ${RELEASE} ]; do sleep 0.2; done; rm -f ${RELEASE}.held`);
  try {
    await expect.poll(() => inPlayer('sh', '-c', `test -e ${RELEASE}.held && echo yes || echo no`).trim()).toBe('yes');
    await page.goto('/filemanager.php');
    await page.locator('input.filepond--browser').setInputFiles({ name, mimeType: 'audio/mpeg', buffer: Buffer.alloc(256 * 1024, 1) });
    const status = page.locator('.filepond--item').filter({ hasText: name }).locator('.filepond--file-status-main');
    await expect(status).toHaveText('Saving to disk', { timeout: 15_000 });
    await page.waitForTimeout(1500);
    // The control: the server still hasn't answered.
    expect(inPlayer('sh', '-c', `test -e ${MEDIA}/music/${name} && echo yes || echo no`).trim()).toBe('no');
    await expect(status).toHaveText('Saving to disk');

    inPlayer('touch', RELEASE);
    await expect(status).toHaveText('Upload complete', { timeout: 30_000 });
    await expect.poll(() => inPlayer('sh', '-c', `test -e ${MEDIA}/music/${name} && echo yes || echo no`).trim()).toBe('yes');
  } finally {
    inPlayer('touch', RELEASE);
    // Let a held upload finish before cleaning up, or it lands afterwards.
    await expect(page.locator('.filepond--item').filter({ hasText: name }).locator('.filepond--file-status-main'))
      .toHaveText('Upload complete', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    inPlayer('sh', '-c', `rm -f ${MEDIA}/music/${name} ${MEDIA}/upload/${name}`);
  }
});
