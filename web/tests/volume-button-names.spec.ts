import { test, expect } from './fixtures';

// The status page's volume down/up buttons are icons only, so their names
// come from aria-label.  The page has a pair in the player view and another
// in the remote-mode view (hidden in player mode).

const volume = async (request: any) => Number((await (await request.get('/api/fppd/status')).json()).volume);

test('the volume buttons have names, and the named ones set the volume', async ({ page, request }) => {
  // Regression: 6739aafe7 (the player view's pair) and 6136f3a3a (the
  // remote view's).  The buttons had no accessible name at all.
  // Also 8ea08153b: SetVolume()'s answer handler threw on string(value)
  // before clearing its in-progress flags, so the number shown stopped
  // following fppd's volume after the first click.
  const was = await volume(request);
  try {
    await request.post('/api/system/volume', { data: { volume: 50 } });
    await page.goto('/index.php');
    const player = page.locator('#playerModeInfo');
    await expect(page.locator('#volume')).toHaveText('50', { timeout: 15_000 });
    await expect(player.getByRole('button', { name: 'DecrementVolume' })).toBeVisible();
    await expect(player.getByRole('button', { name: 'IncrementVolume' })).toBeVisible();

    const remote = page.locator('#remoteModeInfo');
    await expect(remote.getByRole('button', { name: 'DecrementVolume', includeHidden: true })).toHaveCount(1);
    await expect(remote.getByRole('button', { name: 'IncrementVolume', includeHidden: true })).toHaveCount(1);

    // The receiving end: fppd's volume follows the buttons found by name.
    await player.getByRole('button', { name: 'IncrementVolume' }).click();
    await expect.poll(() => volume(request), { timeout: 10_000 }).toBe(51);
    // The buttons step from the number shown, which the next status update
    // brings up to date.
    await expect(page.locator('#volume')).toHaveText('51', { timeout: 15_000 });
    await player.getByRole('button', { name: 'DecrementVolume' }).click();
    await expect.poll(() => volume(request), { timeout: 10_000 }).toBe(50);
  } finally {
    await request.post('/api/system/volume', { data: { volume: was } });
  }
});
