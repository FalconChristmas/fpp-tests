import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The File Manager's Add To Playlist (Bulk Add) dialog, and the playlist it
// saves.  An audio file with a same-named sequence is added as a
// Sequence+Media entry unless the dialog's "Don't automatch" checkbox is on.

test.skip(!container, 'seeds files and reads the saved playlist inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const PLAYLIST = 'fpp-tests-bulk-add';
const PAIR = 'fpp-tests-pair';
const SETTING = 'fileManagerNoAutomatchMusic';

function sh(cmd: string): string {
  return inPlayer('sh', '-c', cmd);
}

function savedPlaylist(): any {
  return JSON.parse(sh(`cat '${MEDIA}/playlists/${PLAYLIST}.json'`));
}

function savedSetting(): string | undefined {
  const m = sh(`grep '^${SETTING} ' ${MEDIA}/settings || true`).match(/=\s*"?([^"\n]*)"?/);
  return m ? m[1] : undefined;
}

function row(page: Page, table: string, name: string) {
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

let uiLevel = '0';

test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  sh(`echo x > '${MEDIA}/music/${PAIR}.mp3' && echo x > '${MEDIA}/sequences/${PAIR}.fseq'`);
  sh(`sed -i '/^${SETTING} /d' ${MEDIA}/settings`);
  // An empty playlist, the way the Playlists page's Add makes one.
  const r = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, version: 3, repeat: 0, loopCount: 0, empty: true, desc: '', random: 0,
      leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: { total_duration: 0, total_items: 0 } },
  });
  expect(r.ok(), await r.text()).toBe(true);
});

