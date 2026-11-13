import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// What the playlist editor works out about an entry as it is saved from the
// entry editor (SetPlaylistItemMetaData in fpp.js): its length, from the
// media file, the sequence or the playlist it names, and a red line under an
// entry whose file or playlist is not there.  The lengths are the test's
// (the files here are only names), given through the API the editor asks.
// playlist-entry-file-gone.spec.ts covers entries newly added whose file is
// gone; playlist-image-entry-path.spec.ts an image named by path.

test.skip(!container, "puts files in the run-web.sh container's media");

const NAME = 'fpp-tests-entry-measured';
const SUB = 'fpp-tests-entry-measured-sub';
const SEQ = 'fpp-tests-measured-seq.fseq';
const MEDIA = 'fpp-tests-measured-media.mp3';
// No closing tag: a file name cannot hold the slash.
const MARKUP = 'fpp-tests-measured <u>m.mp3';
const files = [`/home/fpp/media/sequences/${SEQ}`, `/home/fpp/media/music/${MEDIA}`, `/home/fpp/media/music/${MARKUP}`];

async function store(request: APIRequestContext, name: string, mainPlaylist: unknown[]) {
  const r = await request.post(`/api/playlist/${name}`, {
    data: { name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {}, mainPlaylist },
  });
  expect(r.ok(), `storing ${name}: ${r.status()}`).toBe(true);
}
const entry = (fields: Record<string, unknown>) => ({ enabled: 1, playOnce: 0, ...fields });

test.beforeEach(async ({ request }) => {
  inPlayer('sh', '-c', files.map((f) => `echo x > '${f}'`).join('; '));
  await store(request, SUB, [entry({ type: 'pause', duration: 8 })]);
});
test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', ...files);
  await request.delete(`/api/playlist/${NAME}`);
  await request.delete(`/api/playlist/${SUB}`);
});

const row = (page: Page) => page.locator('#tblPlaylistMainPlaylist tr.playlistRow');

// Opens the playlist and saves its one entry through the entry editor,
// which is when the editor measures it.
async function openAndResave(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(row(page)).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await page.locator('.playlistRowEditButton').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
  const modal = page.locator('.modal.show');
  await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();
}

const mediaLasts = (page: Page, answer: unknown) => page.route('**/api/media/*/duration', (route) => route.fulfill({ json: answer }));
const sequenceIs = (page: Page, frames: number, stepMs: number) =>
  page.route('**/api/sequence/*/meta', (route) => route.fulfill({ json: { NumFrames: frames, StepTime: stepMs } }));

async function lengthIs(page: Page, seconds: string, human: string) {
  await expect(row(page).locator('.psiDurationSeconds')).toHaveText(seconds);
  await expect(row(page).locator('.humanDuration')).toHaveText(`Length: ${human}`);
}

test("a media entry's length is the file's, and the section's total follows it", async ({ page, request }) => {
  await store(request, NAME, [entry({ type: 'media', mediaName: MEDIA })]);
  await mediaLasts(page, { [MEDIA]: { duration: 83.5 } });
  await openAndResave(page);
  await lengthIs(page, '83.5', '01:23');
  await expect(row(page)).not.toContainText('ERROR');
});

test('a media file that reports no length leaves the entry without one', async ({ page, request }) => {
  await store(request, NAME, [entry({ type: 'media', mediaName: MEDIA })]);
  // The answer names no such file, and one that does gives a zero length.
  for (const answer of [{}, { [MEDIA]: {} }, { [MEDIA]: { duration: 0 } }]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await mediaLasts(page, answer);
    await openAndResave(page);
    await expect(row(page).locator('.humanDuration'), JSON.stringify(answer)).toHaveText('');
    await expect(row(page)).not.toContainText('ERROR');
  }
});

test.describe('a Seq+Media entry ends when the shorter of the two does', () => {
  test.beforeEach(async ({ request }) => {
    await store(request, NAME, [entry({ type: 'both', sequenceName: SEQ, mediaName: MEDIA })]);
  });

  test('the media, when it is the shorter', async ({ page }) => {
    await mediaLasts(page, { [MEDIA]: { duration: 12 } });
    await sequenceIs(page, 400, 50); // 20 seconds
    await openAndResave(page);
    await lengthIs(page, '12', '00:12');
  });

  test('the sequence, when it is the shorter', async ({ page }) => {
    await mediaLasts(page, { [MEDIA]: { duration: 30 } });
    await sequenceIs(page, 400, 50);
    await openAndResave(page);
    await lengthIs(page, '20', '00:20');
  });

  test('the sequence, when the media reports no length', async ({ page }) => {
    await mediaLasts(page, {});
    await sequenceIs(page, 400, 50);
    await openAndResave(page);
    await lengthIs(page, '20', '00:20');
  });

  test('with the media file gone the entry says so and has no length', async ({ page }) => {
    await page.route('**/api/media/*/duration', (route) => route.fulfill({ status: 404, json: { Status: 'Error' } }));
    await sequenceIs(page, 400, 50);
    await openAndResave(page);
    await expect(row(page)).toContainText(`ERROR: Media File "${MEDIA}" Not Found`);
    await expect(row(page)).not.toContainText('ERROR: Sequence');
    await expect(row(page).locator('.humanDuration')).toHaveText('');
  });
});

