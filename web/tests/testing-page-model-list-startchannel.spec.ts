import { test, expect } from './fixtures';

// The Model Name list on the Display Testing page (testing.php) offers the
// models the API lists.  The models are answered here, so the shapes the
// page has to sort out are the ones the test chooses.

const model = (Name: string, Type: string, StartChannel: number) => ({
  Name, Type, StartChannel, ChannelCount: 30, StringCount: 1, ChannelCountPerNode: 3,
});

test('the Model Name list leaves out models that have no start channel', async ({ page }) => {
  // Regression: 7249e3af3.  The list skipped models by Type ("FB" and "Sub"),
  // so a model of any other Type with no channels of its own (StartChannel 0)
  // was offered, and testing it covered channels it does not own.
  await page.route((u) => u.pathname === '/api/models', (route) => route.fulfill({
    json: [
      model('fpp-tests-placed', 'Matrix', 1),
      model('fpp-tests-unplaced-other', 'Overlay', 0),
      model('fpp-tests-unplaced-sub', 'Sub', 0),
      model('fpp-tests-placed-later', 'Channel', 31),
    ],
  }));
  await page.goto('/testing.php');
  await expect(page.locator('#testModeEnabled')).toBeAttached({ timeout: 15_000 });
  const list = page.locator('#modelName');
  await expect(list.locator('option', { hasText: 'fpp-tests-placed-later' })).toHaveCount(1, { timeout: 15_000 });
  const names = await list.locator('option').evaluateAll((os) => os.map((o: any) => o.textContent.trim()));
  expect(names, 'the control: the placed models').toEqual(expect.arrayContaining(['fpp-tests-placed', 'fpp-tests-placed-later']));
  expect(names).not.toContain('fpp-tests-unplaced-other');
  expect(names).not.toContain('fpp-tests-unplaced-sub');
});
