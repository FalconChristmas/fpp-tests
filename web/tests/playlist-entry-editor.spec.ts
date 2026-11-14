import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The playlist editor's entry modal (playlists.php, the drill-in editor):
// what it shows for an entry, and what it saves back.  Each test stores a
// playlist through the API, edits it on the page, and reads it back.

const NAME = 'fpp-tests-entry-editor';

async function storePlaylist(request: APIRequestContext, mainPlaylist: object[]) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok(), `storing ${NAME}: ${r.status()}`).toBe(true);
}

async function storedPlaylist(request: APIRequestContext) {
  return (await request.get(`/api/playlist/${NAME}`)).json();
}

async function openEditor(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function savePlaylist(page: Page) {
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
}

// Opens the New Entry modal and waits for Bootstrap's show transition to
// end: a hide asked for while the modal is still fading in is dropped, so
// an Add clicked that early adds the entry but leaves the modal open over
// the page.
async function openNewEntry(page: Page) {
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await page.locator('.playlistEntriesAddNewBtn').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
}

// The New Entry modal's Add: the entry goes into the list.
async function addEntry(page: Page) {
  const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  const before = await rows.count();
  await page.locator('.modal.show').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(rows).toHaveCount(before + 1);
}

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

test('choosing a .flac for a sequence and media entry picks the sequence of the same name', async ({ page, request }) => {
  // Feature: 3db38d7eb.  MediaChanged() strips the media extension to find the
  // matching sequence, and .flac was not one of those it knew.
  test.skip(!container, "puts files in the run-web.sh container's media");
  const base = 'fpp-tests-flac-match';
  const other = 'fpp-tests-flac-other';
  const files = [`/home/fpp/media/music/${base}.flac`, `/home/fpp/media/sequences/${base}.fseq`, `/home/fpp/media/sequences/${other}.fseq`];
  inPlayer('touch', ...files);
  try {
    await storePlaylist(request, []);
    await openEditor(page);
    await openNewEntry(page);
    const modal = page.locator('.modal.show');
    await page.selectOption('#pe_type', 'both');
    const seq = modal.locator('select.arg_sequenceName');
    await expect(seq.locator(`option[value="${base}.fseq"]`)).toHaveCount(1);
    await seq.selectOption(`${other}.fseq`);
    const media = modal.locator('select.arg_mediaName');
    await expect(media.locator(`option[value="${base}.flac"]`)).toHaveCount(1);
    await media.selectOption(`${base}.flac`);
    await expect(seq).toHaveValue(`${base}.fseq`);
  } finally {
    inPlayer('rm', '-f', ...files);
  }
});

test('a Command entry for a command with no arguments edits and saves', async ({ page, request }) => {
  // Regression: 4a0b596f1.  api/commands has no "args" key for a command
  // with none (All Lights Off), and ComputeArgGroupBoundaries() threw on it:
  // the Edit button did nothing.
  await storePlaylist(request, [{ type: 'command', enabled: 1, playOnce: 0, command: 'All Lights Off', args: [] }]);
  const errors = pageErrors(page);
  await openEditor(page);
  await page.locator('.playlistRowEditButton').first().click();
  const modal = page.locator('.modal.show');
  await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
  await expect(modal.locator('select.arg_command')).toHaveValue('All Lights Off');
  await modal.locator('input.arg_note').fill('fpp-tests note');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();
  await savePlaylist(page);
  expect(errors).toEqual([]);

  const entry = (await storedPlaylist(request)).mainPlaylist[0];
  expect(entry).toMatchObject({ type: 'command', command: 'All Lights Off', note: 'fpp-tests note' });
  // What fppd would run: the command check, against fppd's own command list.
  const all = await (await request.get('/api/playlists/validate')).json();
  const mine = all.find((p: { name: string }) => p.name === NAME);
  expect(mine?.valid, JSON.stringify(mine)).toBe(true);
});

test('a URL entry has a Note, and the editor keeps it', async ({ page, request }) => {
  // Feature: 225aa3994 ("Add a Note field to PlaylistEntryURL").  Every
  // other entry type had a Note; a URL entry's editor had none, so its note
  // could not be seen or changed, and a save dropped one set by hand.
  await storePlaylist(request, [{ type: 'url', enabled: 1, playOnce: 0, method: 'GET', url: 'http://127.0.0.1/fpp-tests', data: '',
    note: 'fpp-tests url note' }]);
  const errors = pageErrors(page);
  await openEditor(page);
  await page.locator('.playlistRowEditButton').first().click();
  const modal = page.locator('.modal.show');
  await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
  await expect(modal.locator('input.arg_url')).toHaveValue('http://127.0.0.1/fpp-tests');
  const note = modal.locator('input.arg_note');
  await expect(note).toHaveValue('fpp-tests url note');
  await note.fill('fpp-tests url note, edited');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();
  await savePlaylist(page);
  expect(errors).toEqual([]);
  const entry = (await storedPlaylist(request)).mainPlaylist[0];
  expect(entry).toMatchObject({ type: 'url', url: 'http://127.0.0.1/fpp-tests', note: 'fpp-tests url note, edited' });
});

const MUSIC = '/home/fpp/media/music';
const MAIN = 'fpp-tests-main.mp3';
const EXTRA = 'fpp-tests-extra.mp3';

// The UI level for one test, put back after it (the advanced args show at 1).
let uiLevelBefore: string | undefined;
async function setUiLevel(request: APIRequestContext, level: string) {
  uiLevelBefore ??= String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  expect((await request.put('/api/settings/uiLevel', { data: level })).ok()).toBe(true);
}

test.afterEach(async ({ request }) => {
  if (uiLevelBefore !== undefined) await request.put('/api/settings/uiLevel', { data: uiLevelBefore });
  uiLevelBefore = undefined;
});

test.describe('media entries', () => {
  test.skip(!container, 'puts media files inside the run-web.sh container');
  test.beforeEach(() => inPlayer('sh', '-c', `echo x > ${MUSIC}/${MAIN}; echo x > ${MUSIC}/${EXTRA}`));
  test.afterEach(() => inPlayer('rm', '-f', `${MUSIC}/${MAIN}`, `${MUSIC}/${EXTRA}`));

  test('a new Media entry leaves Extra Media at None', async ({ page, request }) => {
    // Regression: 8f009f078.  The Extra Media list had no blank choice, so
    // it came up on the first media file, and every new media entry saved
    // that file as its extra media and played it alongside.
    await storePlaylist(request, []);
    await setUiLevel(request, '1');
    {
      // The control: there are media files the list could pick.
      const media = await (await request.get('/api/media')).json();
      expect(media).toEqual(expect.arrayContaining([MAIN, EXTRA]));

      await openEditor(page);
      await openNewEntry(page);
      const modal = page.locator('.modal.show');
      await page.selectOption('#pe_type', 'media');
      const main = modal.locator('select.arg_mediaName');
      await expect(main.locator(`option[value="${MAIN}"]`)).toHaveCount(1);
      await main.selectOption(MAIN);
      const extra = modal.locator('select.arg_extraMediaName');
      await expect(extra).toBeVisible();
      await expect(extra.locator(`option[value="${EXTRA}"]`)).toHaveCount(1);
      await expect(extra).toHaveValue('');
      await expect(extra.locator('option:checked')).toHaveText('-- None --');
      await addEntry(page);
      await savePlaylist(page);
    }
    const entry = (await storedPlaylist(request)).mainPlaylist[0];
    expect(entry).toMatchObject({ type: 'media', mediaName: MAIN });
    expect(entry.extraMediaName ?? '').toBe('');
  });

  test('at the Basic UI level an advanced arg that is set shows, and can be cleared', async ({ page, request }) => {
    // Regression: cc300b110.  Advanced args were hidden below the advanced
    // UI level whatever they held: an entry's Extra Media kept playing, and
    // there was no way to see or clear it.
    await storePlaylist(request, [{ type: 'media', enabled: 1, playOnce: 0, mediaName: MAIN, extraMediaName: EXTRA, extraMediaSlot: '2' }]);
    await setUiLevel(request, '0');
    await openEditor(page);
    await page.locator('.playlistRowEditButton').first().click();
    const modal = page.locator('.modal.show');
    await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
    // The control: an advanced arg the entry doesn't set stays hidden.
    await expect(modal.locator('.arg_extraMediaOut')).toBeHidden();
    const extra = modal.locator('select.arg_extraMediaName');
    await expect(extra).toBeVisible();
    await expect(extra).toHaveValue(EXTRA);

    await extra.selectOption('');
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await savePlaylist(page);
    const entry = (await storedPlaylist(request)).mainPlaylist[0];
    expect(entry).toMatchObject({ type: 'media', mediaName: MAIN });
    expect(entry.extraMediaName ?? '').toBe('');
  });

  test('the entry modal groups a media entry into sections with help, and saves it unchanged', async ({ page, request }) => {
    // Feature: d9897e354.  Each arg's "section" in playlistEntryTypes.json
    // heads a group of rows, Entry Properties last, and its "help" is a help
    // icon with that text as its tooltip.
    const stored = { type: 'media', enabled: 1, playOnce: 0, fileMode: 'single', mediaName: MAIN, videoOut: '--Default--',
      streamSlot: 1, extraMediaName: EXTRA, extraMediaSlot: 3, note: 'fpp-tests note', displayMode: 'argsAndNote' };
    await storePlaylist(request, [stored]);
    const types = await (await request.get('/playlistEntryTypes.json')).json();
    const args: Record<string, any> = types.media.args;
    await setUiLevel(request, '1');
    await openEditor(page);
    await page.locator('.playlistRowEditButton').first().click();
    const modal = page.locator('.modal.show');
    await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');

    const headers = modal.locator('tr.argSectionHeaderRow:visible');
    await expect(headers).toHaveText(['Primary Media', 'Extra Media', 'Entry Properties'], { ignoreCase: true });
    // Each arg's row sits under its own section's heading.
    const order = await modal.locator('tr:visible').evaluateAll((trs) => trs.map((tr) =>
      tr.classList.contains('argSectionHeaderRow') ? `#${tr.getAttribute('data-arg-section')}` :
        (Array.from(tr.querySelectorAll('[class*="arg_"]')).map((e) => (e.className.match(/\barg_(\w+)/) || [])[1]).find(Boolean) ?? '')));
    let section = '';
    for (const item of order) {
      if (item.startsWith('#')) section = item.slice(1);
      else if (args[item]?.section) expect(section, `${item}'s section`).toBe(args[item].section);
    }
    for (const name of ['mediaName', 'streamSlot', 'extraMediaName', 'note']) {
      const icon = modal.locator('tr', { has: page.locator(`.arg_${name}`) }).locator('.argHelpIcon');
      await expect(icon, name).toHaveCount(1);
      expect(await icon.getAttribute('data-bs-title'), name).toBe(args[name].help);
    }
    await modal.locator('tr', { has: page.locator('.arg_mediaName') }).locator('.argHelpIcon').hover();
    await expect(page.locator('.tooltip.show')).toContainText(args.mediaName.help.slice(0, 40));

    // Saved without a change, the entry is what was stored.
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await savePlaylist(page);
    expect((await storedPlaylist(request)).mainPlaylist[0]).toMatchObject(stored);
  });

  test('saving an entry keeps a video output its list no longer offers', async ({ page, request }) => {
    // Regression: 765889c55.  .val() on a select without that option selects
    // nothing, and the empty select saved as the text "null": opening and
    // saving an entry on a display or model that was gone replaced its output.
    const stored = { type: 'media', enabled: 1, playOnce: 0, mediaName: MAIN, videoOut: 'fpp-tests-gone-output' };
    await storePlaylist(request, [stored]);
    await openEditor(page);
    await page.locator('.playlistRowEditButton').first().click();
    const modal = page.locator('.modal.show');
    await expect(modal.locator('select.arg_videoOut')).toHaveValue(stored.videoOut);
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await savePlaylist(page);
    expect((await storedPlaylist(request)).mainPlaylist[0]).toMatchObject(stored);
  });

  test('saving an entry whose media is gone leaves its sequence alone', async ({ page, request }) => {
    // Regression: 765889c55.  Keeping a media name the list lacks must not count
    // as choosing it, which would pick the sequence of the same name.
    const gone = 'fpp-tests-gone-media', kept = 'fpp-tests-kept.fseq';
    test.skip(!container, "puts files in the run-web.sh container's media");
    const files = [`/home/fpp/media/sequences/${gone}.fseq`, `/home/fpp/media/sequences/${kept}`];
    inPlayer('touch', ...files);
    try {
      const stored = { type: 'both', enabled: 1, playOnce: 0, sequenceName: kept, mediaName: `${gone}.mp3` };
      await storePlaylist(request, [stored]);
      await openEditor(page);
      await page.locator('.playlistRowEditButton').first().click();
      const modal = page.locator('.modal.show');
      await expect(modal.locator('select.arg_mediaName')).toHaveValue(stored.mediaName);
      await modal.getByRole('button', { name: 'Save', exact: true }).click();
      await savePlaylist(page);
      expect((await storedPlaylist(request)).mainPlaylist[0]).toMatchObject(stored);
    } finally {
      inPlayer('rm', '-f', ...files);
    }
  });

  test('saving repairs a video output an earlier save left as "null"', async ({ page, request }) => {
    // Regression: 765889c55.  "null" is what the bug wrote, not a choice: kept,
    // fppd looks for an overlay model of that name and plays audio only.
    await storePlaylist(request, [{ type: 'media', enabled: 1, playOnce: 0, mediaName: MAIN, videoOut: 'null' }]);
    await openEditor(page);
    await page.locator('.playlistRowEditButton').first().click();
    const modal = page.locator('.modal.show');
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await savePlaylist(page);
    const entry = (await storedPlaylist(request)).mainPlaylist[0];
    expect(entry.mediaName).toBe(MAIN);
    expect(entry.videoOut ?? '--Default--').toBe('--Default--');
  });

  // A Play Media command in an entry.  Its args go by position: videoOut is the
  // fifth, the Sync To Show after it the sixth.
  const playMedia = (videoOut: string) => ({ type: 'command', enabled: 1, playOnce: 0, command: 'Play Media',
    args: [MAIN, '1', '0', '1', videoOut, 'true'], multisyncCommand: false, multisyncHosts: '' });

  test('saving a command keeps a video output its list no longer offers', async ({ page, request }) => {
    // Regression: 2388c8d8a.  PopulateExistingCommand() set the value on a select
    // without that option, which selects nothing, and it saved as null.
    await storePlaylist(request, [playMedia('fpp-tests-gone-output')]);
    await openEditor(page);
    await page.locator('.playlistRowEditButton').first().click();
    const modal = page.locator('.modal.show');
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await savePlaylist(page);
    expect((await storedPlaylist(request)).mainPlaylist[0].args).toEqual(playMedia('').args.with(4, 'fpp-tests-gone-output'));
  });

  test('a command with nothing selected keeps its later args in their slots', async ({ page, request }) => {
    // Regression: 2388c8d8a.  CommandToJSON() pushed the empty select's null,
    // which the row stored as the text "null".  An earlier save's "null" is
    // repaired the same way, so this is both.
    await storePlaylist(request, [playMedia('null')]);
    await openEditor(page);
    await page.locator('.playlistRowEditButton').first().click();
    const modal = page.locator('.modal.show');
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await savePlaylist(page);
    expect((await storedPlaylist(request)).mainPlaylist[0].args).toEqual(playMedia('').args);
  });

  test('a video output list that fails to load neither changes an entry nor saves "null"', async ({ page, request }) => {
    // Regression: 765889c55.  The same with the list's fetch failing, for the
    // entry being edited and for a new one.
    const stored = { type: 'media', enabled: 1, playOnce: 0, mediaName: MAIN, videoOut: 'HDMI-A-1' };
    await storePlaylist(request, [stored]);
    await page.route('**/api/options/PlaylistVideoOutput*', (route) => route.abort());
    await openEditor(page);
    await page.locator('.playlistRowEditButton').first().click();
    let modal = page.locator('.modal.show');
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal).toHaveCount(0);

    await openNewEntry(page);
    modal = page.locator('.modal.show');
    await page.selectOption('#pe_type', 'media');
    await modal.locator('select.arg_mediaName').selectOption(MAIN);
    await addEntry(page);
    await savePlaylist(page);
    const main = (await storedPlaylist(request)).mainPlaylist;
    expect(main[0]).toMatchObject(stored);
    expect(main[1].mediaName).toBe(MAIN);
    expect(main[1].videoOut ?? '--Default--').toBe('--Default--');
  });

  test('the editor marks the entries whose files are missing', async ({ page, request }) => {
    // Also guards 6addf4c9c: the playlist validation names a missing sequence.
    // Feature: 3aa0ad4f1.  The playlist cards flagged a playlist with a
    // missing sequence or media file; the drill-in editor showed its rows as
    // if nothing were wrong.
    const seq = 'fpp-tests-here.fseq';
    inPlayer('sh', '-c', `echo x > /home/fpp/media/sequences/${seq}`);
    try {
      await storePlaylist(request, [
        { type: 'sequence', enabled: 1, playOnce: 0, sequenceName: 'fpp-tests-gone.fseq' },
        { type: 'media', enabled: 1, playOnce: 0, mediaName: 'fpp-tests-gone.mp3' },
        { type: 'sequence', enabled: 1, playOnce: 0, sequenceName: seq },
        { type: 'media', enabled: 1, playOnce: 0, mediaName: MAIN },
      ]);
      await openEditor(page);
      const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0)).toHaveClass(/playlistRowWarning/);
      await expect(rows.nth(0).locator('.playlistEntryWarningIcon')).toHaveCount(1);
      await expect(rows.nth(1)).toHaveClass(/playlistRowWarning/);
      // The ⚠ says what is wrong, in a tooltip a hover (or a tap) opens (4cd2c63f6).
      await rows.nth(0).locator('.playlistEntryWarningIcon').hover();
      await expect(page.locator('.tooltip.show')).toContainText('fpp-tests-gone.fseq');
      await rows.nth(1).locator('.playlistEntryWarningIcon').hover();
      await expect(page.locator('.tooltip.show')).toContainText('fpp-tests-gone.mp3');
      // The control: entries whose files are there are not marked.
      for (const i of [2, 3]) {
        await expect(rows.nth(i)).not.toHaveClass(/playlistRowWarning/);
        await expect(rows.nth(i).locator('.playlistEntryWarningIcon')).toHaveCount(0);
      }
    } finally {
      inPlayer('rm', '-f', `/home/fpp/media/sequences/${seq}`);
    }
  });

  test('an entry with extra media carries a badge naming the file and slot', async ({ page, request }) => {
    // Feature: 05642fb97.  Nothing in a row said it played a second file.
    await storePlaylist(request, [
      { type: 'media', enabled: 1, playOnce: 0, mediaName: MAIN, extraMediaName: EXTRA, extraMediaSlot: 3 },
      { type: 'media', enabled: 1, playOnce: 0, mediaName: MAIN },
    ]);
    await openEditor(page);
    const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
    await expect(rows).toHaveCount(2);
    const badge = rows.nth(0).locator('.psiExtraMedia');
    await expect(badge).toHaveCount(1);
    await expect(badge).toContainText('Extra Media');
    await expect(badge).toContainText(`${EXTRA} (slot 3)`);
    await expect(badge).toHaveAttribute('title', `Also plays ${EXTRA} on stream slot 3`);
    // The control: the entry without one has no badge.
    await expect(rows.nth(1).locator('.psiExtraMedia')).toHaveCount(0);
  });
});

