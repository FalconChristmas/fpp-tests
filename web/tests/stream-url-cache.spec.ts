import { test, expect } from './fixtures';

// StreamURL() (js/fpp.js) is what every progress dialog streams through.

test('each streamed run is its own request, never a cached copy of the last', async ({ page }) => {
  // Regression: 0bff45365 ("Prevent browser HTTP-cache reuse in streamed
  // progress dialogs").  A re-run whose URL was the same as an earlier one's
  // (a no-argument action, or the same remote and file) could be answered
  // from the browser's cache, and the dialog showed the old run's output.
  // This Apache answers PHP with Cache-Control: max-age=0, so the reuse
  // itself does not happen here; what is checked is that each run's request
  // is one no cache can answer for another, and that the page served takes
  // it.  (POST runs are never cached; this is a GET one.)
  await page.goto('/index.php');
  const seen: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/fppd/version')) seen.push(`${r.status()} ${new URL(r.url()).search}`);
  });
  await page.evaluate(() => {
    const t = document.createElement('textarea');
    t.id = 'fppTestsStream';
    document.body.appendChild(t);
  });
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => new Promise<void>((done) => {
      (window as any).fppTestsDone = done;
      (window as any).StreamURL('api/fppd/version', 'fppTestsStream', 'fppTestsDone', 'fppTestsDone');
    }));
  }
  await expect.poll(() => seen.length).toBe(2);
  expect(seen[0]).toMatch(/^200 \?_=\d+$/);
  expect(seen[1]).toMatch(/^200 \?_=\d+$/);
  expect(seen[0], 'both runs asked for the same URL').not.toBe(seen[1]);
});

test('an error reply is shown once, not twice', async ({ page }) => {
  // Regression: f92a46504 ("fix(ui): StreamURL shows an error reply once, not
  // twice").  An error body streams too, so onprogress had already shown it
  // when the failure handler added the whole reply again: a refusal such as
  // a remote restart's 502 or the update lock's 409 showed its ERROR line
  // twice.  restartRemoteFPPD.php with no ip is a 400 with one ERROR line.
  await page.goto('/index.php');
  await page.evaluate(() => {
    const t = document.createElement('textarea');
    t.id = 'fppTestsStream';
    document.body.appendChild(t);
  });
  await page.evaluate(() => new Promise<void>((done) => {
    (window as any).fppTestsDone = done;
    (window as any).StreamURL('restartRemoteFPPD.php', 'fppTestsStream', 'fppTestsDone', 'fppTestsDone');
  }));
  const shown = await page.locator('#fppTestsStream').inputValue();
  expect(shown.split('ERROR: No IP given').length - 1, JSON.stringify(shown)).toBe(1);
});
