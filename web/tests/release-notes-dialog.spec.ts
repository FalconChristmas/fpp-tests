import { test, expect } from './fixtures';
import { container } from './container';
import { FakeGitHub, release } from './standin-http';

// GET /api/system/releaseNotes/<version>: an FPP release's notes, which
// ViewReleaseNotes() shows in its dialog with an Upgrade button.  GitHub is
// answered by a stand-in in the player (standin-http.ts).

test.skip(!container, 'stubs GitHub inside the run-web.sh container');

const TAGS = '/repos/FalconChristmas/fpp/releases/tags';
let gh: FakeGitHub;
test.beforeEach(() => {
  gh = new FakeGitHub({
    [`${TAGS}/10.4`]: { json: { ...release('10.4', []), body: 'fpp-tests notes for 10.4', published_at: '2026-05-01T00:00:00Z' } },
    [`${TAGS}/9.9`]: { status: 404, json: { message: 'Not Found' } },
  });
  gh.start();
});
test.afterEach(() => gh?.stop());

test('a release\'s notes come back from the API and show in the release notes dialog', async ({ page, request }) => {
  // Feature: 21cc62611 ("releaseNotes API --#944"): the fppxml.php
  // viewReleaseNotes command became this endpoint, with the release's
  // draft and prerelease flags and its date beside the notes.
  const r = await request.get('/api/system/releaseNotes/10.4');
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ status: 'OK', draft: false, prerelease: false, body: 'fpp-tests notes for 10.4',
    published_at: '2026-05-01T00:00:00Z' });
  expect(gh.requests().map((q) => q.path)).toContain(`${TAGS}/10.4`);
  // A tag GitHub does not have.
  expect((await (await request.get('/api/system/releaseNotes/9.9')).json()).status).toBe('Release not found');

  await page.goto('/index.php');
  await page.evaluate(() => (window as any).ViewReleaseNotes('10.4'));
  const notes = page.locator('#releaseNotesText');
  await expect(notes.locator('pre')).toHaveText('fpp-tests notes for 10.4', { timeout: 15_000 });
  await expect(notes.locator('input[value="Upgrade"]')).toBeVisible();
});
