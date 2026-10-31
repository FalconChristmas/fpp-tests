import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// Small UI behaviours, each with its own fixture.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';

async function setSetting(request: APIRequestContext, name: string, value: string) {
  const r = await request.put(`/api/settings/${name}`, { data: value });
  expect(r.ok(), `${name}=${value}`).toBe(true);
}

// f70dcfe60 (Option to disable the volume slider, #1726) and ce8bf70bb (its
// default).
test('the Status page hides its volume slider when the setting says so', async ({ page, request }) => {
  try {
    await setSetting(request, 'disableAudioVolumeSlider', '1');
    await page.goto('/index.php');
    await expect(page.locator('#slider')).toHaveCount(0);
    await expect(page.locator('.volumeControls')).toHaveCount(0);
    await setSetting(request, 'disableAudioVolumeSlider', '0');
    await page.goto('/index.php');
    await expect(page.locator('#slider').first()).toBeAttached();
    await expect(page.locator('.volumeControls').first()).toBeAttached();
  } finally {
    await setSetting(request, 'disableAudioVolumeSlider', '0');
  }
});

// 7887ede4b: links that open a new tab carry rel="noopener noreferrer".
for (const path of ['/index.php', '/plugins.php']) {
  test(`every link opening a new tab on ${path} is noopener and noreferrer`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const bad = await page.locator('a[target=_blank]').evaluateAll((as: HTMLAnchorElement[]) =>
      as.filter((a) => !/\bnoopener\b/.test(a.rel) || !/\bnoreferrer\b/.test(a.rel)).map((a) => a.outerHTML.slice(0, 160)));
    expect(bad).toEqual([]);
  });
}

// 193c92344: the File Manager lists the backups directory.
test('the File Manager has a Backups tab that lists the backup files', async ({ page }) => {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/backups && printf backup > ${MEDIA}/backups/fpp-tests-backup.tar`);
  try {
    await page.goto('/filemanager.php');
    await page.locator('#tab-backups-tab').click();
    await expect(page.locator('#tblBackups')).toContainText('fpp-tests-backup.tar');
    await expect(page.locator('#fileCount_Backups')).not.toHaveText('0');
  } finally {
    inPlayer('rm', '-f', `${MEDIA}/backups/fpp-tests-backup.tar`);
  }
});

// ee3ebfc28: an edited playlist shows an unsaved-changes mark on its Save button.
test('the playlist editor marks unsaved changes on the Save button', async ({ page, request }) => {
  const NAME = 'fpp-tests-unsaved-mark';
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 1 }], leadOut: [], playlistInfo: {} },
  });
  expect(r.ok()).toBe(true);
  try {
    await page.goto('/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    const mark = page.locator('.savePlaylistBtnHasChange');
    await expect(mark).toBeHidden();
    // delete the entry through the editor's own handler, as its trash button does
    await page.locator('#tblPlaylistMainPlaylist tr.playlistRow, #tblPlaylistMainPlaylist tbody tr').first().click();
    await page.evaluate(() => (window as any).markCurrentPlaylistModified(true));
    await expect(mark).toBeVisible();
    const saved = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/api/playlist/${NAME}`);
    await page.getByRole('button', { name: 'Save Playlist' }).click();
    await saved;
    await expect(mark).toBeHidden();
  } finally {
    await request.delete(`/api/playlist/${NAME}`);
  }
});
