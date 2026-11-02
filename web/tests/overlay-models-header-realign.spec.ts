import { test, expect } from './fixtures';
import { container } from './container';

// The Pixel Overlay Models page pins its table heading (Zebra pin, restyled by
// common_ViewPortChange).  Rows added or removed change the table's size, so
// the page has to ask for the heading to be redone.  The page's read of the
// model list is answered here; nothing is saved to the player.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const model = (name: string) => ({
  Name: name, Type: 'Channel', StartChannel: 1, ChannelCount: 18, ChannelCountPerNode: 3,
  Orientation: 'horizontal', StartCorner: 'TL', StringCount: 1, StrandsPerString: 1,
});

test('adding and deleting a model row re-pins the table heading', async ({ page }) => {
  // Regression: 32fd7fc66.  Add and Delete changed the table's rows without
  // calling common_ViewPortChange, so the pinned column headings stayed sized
  // for the old rows and no longer lined up with the columns.
  await page.route((u) => u.pathname.endsWith('/api/overlays/models'), async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: [model('fpp-tests-one'), model('fpp-tests-two')] });
  });
  await page.goto('/pixeloverlaymodels.php');
  const rows = page.locator('#channelMemMaps tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const w = window as any;
    w.fppTestsViewPort = 0;
    const orig = w.common_ViewPortChange;
    w.common_ViewPortChange = function (...a: unknown[]) { w.fppTestsViewPort++; return orig.apply(this, a); };
  });
  const calls = () => page.evaluate(() => (window as any).fppTestsViewPort as number);
  const count = await rows.count();

  await page.locator('button[value="Add"]').click();
  const dlg = page.locator('#AddPixelOverlayModel');
  await dlg.waitFor({ state: 'visible' });
  await page.waitForTimeout(500); // Bootstrap drops a hide asked for during the show transition
  await dlg.getByRole('button', { name: 'Channel' }).click();
  await expect(rows).toHaveCount(count + 1);
  expect(await calls(), 'after Add').toBeGreaterThan(0);

  const afterAdd = await calls();
  await rows.first().locator('td').first().click({ position: { x: 2, y: 2 } });
  await expect(rows.first()).toHaveClass(/selectedEntry/);
  await page.locator('#btnDelete').click();
  await expect(rows).toHaveCount(count);
  expect(await calls(), 'after Delete').toBeGreaterThan(afterAdd);
});