test('select mode removes, duplicates and copies exactly the ticked entries', async ({ page, request }) => {
  // Feature: 145aed356.  A checkbox per entry in a select mode, and Remove,
  // Duplicate and Copy to... for the ticked ones.
  const other = `${NAME}-target`;
  const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });
  await storePlaylist(request, [pause(1), pause(2), pause(3), pause(4)]);
  await request.post(`/api/playlist/${other}`, {
    data: { name: other, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [pause(9)], leadOut: [], playlistInfo: {} },
  });
  try {
    await openEditor(page);
    const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
    await expect(rows).toHaveCount(4);
    const actions = async (item: string) => {
      await page.locator('#playlistSelectActionsBtn').click();
      await page.locator('.playlistSelectActionsMenu .dropdown-item', { hasText: item }).click();
    };

    await expect(page.locator('.playlistSelectModeBtn')).toBeVisible();
    await page.locator('.playlistSelectModeBtn').click();
    await rows.nth(1).locator('.playlistEntryCheckbox').check();
    await rows.nth(3).locator('.playlistEntryCheckbox').check();
    await expect(page.locator('#playlistSelectActionsBtn .playlistSelectCount')).toHaveText('2');
    await actions('Remove Selected');
    await expect(rows).toHaveCount(2);

    await page.locator('.playlistSelectModeBtn').click();
    await rows.nth(0).locator('.playlistEntryCheckbox').check();
    await actions('Duplicate Selected');
    await expect(rows).toHaveCount(3);
    await savePlaylist(page);
    expect((await storedPlaylist(request)).mainPlaylist.map((e: any) => e.duration)).toEqual([1, 1, 3]);

    await page.locator('.playlistSelectModeBtn').click();
    await rows.nth(2).locator('.playlistEntryCheckbox').check();
    await actions('Copy to...');
    const dialog = page.locator('#CopySelectedDialog');
    await dialog.locator('#copyTargetPlaylist').selectOption(other);
    await dialog.locator('input[name=copySection][value=leadOut]').check();
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(async () => (await (await request.get(`/api/playlist/${other}`)).json()).leadOut?.map((e: any) => e.duration))
      .toEqual([3]);
    const target = await (await request.get(`/api/playlist/${other}`)).json();
    expect(target.mainPlaylist.map((e: any) => e.duration)).toEqual([9]);
    // The copy is a playlist fppd loads: it starts, on the copied pause.
    await request.post('/api/command', { data: { command: 'Start Playlist', args: [other, 'false', 'false'] } });
    await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).current_playlist?.playlist).toBe(other);
  } finally {
    await request.post('/api/command', { data: { command: 'Stop Now', args: [] } });
    await request.delete(`/api/playlist/${other}`);
  }
});


test('Save As New in the Edit Entry dialog adds the edited entry and leaves the original alone', async ({ page, request }) => {
  // Feature: 78d7b8d0d.  Editing an entry could only change it; "Save As New"
  // makes a copy with the edits.
  await storePlaylist(request, [{ type: 'command', enabled: 1, playOnce: 0, command: 'All Lights Off', args: [], note: 'original' }]);
  await openEditor(page);
  await page.locator('.playlistRowEditButton').first().click();
  const modal = page.locator('.modal.show');
  await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
  await modal.locator('input.arg_note').fill('the copy');
  await modal.getByRole('button', { name: 'Save As New', exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#tblPlaylistMainPlaylist tr.playlistRow')).toHaveCount(2);
  await savePlaylist(page);
  const entries = (await storedPlaylist(request)).mainPlaylist;
  expect(entries.map((e: { note?: string }) => e.note).sort()).toEqual(['original', 'the copy']);
});
