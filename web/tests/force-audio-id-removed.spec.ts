import { test, expect } from './fixtures';

// Regression: 59568a509 (ForceAudioId removed). Nothing had read the setting
// since the SDL output was removed in e8279e3cc, yet the Simple Audio settings
// still offered "Force Audio Card ID" (Advanced and up), and upgrade 109 tried to
// fill it in from AudioOutput with a gawk-only awk program that never ran on
// mawk.
test('the Simple Audio settings no longer offer Force Audio Card ID', async ({ page, request }) => {
  // Developer level, so a level-2 setting would be printed if it were declared.
  await request.put('/api/settings/uiLevel', { data: '3' });
  await page.goto('/settings.php#settings-av');
  // The control: the Simple Audio group was printed (its section is hidden,
  // not left out, under the advanced PipeWire backend).
  await expect(page.locator('#simplePipeWireAudioSection #AudioPeriodSizeRow')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('#ForceAudioIdRow')).toHaveCount(0);

  const help = await (await request.get('/help/settings-av.php')).text();
  expect(help).toContain('Audio Period Size');
  expect(help, 'the help still describes the setting').not.toContain('Force Audio Card ID');
});

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: '0' });
});
