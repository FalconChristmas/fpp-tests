import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';

// Listen (Music) and View (Videos) in the File Manager play the file in a
// dialog on the page, served by api/file/<dir>/<name>?play=1 with HTTP range
// support.  Regression: e178608b1 (#3146).  Listen opened that URL in a new
// tab, where Chromium's media document never starts under the response's
// "Content-Security-Policy: sandbox", and the handler had no range support,
// so a seek snapped back to the start.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const SONG = 'fpp-tests-listen.wav';
const SECONDS = 30;

// A 30 s, 8 kHz mono 16-bit sine: a format every browser decodes, built here
// so the player needs no encoder.
function wav(): Buffer {
  const rate = 8000;
  const samples = rate * SECONDS;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  }
  return buf;
}

const SONG_BYTES = wav();

function putInPlayer(dest: string, data: Buffer | string) {
  // Piped in: docker cp doesn't follow the media directory's symlink.
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'cat > "$1"', 'sh', dest], { input: data, stdio: ['pipe', 'ignore', 'pipe'] });
}

function rmInPlayer(...files: string[]) {
  inPlayer('rm', '-f', ...files);
}

async function openTab(page: Page, tab: string, table: string) {
  await page.goto(`/filemanager.php#tab-${tab}`);
  await page.waitForLoadState('load');
  await page.locator(`#tab-${tab}-tab`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
  await expect(page.locator(`#tbl${table} tbody tr`).first()).toBeVisible();
}

function row(page: Page, table: string, name: string) {
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

const dialog = (page: Page) => page.locator('#playInBrowserDialog');

test.describe('Listen', () => {
  test.beforeEach(() => putInPlayer(`${MEDIA}/music/${SONG}`, SONG_BYTES));
  test.afterEach(() => rmInPlayer(`${MEDIA}/music/${SONG}`));

  test('Listen plays the song in a dialog on the page, and seeking works', async ({ page }) => {
    await openTab(page, 'audio', 'Music');
    await row(page, 'Music', SONG).click();
    // No new tab: the old Listen was window.open().
    let popup = false;
    page.context().on('page', () => (popup = true));
    await page.locator('#btnPlayMusicInBrowser').click();

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('.modal-title')).toHaveText(SONG);
    const audio = dialog(page).locator('audio');
    await expect(audio).toHaveCount(1);
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    expect(await audio.evaluate((a: HTMLAudioElement) => Math.round(a.duration))).toBe(SECONDS);

    await audio.evaluate((a: HTMLAudioElement) => {
      a.pause();
      a.currentTime = 20;
    });
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => !a.seeking && a.currentTime >= 19.5)).toBe(true);
    expect(popup, 'Listen opened a new tab').toBe(false);

    // Closing the dialog stops playback and drops the download.
    await dialog(page).locator('.modal-footer button', { hasText: 'Close' }).click();
    await expect(dialog(page)).toBeHidden();
    expect(await audio.evaluate((a: HTMLAudioElement) => a.paused && !a.hasAttribute('src'))).toBe(true);
  });

  test('a single range is served as 206 with exactly those bytes', async ({ request }) => {
    const url = `/api/file/Music/${SONG}?play=1`;
    const r = await request.get(url, { headers: { Range: 'bytes=1000-1999' } });
    expect(r.status()).toBe(206);
    expect(r.headers()['accept-ranges']).toBe('bytes');
    expect(r.headers()['content-range']).toBe(`bytes 1000-1999/${SONG_BYTES.length}`);
    expect(r.headers()['content-type']).toBe('audio/wav');
    expect(Buffer.compare(await r.body(), SONG_BYTES.subarray(1000, 2000))).toBe(0);

    const suffix = await request.get(url, { headers: { Range: 'bytes=-500' } });
    expect(suffix.status()).toBe(206);
    expect(Buffer.compare(await suffix.body(), SONG_BYTES.subarray(SONG_BYTES.length - 500))).toBe(0);

    const past = await request.get(url, { headers: { Range: `bytes=${SONG_BYTES.length}-` } });
    expect(past.status()).toBe(416);
    expect(past.headers()['content-range']).toBe(`bytes */${SONG_BYTES.length}`);

    const whole = await request.get(url);
    expect(whole.status()).toBe(200);
    expect(Buffer.compare(await whole.body(), SONG_BYTES)).toBe(0);
  });

  test('a range reply keeps its Content-Length through Apache', async ({ request }) => {
    // Regression: 0411a2209.  Apache 2.4.59+ drops the
    // Content-Length of a FastCGI reply unless ap_trust_cgilike_cl is set,
    // so every 206 went out chunked; Safari and iOS won't play one.
    const url = `/api/file/Music/${SONG}?play=1`;
    const r = await request.get(url, { headers: { Range: 'bytes=1000-1999' } });
    expect(r.status()).toBe(206);
    expect(r.headers()['content-length']).toBe('1000');
    expect(r.headers()['transfer-encoding']).toBeUndefined();
    const head = await request.head(url);
    expect(head.headers()['content-length']).toBe(String(SONG_BYTES.length));
  });

  test('a range whose last byte is before its first is ignored, not refused', async ({ request }) => {
    // Regression: 0411a2209.  RFC 9110: an invalid range is
    // ignored and the whole file sent; bytes=500-100 got a 416.
    const r = await request.get(`/api/file/Music/${SONG}?play=1`, { headers: { Range: 'bytes=500-100' } });
    expect(r.status()).toBe(200);
    expect(Buffer.compare(await r.body(), SONG_BYTES)).toBe(0);
  });

  test('the file carries validators, and an If-Range for another version gets the whole file', async ({ request }) => {
    // Regression: 0411a2209.  A 206 carried no ETag or
    // Last-Modified and If-Range was ignored, so a song replaced while it
    // played had bytes of the new file spliced onto the old one.
    const url = `/api/file/Music/${SONG}?play=1`;
    // Out of the one-second window in which the validator is a content hash.
    inPlayer('touch', '-d', '@1700000000', `${MEDIA}/music/${SONG}`);
    const first = await request.get(url, { headers: { Range: 'bytes=0-99' } });
    const etag = first.headers()['etag'];
    const lastModified = first.headers()['last-modified'];
    expect(etag).toMatch(/^".+"$/);
    expect(lastModified).toBeTruthy();

    const same = await request.get(url, { headers: { Range: 'bytes=100-199', 'If-Range': etag } });
    expect(same.status()).toBe(206);
    expect(Buffer.compare(await same.body(), SONG_BYTES.subarray(100, 200))).toBe(0);
    const sameDate = await request.get(url, { headers: { Range: 'bytes=100-199', 'If-Range': lastModified } });
    expect(sameDate.status()).toBe(206);

    const other = await request.get(url, { headers: { Range: 'bytes=100-199', 'If-Range': '"not-this-file"' } });
    expect(other.status()).toBe(200);
    expect(Buffer.compare(await other.body(), SONG_BYTES)).toBe(0);
  });

  test('a song deleted after the list loaded says it could not be loaded, not that the browser cannot play it', async ({ page }) => {
    // Regression: 0411a2209.  Every media error read
    // "This browser can't play this file", a 404 included.
    await openTab(page, 'audio', 'Music');
    await row(page, 'Music', SONG).click();
    rmInPlayer(`${MEDIA}/music/${SONG}`);
    await page.locator('#btnPlayMusicInBrowser').click();
    await expect(dialog(page)).toContainText('could not be loaded from FPP (HTTP 404)');
    await expect(dialog(page)).not.toContainText("can't play");
  });
});

