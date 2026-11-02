import { test, expect } from './fixtures';

// Regression: 0ad4c66bd ("Fix playlist editor losing playlist durations").
// The hidden #playlistDuration span the duration code writes the total into
// sat inside a commented-out block of playlistEditor.php, so it was never in
// the page and the total came out empty.  The editor fragment has to carry
// all three hidden duration spans.

test('the playlist editor carries its hidden duration spans', async ({ request }) => {
  const r = await request.get('/playlistEditor.php');
  expect(r.ok()).toBe(true);
  const body = await r.text();
  // Outside HTML comments, where the browser would drop them.
  const live = body.replace(/<!--[\s\S]*?-->/g, '');
  for (const id of ['playlistDuration', 'playlistDurationLeadIn', 'playlistDurationLeadOut']) {
    expect(live, `#${id} missing from the editor`).toContain(`id='${id}'`);
  }
});