test.describe('an entry that runs another playlist', () => {
  test.beforeEach(async ({ request }) => {
    await store(request, NAME, [entry({ type: 'playlist', name: SUB })]);
  });
  // The editor's own list of playlists stays as it is; only the one asked
  // for by name, as the entry is measured, is the test's.
  const subAnswers = (page: Page, answer: { status?: number; json: unknown }) =>
    page.route(`**/api/playlist/${SUB}`, (route) => (route.request().method() === 'GET' ? route.fulfill(answer) : route.fallback()));

  test("is as long as that playlist's total", async ({ page }) => {
    await openAndResave(page);
    await lengthIs(page, '8', '00:08');
    await expect(row(page)).not.toContainText('ERROR');
  });

  test('says the playlist is not found when the player has none by that name', async ({ page }) => {
    await page.goto('/playlists.php');
    await subAnswers(page, { status: 404, json: { Status: 'Error', Message: 'Playlist does not exist' } });
    await openAndResave(page);
    await expect(row(page)).toContainText(`ERROR: Playlist "${SUB}" Not Found`);
  });

  test('says so too when the answer is not a playlist', async ({ page }) => {
    await subAnswers(page, { json: {} });
    await openAndResave(page);
    await expect(row(page)).toContainText(`ERROR: Playlist "${SUB}" Not Found`);
    await expect(row(page).locator('.humanDuration')).toHaveText('');
  });

  test('says the playlist could not be loaded on any other failure', async ({ page }) => {
    await subAnswers(page, { status: 500, json: { Status: 'Error' } });
    await openAndResave(page);
    await expect(row(page)).toContainText(`ERROR: Loading Playlist "${SUB}"`);
    await expect(row(page)).not.toContainText('Not Found');
  });
});

test('an image entry whose list of images cannot be read is an error dialog, not a missing file', async ({ page, request }) => {
  await store(request, NAME, [entry({ type: 'image', imagePath: 'fpp-tests-measured.png', modelName: 'fpp-tests-model' })]);
  await page.goto('/playlists.php');
  // The entry editor's file chooser reads the same list; only the check made
  // as the entry is saved is failed.
  await page.route('**/api/files/images?nameOnly=1', (route) => route.fulfill({ status: 500, body: 'no' }));
  await openAndResave(page);
  const dialog = page.locator('.modal.show');
  await expect(dialog.locator('.modal-title')).toHaveText('Failed to Query Image');
  await expect(dialog).toContainText('Unable to query list of images');
  await expect(row(page)).not.toContainText('Not Found');
});

test.describe("a missing file's name is shown as it is written", () => {
  const gone = (page: Page) => page.route('**/api/media/*/duration', (route) => route.fulfill({ status: 404, json: { Status: 'Error' } }));

  test('a plain name (the control)', async ({ page, request }) => {
    await store(request, NAME, [entry({ type: 'media', mediaName: MEDIA })]);
    await gone(page);
    await openAndResave(page);
    await expect(row(page).locator('.psiDataSimple')).toContainText(`ERROR: Media File "${MEDIA}" Not Found`);
  });

  test('a name with markup in it', async ({ page, request }) => {
    // The editor decodes the name it reads off the row and puts it into the
    // error line as HTML, so the file's <u> becomes an element.  The same is
    // done with a missing sequence's name and a missing playlist's.  In
    // FUTURE.md.
    await store(request, NAME, [entry({ type: 'media', mediaName: MARKUP })]);
    await gone(page);
    await openAndResave(page);
    await expect(row(page).locator('.psiDataSimple')).toContainText('ERROR: Media File');
    await expect(row(page).locator('.psiDataSimple')).toContainText(`ERROR: Media File "${MARKUP}" Not Found`);
    expect(await row(page).locator('.psiDataSimple u').count()).toBe(0);
  });
});