test('an .m4p is served for playback as audio/mp4', async ({ request }) => {
  // Regression: 0411a2209.  The File Manager lists .m4p as
  // audio, but it went out as application/octet-stream with nosniff.
  const file = `${MEDIA}/music/fpp-tests-listen.m4p`;
  putInPlayer(file, 'x');
  try {
    const r = await request.get('/api/file/Music/fpp-tests-listen.m4p?play=1');
    expect(r.headers()['content-type']).toBe('audio/mp4');
  } finally {
    rmInPlayer(file);
  }
});

test('the player dialog is sized for what it plays, whichever was opened first', async ({ page }) => {
  // Regression: 0411a2209.  DoModalDialog applied a
  // dialog's class only when it first created it, so View after Listen
  // played the video in the audio-sized dialog.
  const song = `${MEDIA}/music/${SONG}`;
  // Not a decodable video: the dialog offers a download instead.
  const video = `${MEDIA}/videos/fpp-tests-view.mp4`;
  putInPlayer(song, SONG_BYTES);
  putInPlayer(video, 'x');
  try {
    await openTab(page, 'audio', 'Music');
    await row(page, 'Music', SONG).click();
    await page.locator('#btnPlayMusicInBrowser').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveClass(/\bmodal-m\b/);
    await dialog(page).locator('.modal-footer button', { hasText: 'Close' }).click();
    await expect(dialog(page)).toBeHidden();

    await page.locator('#tab-video-tab').click();
    await expect(page.locator('#tab-video')).toBeVisible();
    await row(page, 'Videos', 'fpp-tests-view.mp4').click();
    await page.locator('#tab-video input[value="View"]').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('video')).toHaveCount(1);
    await expect(dialog(page)).toHaveClass(/\bmodal-lg\b/);
    await expect(dialog(page)).not.toHaveClass(/\bmodal-m\b/);
    await expect(dialog(page)).toContainText("This browser can't play this file");
    await expect(dialog(page).getByRole('link', { name: 'download it' })).toHaveAttribute('href', 'api/file/Videos/fpp-tests-view.mp4');
  } finally {
    rmInPlayer(song, video);
  }
});
