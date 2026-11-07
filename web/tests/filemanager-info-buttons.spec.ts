import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { fseqV2 } from './fseq';
import { answerUpdateCheck } from './standin-http';
import { hasRealFfmpeg, ffmpeg, linkRealFfprobe, unlinkRealFfprobe } from './real-ffmpeg';

// The File Manager's Sequence Info and Video Info buttons (api/sequence/<name>/meta,
// fsequtils; api/media/<name>/meta, ffprobe or GStreamer's discoverer), and the
// duration a playlist gets for a sequence (api/media/<name>/duration, which
// reads the sequence's header in PHP).

test.skip(!container, 'writes sequences and videos inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const SEQ = `${MEDIA}/sequences`;
const VIDEOS = `${MEDIA}/videos`;
const P = 'fpp-tests-info';

const sh = (script: string) => inPlayer('sh', '-c', script);

// The FSEQ v1 layout get_sequence_file_info() was written for: a 28-byte
// header with a 16-bit step time, then the variable headers.  Vixen put the
// media name's length before it; xLights wrote its full path.
function fseqV1(o: { stepMs: number; channels: number; frames: number; media: string; vixen?: boolean }): Buffer {
  const name = Buffer.from(o.media, 'latin1');
  const body = o.vixen ? Buffer.concat([Buffer.from([name.length]), name]) : name;
  const v = Buffer.alloc(4);
  v.writeUInt16LE(4 + body.length, 0);
  v.write('mf', 2, 'latin1');
  const vars = Buffer.concat([v, body, Buffer.alloc(128)]); // the parser reads 128 bytes after the header
  const h = Buffer.alloc(28);
  h.write('FSEQ', 0, 'latin1');
  h.writeUInt16LE(28 + vars.length, 4);
  h.writeUInt8(0, 6);
  h.writeUInt8(1, 7);
  h.writeUInt16LE(28, 8);
  h.writeUInt32LE(o.channels, 10);
  h.writeUInt32LE(o.frames, 14);
  h.writeUInt16LE(o.stepMs, 18);
  h.writeUInt16LE(0, 20);
  h.writeUInt16LE(0, 22);
  h.writeUInt8(1, 24);
  h.writeUInt8(2, 25);
  return Buffer.concat([h, vars, Buffer.alloc(o.channels * o.frames)]);
}

test.beforeEach(async ({ page }) => {
  await answerUpdateCheck(page);
});
test.afterEach(() => {
  unlinkRealFfprobe();
  sh(`rm -f ${SEQ}/${P}* '${SEQ}/${P} #1.fseq' ${VIDEOS}/${P}*`);
});

function row(page: Page, table: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${esc}$`) }) });
}

async function sequenceInfo(page: Page, name: string) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
  await page.locator('#tab-sequence-tab').click();
  await row(page, 'Sequences', name).click();
  await page.locator('#tab-sequence input[value="Sequence Info"]').click();
  return page.locator('#SequenceViewer');
}

// The JSON a viewer shows (syntax-highlighted in a <pre>).
async function shownJson(dialog: ReturnType<Page['locator']>) {
  return JSON.parse(await dialog.locator('pre').innerText());
}

test("Sequence Info shows what fsequtils reads from the sequence's header", async ({ page }) => {
  const name = `${P}.fseq`;
  putFile(`${SEQ}/${name}`, fseqV2({ stepMs: 25, channels: 512, frames: 400, media: 'song.mp3' }));
  const dialog = await sequenceInfo(page, name);
  await expect(dialog.locator('.modal-title')).toHaveText('Sequence Info');
  const info = await shownJson(dialog);
  expect(info).toMatchObject({ Name: name, Version: '2.0', StepTime: 25, NumFrames: 400, ChannelCount: 512 });
  // A click while Bootstrap is still fading the dialog in is ignored.
  await expect(async () => {
    await dialog.locator('.modal-footer button', { hasText: 'Close' }).click();
    await expect(dialog).toBeHidden({ timeout: 1000 });
  }).toPass();
});

test('the sequence meta API answers for a name with # in it when the name is escaped', async ({ request }) => {
  // The control for the test below: only the URL the page builds is wrong.
  const name = `${P} #1.fseq`;
  putFile(`${SEQ}/${name}`, fseqV2({ stepMs: 50, channels: 3, frames: 10 }));
  const r = await request.get(`/api/sequence/${encodeURIComponent(name)}/meta`);
  expect(r.status()).toBe(200);
  expect((await r.json()).Name).toBe(name);
  // Cut at the #, as the page sends it, the name is one no sequence has.
  const cut = await request.get(`/api/sequence/${encodeURIComponent(`${P} `)}/meta`);
  expect(cut.ok(), `${cut.status()}`).toBe(false);
});

