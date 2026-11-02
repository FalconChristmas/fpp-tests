import { test, expect } from './fixtures';

// The Model Name list on the Display Testing page (testing.php) sets the
// start and end channel the test covers.

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

test('the whole-range entries of the Model Name list set their channel range', async ({ page, request }) => {
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
  try {
    await expect(list.locator('option')).not.toHaveCount(2, { timeout: 15_000 });
  } catch (e) {
    // Seen once in a long serial run, not reproducible alone: say what fppd
    // was serving so the next one can be told from a page problem.
    const models = await (await request.get('/api/models')).text().catch((x) => `error ${x}`);
    const status = await (await request.get('/api/fppd/status')).text().catch((x) => `error ${x}`);
    throw new Error(`no models on the Model Name list; /api/models: ${models.slice(0, 500)}; status: ${status.slice(0, 300)}\n${e}`);
  }
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
