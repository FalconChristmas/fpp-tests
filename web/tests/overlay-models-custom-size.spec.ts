import { test, expect } from './fixtures';
import { container } from './container';

// The Orientation column of the Pixel Overlay Models page
// (pixeloverlaymodels.php).  The page's read of the model list is answered
// here; nothing is saved to the player.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const model = (name: string, extra: object) => ({
  Name: name, Type: 'Channel', StartChannel: 1, ChannelCount: 18, ChannelCountPerNode: 3,
  Orientation: 'horizontal', StartCorner: 'TL', StringCount: 1, StrandsPerString: 1, ...extra,
});

test('a custom model\'s Orientation cell gives its grid size', async ({ page }) => {
  // Regression: 5ebcb9c38.  A custom model's cell read just "Custom", so
  // models drawn from a different grid looked alike; it now reads
  // "custom <columns> x <rows>" (the model's data is rows split by ";" and
  // cells by ",").
  await page.route((u) => u.pathname.endsWith('/api/overlays/models'), async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: [
      model('fpp-tests-custom', { Orientation: 'custom', data: 'a,b,c;d,e,f' }),
      model('fpp-tests-wide', { Orientation: 'custom', data: '1,2,3,4,5;6,7,8,9,10;11,12,13,14,15' }),
      model('fpp-tests-plain', {}),
    ] });
  });
  await page.goto('/pixeloverlaymodels.php');
  const cell = (name: string) => page.locator('#channelMemMaps tr', { has: page.locator(`input.blk[value="${name}"]`) })
    .locator('td:has(select.orientation)');
  await expect(cell('fpp-tests-custom')).toBeVisible({ timeout: 15_000 });
  const text = async (name: string) => ((await cell(name).locator('b').textContent()) ?? '').replace(/ /g, ' ');
  expect(await text('fpp-tests-custom')).toBe('custom 3 x 2');
  expect(await text('fpp-tests-wide')).toBe('custom 5 x 3');
  await expect(cell('fpp-tests-plain').locator('b'), 'the control: a plain model has no custom label').toHaveCount(0);
});
