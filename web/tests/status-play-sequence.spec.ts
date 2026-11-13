import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { fseqV2 } from './fseq';

// A sequence played straight from the status page's picker, as many people
// try a new one: fppd plays it, the page marks its row and counts the time played
// up and the time left down, and when it ends the player is idle again (or,
// with Repeat, plays it again).  The sequence is 6 s of 3 channels with no
// audio; the channels go to whatever outputs this player has (none in the
// container).

test.skip(!container, 'puts a sequence on the run-web.sh player');

const NAME = 'fpp-tests-status-play';
const FILE = `/home/fpp/media/sequences/${NAME}.fseq`;
test.beforeAll(() => putFile(FILE, fseqV2({ stepMs: 50, channels: 3, frames: 120 })));
test.afterAll(() => inPlayer('rm', '-f', FILE));
test.afterEach(async ({ request }) => { await request.post('/api/playlists/stop'); });

const status = async (request: APIRequestContext) => (await (await request.get('/api/fppd/status')).json());
const seconds = (mmss: string) => { const [m, s] = mmss.trim().split(':').map(Number); return m * 60 + s; };

async function play(page: Page, request: APIRequestContext, repeat: boolean) {
  await page.goto('/index.php');
  const option = page.locator(`#playlistSelect optgroup[label="Sequences"] option[value="${NAME}.fseq"]`);
  await expect(option).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#playlistSelect', `${NAME}.fseq`);
  await page.locator('#chkRepeat').setChecked(repeat);
  await page.locator('#btnPlay').click();
  await expect.poll(async () => (await status(request)).current_sequence, { timeout: 15_000 }).toBe(`${NAME}.fseq`);
}

test('a sequence picked and played is marked playing, its time counted, and the player idle when it ends', async ({ page, request }) => {
  await play(page, request, false);
  // Its row in the details is the one playing.  (fpp.js also writes the name
  // to a #txtSeqFilename that no page has.)
  await expect(page.locator('#tblPlaylistDetails .PlaylistRowPlaying')).toContainText(NAME, { timeout: 10_000 });
  await expect(page.locator('#txtPlayerStatus')).toContainText(/playing/i);

  // Played counts up and left counts down, and they add up to the 6 s.
  await expect.poll(async () => seconds(await page.locator('#txtTimePlayed').innerText()), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const played = seconds(await page.locator('#txtTimePlayed').innerText());
  const left = seconds(await page.locator('#txtTimeRemaining').innerText());
  expect(played + left, `played ${played} s + left ${left} s`).toBeGreaterThanOrEqual(5);
  expect(played + left).toBeLessThanOrEqual(7);

  // Ended by itself: fppd is idle, and so is the page.
  await expect.poll(async () => (await status(request)).status_name, { timeout: 15_000 }).toBe('idle');
  await expect(page.locator('#txtPlayerStatus')).toContainText(/idle/i, { timeout: 10_000 });
  await expect(page.locator('#tblPlaylistDetails .PlaylistRowPlaying')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('#btnPlay')).toBeEnabled();
});

test('with Repeat ticked the sequence plays again when it ends', async ({ page, request }) => {
  await play(page, request, true);
  // Past the 6 s end and still playing it, from the start again.
  await page.waitForTimeout(8_000);
  const s = await status(request);
  expect(s.status_name).toBe('playing');
  expect(s.current_sequence).toBe(`${NAME}.fseq`);
  expect(Number(s.seconds_played ?? s.seconds_elapsed), 'from the start again').toBeLessThan(5);
  await expect(page.locator('#chkRepeat')).toBeChecked();
});
