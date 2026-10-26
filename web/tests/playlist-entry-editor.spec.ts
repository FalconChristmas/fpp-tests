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
      await page.locator('.playlistEntriesAddNewBtn').first().click();
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

  test('the editor marks the entries whose files are missing', async ({ page, request }) => {
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
      await expect(rows.nth(0)).toHaveAttribute('title', /fpp-tests-gone\.fseq/);
      await expect(rows.nth(0).locator('.playlistEntryWarningIcon')).toHaveCount(1);
      await expect(rows.nth(1)).toHaveClass(/playlistRowWarning/);
      await expect(rows.nth(1)).toHaveAttribute('title', /fpp-tests-gone\.mp3/);
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

