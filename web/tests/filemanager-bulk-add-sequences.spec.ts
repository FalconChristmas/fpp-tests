import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { answerUpdateCheck } from './standin-http';
import { fseqV2 } from './fseq';

// Add To Playlist from the Sequences and Scripts tabs.  A sequence is paired
// with the song or video its own header names (the "mf" variable header: the
// path xLights had the audio at), found in the Music and Videos tabs by that
// file name, or by the same name ending .mp3, .MP3, .mp4 or .MP4; its length
// is its frames times its step time.  A script becomes a Run Script command.
// (filemanager-bulk-add.spec.ts: the Music tab, and Don't automatch.)

test.skip(!container, 'seeds sequences and media and reads the saved playlist inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const P = 'fpp-tests-bas';
const PLAYLIST = `${P}-list`;

const sh = (script: string) => inPlayer('sh', '-c', script);

let uiLevel = '0';

test.beforeEach(async ({ page, request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  // Basic level: no Don't automatch checkbox, so a saved one changes nothing.
  expect((await request.put('/api/settings/uiLevel', { data: '0' })).ok()).toBe(true);
  await answerUpdateCheck(page);
  const r = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, version: 3, repeat: 0, loopCount: 0, empty: true, desc: '', random: 0,
      leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: { total_duration: 0, total_items: 0 } },
  });
  expect(r.ok(), await r.text()).toBe(true);
});

