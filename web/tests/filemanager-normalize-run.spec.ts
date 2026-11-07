import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { hasRealFfmpeg, linkRealFfmpeg, unlinkRealFfmpeg, tone, ffmpeg, REAL_FFMPEG } from './real-ffmpeg';

// Normalize, in the File Manager's Music and Videos tabs: run_normalize.php
// measures each selected file's loudness with ffmpeg's ebur128 filter and
// stores the gain fppd applies when it plays (config/media_gain.json); the
// files themselves are not changed.  The songs here are made with the real
// ffmpeg (real-ffmpeg.ts): sines of known level, so what they measure, and the
// gain that brings them to the chosen level, is known too.
// (normalize-file-ops.spec.ts: the entries following a rename, copy or delete.)

test.skip(!container, 'makes songs and runs ffmpeg inside the run-web.sh container');
test.describe.configure({ timeout: 120_000 });

const MEDIA = '/home/fpp/media';
const MUSIC = `${MEDIA}/music`;
const VIDEOS = `${MEDIA}/videos`;
const GAINS = `${MEDIA}/config/media_gain.json`;
const LOCK = `${MEDIA}/tmp/normalize.lock`;
const P = 'fpp-tests-nrun';

const sh = (script: string) => inPlayer('sh', '-c', script);

type Entry = { gainDb: number; size: number; lufs: number; truePeak: number; speakerLevel: number | null;
  target: number; match: string; measured: string };

function gains(): Record<string, Entry> {
  const t = sh(`cat ${GAINS} 2>/dev/null || echo '{}'`);
  return JSON.parse(t);
}

const size = (path: string) => Number(sh(`stat -c %s '${path}'`).trim());

let gainsBefore: string | null = null;

test.beforeAll(() => {
  test.skip(!hasRealFfmpeg(), 'this image has no ffmpeg in /opt/fpp-tests-ffmpeg (rebuild docker/web)');
});

test.beforeEach(() => {
  gainsBefore = sh(`test -f ${GAINS} && cat ${GAINS} || true`) || null;
  sh(`rm -f ${GAINS}`);
  linkRealFfmpeg();
});

test.afterEach(() => {
  unlinkRealFfmpeg();
  sh(`rm -f ${MUSIC}/${P}-* ${VIDEOS}/${P}-*; rm -f ${GAINS}`);
  if (gainsBefore !== null) sh(`printf '%s' '${Buffer.from(gainsBefore).toString('base64')}' | base64 -d > ${GAINS}`);
});

async function normalize(request: APIRequestContext, body: unknown) {
  const r = await request.post('/run_normalize.php', { data: body, timeout: 90_000 });
  return { status: r.status(), text: await r.text() };
}

