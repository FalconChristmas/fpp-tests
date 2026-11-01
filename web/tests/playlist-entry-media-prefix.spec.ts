import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// A Media entry in a random file mode takes a file name prefix to narrow the
// pick (playlistEntryTypes.json, the entry editor).

const NAME = 'fpp-tests-media-prefix';

async function storePlaylist(request: APIRequestContext, mainPlaylist: object[]) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok(), `storing ${NAME}: ${r.status()}`).toBe(true);
}

async function openEditor(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}

let uiLevelBefore: string | undefined;
test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
  if (uiLevelBefore !== undefined) await request.put('/api/settings/uiLevel', { data: uiLevelBefore });
  uiLevelBefore = undefined;
});

test('a random Media entry offers a file name prefix, and saves it', async ({ page, request }) => {
  // Regression: 4aa3946df.  Random Video / Random Audio could not be narrowed
  // by file name; the prefix is an advanced field, shown for the random
  // modes only.  fppd honouring it is scenarios/test_playlist_direct_media.py.
  //
  // Not working on master: the prefix row starts collapsed (inline
  // visibility:collapse, as a child of a parent value that isn't the default)
  // and UpdateChildVisibility() only show()s it, which never clears
  // visibility, so the field is unreachable in the editor.  Expected to fail
  // until that is fixed; UpdateGenericArgChildVisibility() already clears it.
  test.fail();
  await storePlaylist(request, []);
  uiLevelBefore = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);
  await openEditor(page);
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await page.locator('.playlistEntriesAddNewBtn').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
  const modal = page.locator('.modal.show');
  await page.selectOption('#pe_type', 'media');
  const prefix = modal.locator('.arg_mediaPrefix');
  // The control: a single file has no prefix.
  await expect(modal.locator('select.arg_fileMode')).toHaveValue('single');
  await expect(prefix).toBeHidden();
  await modal.locator('select.arg_fileMode').selectOption('randomAudio');
  await expect(prefix).toBeVisible();
  await prefix.fill('Xmas');
  const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(rows).toHaveCount(1);
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
  const entry = (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist[0];
  expect(entry).toMatchObject({ type: 'media', fileMode: 'randomAudio', mediaPrefix: 'Xmas' });
});
