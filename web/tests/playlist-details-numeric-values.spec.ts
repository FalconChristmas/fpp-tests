import { test, expect } from './fixtures';

// The details a playlist entry shows (psiDetailsForEntry, ...Simple,
// psiDetailsData in fpp.js) are built from the entry's JSON, where a pause's
// duration, a script's blocking flag and the like are numbers, not strings.
// Text is escaped on the way in; numbers have nothing to escape.

test('an entry with numeric values still gets its details, and text values are escaped', async ({ page }) => {
  // Regression: 4e11b121b ("Fix adding Pause's to playlists") and
  // c08ed91c7 ("Fix Script playlist item editing").  psiDetailsData() and
  // psiDetailsForEntrySimple() called value.replace() on every value, so the
  // first number (a pause's duration, a script's blocking flag) threw and
  // the entry could not be shown, added or edited.
  await page.goto('/playlists.php');
  await page.waitForFunction(() => typeof (window as any).psiDetailsForEntrySimple === 'function'
    && Object.keys((window as any).playlistEntryTypes || {}).length > 0);
  const html = await page.evaluate(() => {
    const w = window as any;
    const out: Record<string, string> = {};
    const tryIt = (key: string, fn: () => string) => {
      try { out[key] = fn(); } catch (e) { out[key] = 'THREW ' + e; }
    };
    tryIt('pauseSimple', () => w.psiDetailsForEntrySimple({ type: 'pause', enabled: 1, playOnce: 0, duration: 5 }, false));
    tryIt('pauseFull', () => w.psiDetailsForEntry({ type: 'pause', enabled: 1, playOnce: 0, duration: 5 }, false));
    tryIt('scriptFull', () => w.psiDetailsForEntry(
      { type: 'script', enabled: 1, playOnce: 0, scriptName: 'a<b&c.sh', scriptArgs: '', blocking: 1 }, false));
    tryIt('dataNumber', () => w.psiDetailsData('duration', 7));
    tryIt('dataNumberUnits', () => w.psiDetailsData('duration', 7, 'Seconds'));
    tryIt('dataText', () => w.psiDetailsData('name', '<b>&x'));
    return out;
  });
  for (const [key, value] of Object.entries(html)) expect(value, key).not.toMatch(/^THREW/);
  expect(html.pauseSimple).toContain('5');
  expect(html.pauseFull).toContain('>5<');
  expect(html.scriptFull).toContain('a&lt;b&amp;c.sh');
  expect(html.scriptFull).not.toContain('a<b');
  expect(html.dataNumber).toContain('>7<');
  expect(html.dataNumberUnits).toContain('>7</span>');
  expect(html.dataText).toContain('&lt;b>&amp;x');
});