test.afterEach(async ({ request }) => {
  sh(`rm -f '${MEDIA}/music/${PAIR}.mp3' '${MEDIA}/sequences/${PAIR}.fseq' '${MEDIA}/playlists/${PLAYLIST}.json'`);
  sh(`sed -i '/^${SETTING} /d' ${MEDIA}/settings`);
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function setLevel(request: APIRequestContext, level: string) {
  expect((await request.put('/api/settings/uiLevel', { data: level })).ok()).toBe(true);
}

// The toasts shown since the page was opened, without their close button.
async function toasts(page: Page): Promise<string[]> {
  const all: string[] = await page.evaluate(() => (window as any).__fppTestsToasts);
  return all.map((t) => t.replace(/^\s*×\s*/, '').trim());
}

// Opens Bulk Add for the given audio files, with the test's playlist picked.
async function openBulkAdd(page: Page, files: string[]) {
  // A query that differs each time: a URL differing only in its #hash
  // doesn't load the page again.
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-audio`);
  await page.waitForLoadState('load');
  // Every toast shown, kept: they fade out after a few seconds.
  await page.evaluate(() => {
    const w = window as any;
    w.__fppTestsToasts = [];
    new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement && n.matches('.jGrowl-notification')) w.__fppTestsToasts.push(n.innerText);
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.locator('#tab-audio-tab').click();
  // The pairing reads the Sequences listing, so wait for it as well.
  await expect(page.locator('#tblSequences tbody tr').filter({ hasText: `${PAIR}.fseq` }).first()).toBeAttached();
  for (const [i, f] of files.entries()) {
    await row(page, 'Music', f).click({ modifiers: i ? ['ControlOrMeta'] : [] });
  }
  await page.locator('#tab-audio input[value="Add To Playlist"]').click();
  const dialog = page.locator('#bulkAdd');
  await expect(dialog).toBeVisible();
  await dialog.locator('#bulkAddPlaylist').selectOption(PLAYLIST);
  return dialog;
}

test("Don't automatch: the checkbox unpairs the list, says so, is remembered, and the playlist gets audio only", async ({ page, request }) => {
  // Feature: df0633d62 (the checkbox, its saved setting, re-pairing in place).
  // Regression: a37295116 (a bold "label:" like the rows above it, and no
  // "<raw key> Enabled" toast), d70ef8352 (the toast says "Automatch
  // Disabled"/"Automatch Enabled" instead).  f961cb7da put the raw-key toast
  // back; d70ef8352 replaced it.
  await setLevel(request, '1');
  let dialog = await openBulkAdd(page, [`${PAIR}.mp3`]);
  const list = dialog.locator('#bulkAddList tr');
  const box = dialog.locator('#bulkAddNoAutomatch');

  // Off by default: the song and its sequence are one Sequence+Media entry.
  await expect(box).not.toBeChecked();
  await expect(list).toHaveCount(1);
  await expect(list.locator('td.file')).toHaveText(`${PAIR}.fseq (${PAIR}.mp3)`);
  await expect(list.locator('td.type')).toHaveAttribute('etype', 'both');
  await expect.soft(dialog.locator('label[for="bulkAddNoAutomatch"] b'), 'a bold label, with a colon')
    .toHaveText("Don't automatch sequence files:");

  await box.check();
  await expect(list.locator('td.file')).toHaveText(`${PAIR}.mp3`);
  await expect(list.locator('td.type')).toHaveAttribute('etype', 'media');
  // The settings file is what the next opening reads.
  await expect.poll(savedSetting).toBe('1');
  await page.waitForTimeout(500);
  expect.soft(await toasts(page)).toContain('Automatch Disabled');
  expect.soft((await toasts(page)).filter((t) => t.includes(SETTING)), 'a toast naming the setting key').toEqual([]);

  await dialog.locator('#bulkAddAddButton').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#jGrowl')).toContainText('Playlist updated');
  const pl = savedPlaylist();
  expect(pl.mainPlaylist.map((e: any) => ({ type: e.type, sequenceName: e.sequenceName, mediaName: e.mediaName })))
    .toEqual([{ type: 'media', mediaName: `${PAIR}.mp3` }]);

  // Remembered: the next opening starts unpaired, and unticking pairs again.
  dialog = await openBulkAdd(page, [`${PAIR}.mp3`]);
  await expect(box).toBeChecked();
  await expect(list.locator('td.file')).toHaveText(`${PAIR}.mp3`);
  await box.uncheck();
  await expect(list.locator('td.file')).toHaveText(`${PAIR}.fseq (${PAIR}.mp3)`);
  await expect.poll(savedSetting).toBe('0');
  await page.waitForTimeout(500);
  expect.soft(await toasts(page)).toContain('Automatch Enabled');
  expect.soft((await toasts(page)).filter((t) => t.includes(SETTING)), 'a toast naming the setting key').toEqual([]);
});

test("Don't automatch is Advanced-level: hidden at Basic, where a saved value is ignored", async ({ page, request }) => {
  // Feature: df0633d62.
  await setLevel(request, '0');
  expect((await request.put(`/api/settings/${SETTING}`, { data: '1' })).ok()).toBe(true);
  const dialog = await openBulkAdd(page, [`${PAIR}.mp3`]);
  await expect(dialog.locator('#bulkAddNoAutomatch')).toHaveCount(0);
  await expect(dialog.locator('#bulkAddList td.file')).toHaveText(`${PAIR}.fseq (${PAIR}.mp3)`);
});

test('adding to a playlist made empty marks it not empty', async ({ page, request }) => {
  // Regression: caf3b03e4.  Bulk Add kept the playlist's "empty": true while
  // putting entries in it.
  // Also bcace96ba: the File Manager's Add To Playlist itself (before it,
  // files went into a playlist only from the playlist editor).
  await setLevel(request, '1');
  expect(savedPlaylist().empty, 'the control: the playlist starts out empty').toBe(true);
  const dialog = await openBulkAdd(page, [`${PAIR}.mp3`]);
  await dialog.locator('#bulkAddAddButton').click();
  await expect(page.locator('#jGrowl')).toContainText('Playlist updated');
  const pl = savedPlaylist();
  expect(pl.mainPlaylist).toHaveLength(1);
  expect(pl.empty).toBe(false);
});

test('a file name with quotes and markup is added as it is', async ({ page, request }) => {
  // Regression: 45d06fe8d.  The dialog's rows were built as HTML strings, the
  // name in a single-quoted attribute: an apostrophe ended the attribute, so
  // the playlist got the name cut short there.
  const odd = `fpp-tests it's "odd" <b>.mp3`;
  sh(`printf x > "${MEDIA}/music/fpp-tests it's \\"odd\\" <b>.mp3"`);
  try {
    await setLevel(request, '1');
    const dialog = await openBulkAdd(page, [odd]);
    await expect(dialog.locator('#bulkAddList td.file')).toHaveText(odd);
    await dialog.locator('#bulkAddAddButton').click();
    await expect(page.locator('#jGrowl')).toContainText('Playlist updated');
    expect(savedPlaylist().mainPlaylist.map((e: any) => e.mediaName)).toEqual([odd]);
  } finally {
    sh(`rm -f "${MEDIA}/music/fpp-tests it's \\"odd\\" <b>.mp3"`);
  }
});
