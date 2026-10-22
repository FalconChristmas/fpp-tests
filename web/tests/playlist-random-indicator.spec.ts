import { test, expect } from './fixtures';

// The status page shows whether the playing playlist is randomised.

const playlist = (name: string, random: number) => ({
  name, desc: 'fpp-tests random', repeat: 0, loopCount: 0, random, leadIn: [], leadOut: [],
  mainPlaylist: [
    { type: 'pause', enabled: 1, playOnce: 0, duration: 60 },
    { type: 'pause', enabled: 1, playOnce: 0, duration: 60 },
  ],
});

test('a randomised playlist is marked as such on the status page', async ({ page, request }) => {
  // Feature: ee2e36aae.  fppd's status gained the playing playlist's random
  // mode, and the status page a "Randomised" indicator next to Repeat, shown
  // only while a randomised playlist plays.  (Since then the indicator also
  // needs Verbose Playlist Item Details on.)
  const random = 'fpp-tests-random';
  const plain = 'fpp-tests-not-random';
  const command = (cmd: string, args: string[]) =>
    request.post('/api/command', { data: { command: cmd, args } });
  const verbose = await (await request.get('/api/settings/verbosePlaylistItemDetails')).json();
  await request.put('/api/settings/verbosePlaylistItemDetails', { data: '1' });
  try {
    for (const [name, r] of [[random, 1], [plain, 0]] as [string, number][]) {
      const saved = await request.post(`/api/playlist/${name}`, { data: playlist(name, r) });
      expect(saved.ok(), `saving ${name}: ${saved.status()}`).toBe(true);
    }
    await command('Start Playlist', [random, 'false', 'false']);
    await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).random,
      { message: "fppd's status names the random mode" }).toBe(1);

    await page.goto('/index.php');
    const indicator = page.locator('#randomizeIndicator');
    await expect(indicator).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#randomizeStatus')).toHaveText('Once at load time');

    await command('Stop Now', []);
    await command('Start Playlist', [plain, 'false', 'false']);
    await expect.poll(async () => (await (await request.get('/api/fppd/status')).json())
      .current_playlist?.playlist).toBe(plain);
    await expect(indicator).toBeHidden({ timeout: 15_000 });
  } finally {
    await command('Stop Now', []);
    await request.put('/api/settings/verbosePlaylistItemDetails',
      { data: String(verbose?.value ?? '') });
    await request.delete(`/api/playlist/${random}`);
    await request.delete(`/api/playlist/${plain}`);
  }
});