test.afterEach(async ({ request }) => {
  sh(`rm -f ${MEDIA}/sequences/${P}-* ${MEDIA}/music/${P}-* ${MEDIA}/videos/${P}-* ${MEDIA}/scripts/${P}-* ` +
    `${MEDIA}/playlists/${PLAYLIST}.json`);
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

function row(page: Page, table: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${esc}$`) }) });
}

async function bulkAdd(page: Page, tab: string, table: string, files: string[]) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
  // The pairing reads the Music and Videos listings: wait for them too.
  await expect(page.locator('#tblMusic tbody tr').first()).toBeAttached();
  await page.locator(`#tab-${tab}-tab`).click();
  for (const [i, f] of files.entries()) await row(page, table, f).click({ modifiers: i ? ['ControlOrMeta'] : [] });
  await page.locator(`#tab-${tab} input[value="Add To Playlist"]`).click();
  const dialog = page.locator('#bulkAdd');
  await expect(dialog).toBeVisible();
  await dialog.locator('#bulkAddPlaylist').selectOption(PLAYLIST);
  return dialog;
}

const saved = () => JSON.parse(sh(`cat ${MEDIA}/playlists/${PLAYLIST}.json`));

test('each sequence is paired with the song or video its header names, and timed by its frames', async ({ page }) => {
  const seq = (n: string) => `${P}-${n}.fseq`;
  // Paired: the exact file named (from a Windows path) ...
  putFile(`${MEDIA}/sequences/${seq('exact')}`, fseqV2({ stepMs: 50, channels: 3, frames: 1200, media: `C:\\Shows\\Audio\\${P}-exact.wav` }));
  sh(`printf x > ${MEDIA}/music/${P}-exact.wav`);
  // ... the same name as an .MP3, when the .wav it was made with isn't here ...
  putFile(`${MEDIA}/sequences/${seq('upper')}`, fseqV2({ stepMs: 25, channels: 3, frames: 2400, media: `/home/me/${P}-upper.wav` }));
  sh(`printf x > ${MEDIA}/music/${P}-upper.MP3`);
  // ... and a video, as an .mp4.
  putFile(`${MEDIA}/sequences/${seq('film')}`, fseqV2({ stepMs: 50, channels: 3, frames: 200, media: `${P}-film.mov` }));
  sh(`printf x > ${MEDIA}/videos/${P}-film.mp4`);
  // Not paired: no media named, or one that isn't here under any of those names.
  putFile(`${MEDIA}/sequences/${seq('none')}`, fseqV2({ stepMs: 50, channels: 3, frames: 100 }));
  putFile(`${MEDIA}/sequences/${seq('gone')}`, fseqV2({ stepMs: 50, channels: 3, frames: 100, media: `${P}-gone.ogg` }));

  const names = ['exact', 'film', 'gone', 'none', 'upper'].map(seq);
  const dialog = await bulkAdd(page, 'sequence', 'Sequences', names);
  const rows = dialog.locator('#bulkAddList tr');
  await expect(rows).toHaveCount(5);
  await expect(dialog.locator('#bulkAddType')).toHaveText('Sequences');
  // No checkbox at the Basic level.
  await expect(dialog.locator('#bulkAddNoAutomatch')).toHaveCount(0);

  const shown = await rows.evaluateAll((trs) => trs.map((tr) => {
    const f = tr.querySelector('td.file')!, t = tr.querySelector('td.type')!;
    return { text: f.textContent, media: f.getAttribute('media'), duration: Number(f.getAttribute('duration')),
      etype: t.getAttribute('etype'), length: tr.querySelectorAll('td')[2].textContent };
  }));
  expect(shown).toEqual([
    { text: `${seq('exact')} (${P}-exact.wav)`, media: `${P}-exact.wav`, duration: 60, etype: 'both', length: '01m:00s' },
    { text: `${seq('film')} (${P}-film.mp4)`, media: `${P}-film.mp4`, duration: 10, etype: 'both', length: '00m:10s' },
    { text: seq('gone'), media: '', duration: 5, etype: 'sequence', length: expect.any(String) },
    { text: seq('none'), media: '', duration: 5, etype: 'sequence', length: expect.any(String) },
    { text: `${seq('upper')} (${P}-upper.MP3)`, media: `${P}-upper.MP3`, duration: 60, etype: 'both', length: expect.any(String) },
  ]);

  // Into the lead-in, and the playlist's totals with them.
  await dialog.locator('#bulkAddPlaylistSection').selectOption('leadIn');
  await dialog.locator('#bulkAddAddButton').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#jGrowl')).toContainText('Playlist updated');
  const pl = saved();
  expect(pl.mainPlaylist).toEqual([]);
  expect(pl.leadIn.map((e: any) => [e.type, e.sequenceName, e.mediaName, e.duration])).toEqual([
    ['both', seq('exact'), `${P}-exact.wav`, 60],
    ['both', seq('film'), `${P}-film.mp4`, 10],
    ['sequence', seq('gone'), undefined, 5],
    ['sequence', seq('none'), undefined, 5],
    ['both', seq('upper'), `${P}-upper.MP3`, 60],
  ]);
  expect(pl.empty).toBe(false);
  expect(pl.playlistInfo).toMatchObject({ total_items: 5, total_duration: 140 });
});

test('a script is added as a Run Script command, and Cancel adds nothing', async ({ page }) => {
  const script = `${P}-lights.sh`;
  sh(`printf '#!/bin/sh\\necho hi\\n' > ${MEDIA}/scripts/${script}`);
  let dialog = await bulkAdd(page, 'scripts', 'Scripts', [script]);
  const cell = dialog.locator('#bulkAddList td.type');
  await expect(cell).toHaveAttribute('etype', 'command');
  await expect(cell).toContainText('(Run Script)');
  // Nothing to pair, so no checkbox at any level.
  await expect(dialog.locator('#bulkAddNoAutomatch')).toHaveCount(0);

  await dialog.locator('#bulkAddCancelButton').click();
  await expect(dialog).toBeHidden();
  expect(saved().mainPlaylist).toEqual([]);

  dialog = await bulkAdd(page, 'scripts', 'Scripts', [script]);
  await dialog.locator('#bulkAddAddButton').click();
  await expect(page.locator('#jGrowl')).toContainText('Playlist updated');
  expect(saved().mainPlaylist).toEqual([
    expect.objectContaining({ type: 'command', command: 'Run Script', args: [script, '', ''], enabled: 1, playOnce: 0 }),
  ]);
});