function row(page: Page, table: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${esc}$`) }) });
}

// The Music tab with $files selected, and its Normalize dialog open.
async function openNormalize(page: Page, files: string[]) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-audio`);
  await page.locator('#tab-audio-tab').click();
  for (const [i, f] of files.entries()) {
    await row(page, 'Music', f).click({ modifiers: i ? ['ControlOrMeta'] : [] });
  }
  await page.locator('#btnNormalizeMusic').click();
  const dialog = page.locator('#normalizeOptions');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('two songs are measured and brought to the chosen loudness, and the choice is remembered', async ({ page }) => {
  const quiet = `${P}-quiet.mp3`, loud = `${P}-loud.mp3`;
  tone(`${MUSIC}/${quiet}`, -30, 10);
  tone(`${MUSIC}/${loud}`, -15, 10);

  let dialog = await openNormalize(page, [quiet, loud]);
  // The defaults, the first time: -18 LUFS, matched by show speakers.
  await expect(dialog.locator('#normalizeTarget')).toHaveValue('-18');
  await expect(dialog.locator('input[name=normalizeMatch][value=speakers]')).toBeChecked();
  await expect(dialog).toContainText('Makes the 2 selected song(s) play equally loud.');
  await dialog.locator('#normalizeTarget').selectOption('-20');
  await dialog.locator('input[name=normalizeMatch][value=lufs]').check();
  await dialog.getByRole('button', { name: 'Normalize', exact: true }).click();

  const progress = page.locator('#normalizeProgressText');
  await expect(progress).toHaveValue(/Normalize complete: 2 done, 0 failed\./, { timeout: 60_000 });
  const out = await progress.inputValue();
  expect(out).toContain('Measuring 2 file(s): matched by LUFS, -20.0 LUFS, peaks <= -1.5 dBTP');
  // In the table's order (by name), not the order they were picked in.
  expect(out).toMatch(/\[1\/2\] fpp-tests-nrun-loud\.mp3\n[^]*\[2\/2\] fpp-tests-nrun-quiet\.mp3\n/);
  expect(out).toContain('The files were not changed.');
  // The quiet song needs the most boost, so it limits how loud the set can go.
  // At +20 dB at most, -30 dBFS reaches about -10.5 LUFS: -14 is the
  // loudest of the dialog's levels that fits.
  expect(out).toMatch(new RegExp(`All 2 files can be normalized to -?[\\d.]+ LUFS without clipping \\(${quiet} sets the limit\\)\\. ` +
    'The loudest level in the dialog that fits is -14 LUFS\\.'));

  const g = gains();
  for (const [name, level] of [[quiet, -30], [loud, -15]] as const) {
    const e = g[name];
    expect(e, `an entry for ${name}: ${JSON.stringify(g)}`).toBeTruthy();
    expect(Math.abs(e.lufs - level), `${name} measured ${e.lufs} LUFS`).toBeLessThan(1.5);
    // Played at the gain, it reaches the target.
    expect(Math.abs(e.lufs + e.gainDb - -20), `${name}: ${e.lufs} + ${e.gainDb}`).toBeLessThanOrEqual(0.15);
    expect(e).toMatchObject({ target: -20, match: 'lufs', speakerLevel: null, size: size(`${MUSIC}/${name}`) });
    expect(e.truePeak).toBeLessThan(level + 1.5);
  }
  // The files were not touched.
  expect(sh(`${REAL_FFMPEG} -v error -i ${MUSIC}/${quiet} -f null - && echo decodes`).trim()).toBe('decodes');

  // Done: the progress dialog's button turns from Please Wait to Close (which
  // reloads the page), and the next Normalize starts with the level and
  // matching chosen this time.
  const close = page.locator('#normalizeProgressCloseButton');
  await expect(close).toBeEnabled();
  await expect(close).toHaveText('Close');
  await close.click();
  await page.waitForLoadState('load');
  dialog = await openNormalize(page, [quiet]);
  await expect(dialog.locator('#normalizeTarget')).toHaveValue('-20');
  await expect(dialog.locator('input[name=normalizeMatch][value=lufs]')).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('Remove Normalization takes the entries of the selected songs out, and says which had none', async ({ page }) => {
  const done = `${P}-done.mp3`, never = `${P}-never.mp3`, other = `${P}-other.mp3`;
  for (const n of [done, never, other]) sh(`printf abcd > ${MUSIC}/${n}`);
  const entry = { gainDb: -2, size: 4, lufs: -16, truePeak: -1, speakerLevel: null, target: -18, match: 'lufs', measured: '' };
  sh(`printf '%s' '${JSON.stringify({ [done]: entry, [other]: entry })}' > ${GAINS}`);

  const dialog = await openNormalize(page, [done, never]);
  await dialog.getByRole('button', { name: 'Remove Normalization' }).click();
  const progress = page.locator('#normalizeProgressText');
  await expect(progress).toHaveValue(/Remove complete: 1 done, 0 failed\./);
  const out = await progress.inputValue();
  expect(out).toContain(`${done}: normalization removed (plays as recorded)`);
  expect(out).toContain(`${never}: was not normalized`);
  expect(Object.keys(gains())).toEqual([other]);
  await expect(page.locator('.modal-title', { hasText: 'Remove Normalization' })).toBeVisible();
});

test('a song too quiet to reach the level without clipping is held back, and the run says how loud the set can go', async ({ request }) => {
  // -30 dBFS, but with clicks near full scale: turned up to -14 LUFS its
  // peaks would clip, so it is turned up only as far as the peak ceiling.
  const peaky = `${P}-peaky.mp3`;
  tone(`${MUSIC}/${peaky}`, -30, 10, { clicks: true });
  const { status, text } = await normalize(request, { files: [peaky], target: -14, peak: -1.5, match: 'lufs' });
  expect(status, text).toBe(200);
  const e = gains()[peaky];
  expect(e, text).toBeTruthy();
  expect(text).toContain('(held back by peaks)');
  // The gain stops where the true peak meets the ceiling.
  expect(Math.abs(e.truePeak + e.gainDb - -1.5), JSON.stringify(e)).toBeLessThanOrEqual(0.15);
  expect(e.lufs + e.gainDb).toBeLessThan(-14 - 5);
  expect(text).toContain('1 file(s) could not be turned up all the way without clipping, so they will play quieter than the rest.');
  expect(text).toMatch(/This file can be normalized to at most -[\d.]+ LUFS without clipping\. That is below the dialog's lowest level \(-23 LUFS\)\./);
});

test('a very quiet song is turned up by at most 20 dB', async ({ request }) => {
  // -36 dBFS needs +22 dB to reach -14 LUFS; at +20 it reaches about -16.5.
  const faint = `${P}-faint.mp3`;
  tone(`${MUSIC}/${faint}`, -36, 10);
  const { text } = await normalize(request, { files: [faint], target: -14, match: 'lufs' });
  expect(text).toContain('(limited to +20 dB)');
  expect(gains()[faint]?.gainDb, text).toBe(20);
  // Its reach is in the dialog's range: the loudest level that fits is named.
  expect(text).toMatch(/This file can be normalized to at most -1[67]\.\d LUFS without clipping\. The loudest level in the dialog that fits is -18 LUFS\./);
});

test('matching by show speakers measures the speaker level, and a song too short for it is matched by LUFS', async ({ request }) => {
  const song = `${P}-speakers.mp3`, short = `${P}-short.mp3`;
  tone(`${MUSIC}/${song}`, -20, 12);
  tone(`${MUSIC}/${short}`, -20, 3);
  const { text } = await normalize(request, { files: [song, short], target: -18, match: 'speakers' });
  expect(text).toContain('Normalize complete: 2 done, 0 failed.');
  expect(text).toContain('matched by show speakers, -18.0 LUFS');
  expect(text).toMatch(/measured -[\d.]+ LUFS, peak -[\d.]+ dBTP, speaker level -[\d.]+/);
  const g = gains();
  expect(g[song]).toMatchObject({ match: 'speakers', target: -18 });
  expect(typeof g[song].speakerLevel, JSON.stringify(g[song])).toBe('number');
  // A steady tone: within the 4 dB the speaker match may move it from LUFS.
  expect(Math.abs(g[song].lufs + g[song].gainDb - -18)).toBeLessThanOrEqual(4.05);
  expect(text).toContain('too short to judge on speakers -- matched by LUFS');
  expect(g[short]).toMatchObject({ match: 'lufs', speakerLevel: null });
});

test("a video's sound is measured under videos/, and a video without sound is skipped", async ({ request }) => {
  const withSound = `${P}-sound.mp4`, silentFilm = `${P}-mute.mp4`;
  ffmpeg(`-f lavfi -i testsrc=size=160x120:rate=10:d=6 -f lavfi -i "aevalsrc=0.1*sin(2*PI*997*t):s=48000:d=6" ` +
    `-c:v mpeg4 -c:a aac -shortest '${VIDEOS}/${withSound}'`);
  ffmpeg(`-f lavfi -i testsrc=size=160x120:rate=10:d=3 -c:v mpeg4 '${VIDEOS}/${silentFilm}'`);
  const { text } = await normalize(request, { files: [withSound, silentFilm], dir: 'Videos', target: -18, match: 'lufs' });
  expect(text).toContain('Normalize complete: 1 done, 1 without sound skipped, 0 failed.');
  expect(text).toContain(`[2/2] ${silentFilm}\n  skipped: no audio track`);
  const g = gains();
  expect(Object.keys(g).sort()).toEqual([`videos/${withSound}`]);
  expect(g[`videos/${withSound}`].size).toBe(size(`${VIDEOS}/${withSound}`));
});

test('a file that is missing, silent or not audio fails on its own, and a bad name is skipped', async ({ request }) => {
  const silent = `${P}-silent.mp3`, junk = `${P}-junk.mp3`;
  ffmpeg(`-f lavfi -i "aevalsrc=0|0:s=48000:d=5" '${MUSIC}/${silent}'`);
  sh(`printf 'not a song' > ${MUSIC}/${junk}`);
  const { text } = await normalize(request, {
    files: [`${P}-gone.mp3`, silent, junk, '../settings', '/etc/passwd', 'a\\b.mp3', ''],
    target: -18, match: 'lufs',
  });
  expect(text).toContain(`[1/3] ${P}-gone.mp3\n  FAILED: file not found`);
  expect(text).toContain(`[2/3] ${silent}\n  FAILED: silent or too short to measure`);
  expect(text).toMatch(new RegExp(`\\[3/3\\] ${junk}\\n  FAILED: measuring failed \\(.+\\)`));
  for (const bad of ['../settings', '/etc/passwd', 'a\\b.mp3']) expect(text).toContain(`Skipping invalid name: ${bad}`);
  expect(text).toContain('Normalize complete: 0 done, 3 failed.');
  // Nothing measured, nothing said about the set, and nothing written.
  expect(text).not.toContain('can be normalized to');
  expect(text).not.toContain('The files were not changed.');
  expect(gains()).toEqual({});
});

test('the request is checked: files are needed, and the level and ceiling must be in range', async ({ request }) => {
  // The page means these to be 400s, but DisableOutputBuffering() has sent
  // the headers by then, so they come back 200 (~/FUTURE.md); the File
  // Manager shows only the text.
  for (const body of [{}, { files: [] }, { files: 'x.mp3' }]) {
    const r = await normalize(request, body);
    expect(r.text, JSON.stringify(body)).toBe('No files selected\n');
  }
  for (const body of [{ files: ['x.mp3'], target: -31 }, { files: ['x.mp3'], target: -4 }, { files: ['x.mp3'], peak: 0.5 },
    { files: ['x.mp3'], peak: -10 }]) {
    const r = await normalize(request, body);
    expect(r.text, JSON.stringify(body)).toBe('Target must be -30..-5 LUFS and the peak ceiling -9..0 dBTP\n');
  }
  expect(gains()).toEqual({});
});

test("run_mp3gain.php's body, a bare list of names, still works, with the defaults", async ({ request }) => {
  const song = `${P}-old.mp3`;
  tone(`${MUSIC}/${song}`, -20, 10);
  const { text } = await normalize(request, [song]);
  expect(text).toContain('Normalize complete: 1 done, 0 failed.');
  expect(text).toContain('-18.0 LUFS, peaks <= -1.5 dBTP');
  expect(gains()[song]).toMatchObject({ target: -18 });
});

test('a second normalize while one runs is turned away', async ({ request }) => {
  // The lock a run holds, held here by a shell for the length of the test.
  sh(`mkdir -p ${MEDIA}/tmp; (flock -x 9; sleep 30) 9>${LOCK} > /dev/null 2>&1 & echo $! > /tmp/${P}-lock.pid; sleep 0.5`);
  try {
    const { text } = await normalize(request, { files: ['x.mp3'] });
    expect(text).toContain('Another normalize is already running -- try again when it has finished.');
    expect(text).not.toContain('complete');
  } finally {
    sh(`pkill -P "$(cat /tmp/${P}-lock.pid)" sleep; kill "$(cat /tmp/${P}-lock.pid)" 2>/dev/null; rm -f /tmp/${P}-lock.pid`);
  }
});

test('without ffmpeg, a normalize says what to install, and Remove still works', async ({ request }) => {
  unlinkRealFfmpeg();
  const song = `${P}-noff.mp3`;
  sh(`printf abcd > ${MUSIC}/${song}`);
  const { text } = await normalize(request, { files: [song] });
  expect(text).toContain('ffmpeg with the ebur128 filter is required (sudo apt-get install ffmpeg).');
  expect(text).not.toContain('complete');
  const removed = await normalize(request, { files: [song], action: 'remove' });
  expect(removed.text).toContain(`${song}: was not normalized`);
  expect(removed.text).toContain('Remove complete: 0 done, 0 failed.');
});
