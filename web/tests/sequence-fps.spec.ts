import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// api/files/Sequences/fps answers {name: fps} for every sequence, from the
// header's step time as fsequtils reads it (cached per name and size), and
// the File Manager fills its Sequences table's FPS column from it after the
// listing.  Two FSEQ v1 files are written into the player, at 50 ms and
// 25 ms steps.

test.skip(!container, 'writes sequences inside the run-web.sh container');

const SEQ = '/home/fpp/media/sequences';
const CACHE = '/home/fpp/media/config/sequence_fps.cache';

// An FSEQ v1 file: 28-byte header, no variable headers, `frames` frames of
// `channels` channels.
function fseqV1(stepMs: number, channels = 3, frames = 2): Buffer {
  const header = Buffer.alloc(28);
  header.write('PSEQ', 0, 'latin1');
  header.writeUInt16LE(28, 4); // channel data offset
  header.writeUInt8(0, 6); // minor
  header.writeUInt8(1, 7); // major
  header.writeUInt16LE(28, 8); // header length
  header.writeUInt32LE(channels, 10);
  header.writeUInt32LE(frames, 14);
  header.writeUInt8(stepMs, 18);
  header.writeUInt16LE(1, 22); // universe count, size (unused by v1 readers)
  header.writeUInt16LE(2, 24);
  return Buffer.concat([header, Buffer.alloc(channels * frames, 0x7f)]);
}

const FILES: [string, number, number][] = [
  ['fpp-tests-20fps.fseq', 50, 20],
  ['fpp-tests-40fps.fseq', 25, 40],
];

test('the fps endpoint and the FPS column give each sequence its frame rate', async ({ page, request }) => {
  // Feature: c22cc2113.
  inPlayer('rm', '-f', CACHE);
  for (const [name, step] of FILES) putFile(`${SEQ}/${name}`, fseqV1(step));
  try {
    // The control: fsequtils reads the step times the files were written with.
    for (const [name, step] of FILES) {
      expect(JSON.parse(inPlayer('/opt/fpp/src/fsequtils', '-j', `${SEQ}/${name}`)).StepTime).toBe(step);
    }

    const r = await request.get('/api/files/Sequences/fps');
    expect(r.ok()).toBe(true);
    const fps = await r.json();
    for (const [name, , want] of FILES) expect(fps[name], name).toBe(want);
    // And it was cached, so the next listing doesn't run fsequtils again.
    const cache = JSON.parse(inPlayer('cat', CACHE));
    for (const [name, , want] of FILES) expect(cache[name]?.fps, name).toBe(want);

    await page.goto('/filemanager.php');
    await page.locator('#tab-sequence-tab').click();
    for (const [name, , want] of FILES) {
      const row = page.locator('#tblSequences tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });
      await expect(row).toHaveCount(1);
      // The FPS column, by its header.
      const col = await page.locator('#tab-sequence .bootstrap-table .fixed-table-body thead th').evaluateAll(
        (ths) => ths.findIndex((th) => (th as HTMLElement).dataset.field === 'fps'));
      expect(col, 'the table has an FPS column').toBeGreaterThanOrEqual(0);
      await expect(row.locator('td').nth(col)).toHaveText(String(want));
    }
  } finally {
    inPlayer('rm', '-f', CACHE, ...FILES.map(([name]) => `${SEQ}/${name}`));
  }
});
