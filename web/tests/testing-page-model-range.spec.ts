import { test, expect } from './fixtures';

// The Model Name list on the Display Testing page (testing.php) sets the
// start and end channel the test covers.

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

test('the whole-range entries of the Model Name list set their channel range', async ({ page }) => {
  // Regression: 70edab506.  The "All Local Channels" and "All Channels"
  // entries hold their range as "<start>,<end>", and the page read it as a
  // model number: it looked up the model that number named, found none and
  // failed with a script error, leaving the range as it was.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/testing.php');
  await expect(page.locator('#testModeEnabled')).toBeAttached({ timeout: 15_000 });
  const list = page.locator('#modelName');
  // The models come from the API once the page is up.
  await expect(list.locator('option')).not.toHaveCount(2, { timeout: 15_000 });
  const entries = await list.locator('option').evaluateAll((os) => os.map((o: any) => [o.textContent.trim(), o.value]));
  const all = entries.find(([t]) => t === '-- All Channels --')!;
  const model = entries.find(([t]) => t === 'fpp-tests-matrix')!;
  expect(all, 'the All Channels entry').toBeTruthy();
  expect(model, 'the control: a model').toBeTruthy();
  const [start, end] = all[1].split(',');

  await list.selectOption(model[1]);
  await expect(page.locator('#testModeStartChannel')).toHaveValue('1');
  await expect(page.locator('#testModeEndChannel')).toHaveValue('150');

  await list.selectOption(all[1]);
  await expect(page.locator('#testModeStartChannel')).toHaveValue(start);
  await expect(page.locator('#testModeEndChannel')).toHaveValue(end);
  await expect(page.locator('#channelIncrement')).toHaveValue('3');
  expect(errors).toEqual([]);
});
