import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

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

// The page's "All Local Channels" entry and its starting range come from the
// channel ranges fppd wrote to fpp-info.json: the lowest start to the highest
// end of them, each "<first>-<last>", 0-based.
test('All Local Channels spans every local channel range, not just the first', async ({ request }) => {
  // Regression: 9bc483a6e ("Fix channel range on test page to include the
  // entire range").  Each range was split out of the whole list instead of
  // itself, so with two ranges the page offered 1-100 for "0-99,200-299".
  test.skip(!container, 'writes fpp-info.json inside the run-web.sh container');
  const INFO = '/home/fpp/media/fpp-info.json';
  const before = inPlayer('sh', '-c', `cat ${INFO} 2>/dev/null || true`);
  let info: Record<string, unknown> = {};
  try { info = JSON.parse(before); } catch { /* none yet */ }
  try {
    putFile(INFO, JSON.stringify({ ...info, channelRanges: '0-99,200-299' }));
    const html = await (await request.get('/testing.php')).text();
    expect(html).toMatch(/<option value='1,300'>-- All Local Channels --/);
    expect(html).toMatch(/value='1' id='testModeStartChannel'/);
    expect(html).toMatch(/value='300' id='testModeEndChannel'/);
    // The control: one range.
    putFile(INFO, JSON.stringify({ ...info, channelRanges: '10-19' }));
    expect(await (await request.get('/testing.php')).text()).toMatch(/<option value='1,20'>-- All Local Channels --/);
  } finally {
    if (before) putFile(INFO, before);
    else inPlayer('rm', '-f', INFO);
  }
});