test('Sequence Info works for a sequence with # in its name', async ({ page }) => {
  // Known bug (~/FUTURE.md, fpp 49f2b29a0): GetSequenceInfo() and
  // GetVideoInfo() put the name into the URL as it is, so "#1.fseq" is cut
  // off at the # as a fragment, the API finds no such sequence,
  // and nothing opens.  Expected to fail until the name is encoded
  // (the test above is the control: escaped, the API answers).
  test.fail();
  const name = `${P} #1.fseq`;
  putFile(`${SEQ}/${name}`, fseqV2({ stepMs: 50, channels: 3, frames: 10 }));
  const dialog = await sequenceInfo(page, name);
  await expect(dialog).toBeVisible({ timeout: 5000 });
  expect((await shownJson(dialog)).Name).toBe(name);
});

test.describe('Video Info', () => {
  test.beforeAll(() => {
    test.skip(!hasRealFfmpeg(), 'needs the image ffmpeg to make a video (rebuild docker/web)');
  });

  async function videoInfo(page: Page, name: string) {
    await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
    await page.locator('#tab-video-tab').click();
    await row(page, 'Videos', name).click();
    await page.locator('#tab-video input[value="Video Info"]').click();
    const dialog = page.locator('#VideoViewer');
    await expect(dialog.locator('.modal-title')).toHaveText('Video Info');
    return dialog;
  }

  test("shows the video's length and its streams, from GStreamer when there is no ffprobe", async ({ page }) => {
    const name = `${P}-clip.mp4`;
    ffmpeg(`-f lavfi -i testsrc=size=160x120:rate=10:d=4 -f lavfi -i "aevalsrc=0.1*sin(2*PI*440*t):s=48000:d=4" ` +
      `-c:v mpeg4 -c:a aac -shortest '${VIDEOS}/${name}'`);
    const info = await shownJson(await videoInfo(page, name));
    expect(Number(info.format?.duration), JSON.stringify(info)).toBeGreaterThan(3.5);
    expect(Number(info.format.duration)).toBeLessThan(4.5);
    const kinds = (info.streams as any[]).map((s) => s.codec_type).sort();
    expect(kinds, JSON.stringify(info.streams)).toEqual(['audio', 'video']);
  });

  test('uses ffprobe when the player has it', async ({ page }) => {
    const name = `${P}-probe.mp4`;
    ffmpeg(`-f lavfi -i testsrc=size=160x120:rate=10:d=3 -c:v mpeg4 '${VIDEOS}/${name}'`);
    linkRealFfprobe();
    const info = await shownJson(await videoInfo(page, name));
    // What only ffprobe gives: the codec and the picture size.
    expect(info.streams?.[0], JSON.stringify(info)).toMatchObject({ codec_type: 'video', codec_name: 'mpeg4', width: 160, height: 120 });
    expect(Math.round(Number(info.format.duration))).toBe(3);
  });
});

test.describe("a sequence's duration (api/media/<name>/duration)", () => {
  const duration = async (request: any, name: string) => {
    const r = await request.get(`/api/media/${encodeURIComponent(name)}/duration`);
    return { status: r.status(), body: r.ok() ? await r.json() : await r.text() };
  };

  test('is its frames times its step time, for an xLights v1 and a Vixen v1 header alike', async ({ request }) => {
    putFile(`${SEQ}/${P}-xl.fseq`, fseqV1({ stepMs: 50, channels: 30, frames: 1200, media: 'C:\\Shows\\Music\\carol.mp3' }));
    putFile(`${SEQ}/${P}-vix.fseq`, fseqV1({ stepMs: 25, channels: 30, frames: 2000, media: 'carol.mp3', vixen: true }));
    expect(await duration(request, `${P}-xl.fseq`)).toEqual({ status: 200, body: { [`${P}-xl.fseq`]: { duration: 60 } } });
    expect(await duration(request, `${P}-vix.fseq`)).toEqual({ status: 200, body: { [`${P}-vix.fseq`]: { duration: 50 } } });
  });

  test('is right for the v2 sequences xLights writes now', async ({ request }) => {
    putFile(`${SEQ}/${P}-v2.fseq`, fseqV2({ stepMs: 25, channels: 300, frames: 4800, media: 'song.mp3' }));
    expect(await duration(request, `${P}-v2.fseq`)).toEqual({ status: 200, body: { [`${P}-v2.fseq`]: { duration: 120 } } });
  });

  test('is Not Found for a file that is nowhere', async ({ request }) => {
    const r = await duration(request, `${P}-missing.fseq`);
    expect(r.status).toBe(404);
    expect(r.body).toContain(`Not found: ${P}-missing.fseq`);
  });
});
