import { test, expect } from './fixtures';

// The Output Processors page asks fppd for the model list to fill its model
// pickers; when that request fails the page still comes up, with the one
// "<Use Start Channel>" choice (Regression: a7a88ea03, where a failed
// request left the page empty).

test('a failed model list still leaves the page with its start-channel choice', async ({ page }) => {
  await page.route('**/api/models?simple=true', (route) => route.abort());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/outputprocessors.php');
  await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).models))).toBe('["&lt;Use Start Channel&gt;"]');
  // the page is set up: its table can take a new row
  await expect(page.locator('#outputProcessorsBody')).toBeAttached();
  expect(errors).toEqual([]);
});
