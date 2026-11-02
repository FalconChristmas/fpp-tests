import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The File Manager's FilePond uploads in 64 MB chunks, in every browser.
//
// Regression: 7d4da1d83 ("update FilePond to 4.32.12, drop the Safari chunk
// workaround").  Safari (told apart by window.safari) was given 512 MB chunks,
// so a file under 512 MB went up as one request: nothing of it could be
// resumed, and the server spooled the whole thing at once.  The page here is
// Chromium told it is Safari the same way, and a 70 MB file has to arrive as
// two chunks, put back together byte for byte.
//
// Also 893850836: Safari stalls a request whose body is a slice of the picked
// file, so each chunk is read into memory (FileReader) before it is sent; the
// reads are counted here, as Chromium doesn't stall either way.

test.skip(!container, 'checks the uploaded file inside the run-web.sh container');

const MB = 1024 * 1024;

test('Safari uploads a 70 MB file in 64 MB chunks, and it arrives whole', async ({ page }) => {
  test.setTimeout(180_000);
  const name = 'fpp-tests-safari-chunks.mp3';
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fpp-tests-')), name);
  const data = Buffer.alloc(70 * MB);
  for (let i = 0; i < data.length; i += 4) data.writeUInt32LE((i * 2654435761) >>> 0, i);
  fs.writeFileSync(file, data);
  const sha = createHash('sha256').update(data).digest('hex');
  const offsets: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname.endsWith('/api/file/upload')) {
      offsets.push(r.headers()['upload-offset'] ?? '?');
    }
  });
  try {
    await page.addInitScript(() => {
      (window as any).safari = { pushNotification: {} };
      const reads: number[] = [];
      (window as any).chunkReads = reads;
      const read = FileReader.prototype.readAsArrayBuffer;
      FileReader.prototype.readAsArrayBuffer = function (b: Blob) {
        if (b.size >= 1024 * 1024) reads.push(b.size);
        return read.call(this, b);
      };
    });
    await page.goto('/filemanager.php');
    await page.waitForLoadState('load');
    // The control: the page sees a Safari.
    expect(await page.evaluate(() => (window as any).safari !== undefined)).toBe(true);
    await page.locator('input.filepond--browser').setInputFiles(file);
    // The receiving end: the chunks were put back together into the file.
    // (Not the item's label: until 4829c4e60 it could stay at "Saving to disk".)
    await expect.poll(() => inPlayer('sh', '-c', `sha256sum /home/fpp/media/music/${name} 2>/dev/null | cut -d' ' -f1`).trim(),
      { timeout: 150_000 }).toBe(sha);
    expect(offsets, 'the file did not go up in 64 MB chunks').toEqual(['0', String(64 * MB)]);
    expect(await page.evaluate(() => (window as any).chunkReads), 'the chunks were not read into memory first').toEqual([64 * MB, 6 * MB]);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    inPlayer('sh', '-c', `rm -f /home/fpp/media/music/${name} /home/fpp/media/upload/${name}*`);
  }
});
