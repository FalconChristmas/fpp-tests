import { test, expect } from './fixtures';

// The Output Processors page: select rows in the table (click, Ctrl-click to
// add one, Shift-click for a range) and Delete removes the selected rows.
// The Delete button is enabled only while a row is selected.  Nothing here
// saves: the page's table is what is checked.

const rows = (page: import('@playwright/test').Page) => page.locator('#outputProcessorsBody > tr');
const descriptions = (page: import('@playwright/test').Page) => rows(page).locator('input.description').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
// A click on the row's number cell, not on one of its inputs.
const pick = (page: import('@playwright/test').Page, n: number, modifiers: ('Control' | 'Shift')[] = []) =>
  rows(page).nth(n).locator('td').first().click({ modifiers });

test('Delete removes every selected row, and is enabled only while a row is selected', async ({ page }) => {
  // Regression: 013d37322 (#1305).  Delete removed one row by its position, and
  // Ctrl- or Shift-clicking rows to select several still deleted one.  (The
  // button's state is also kept by the table's own row-selection setup, so
  // dropping the page's mousedown handler alone does not turn that part red.)
  await page.route((u) => u.pathname.endsWith('/api/channel/output/processors'), (route) =>
    route.fulfill({ json: { outputProcessors: [] } }));
  await page.goto('/outputprocessors.php');
  await expect(page.locator('#outputProcessorsBody')).toBeAttached();
  await expect(rows(page)).toHaveCount(0);
  for (const name of ['one', 'two', 'three', 'four']) {
    await page.locator('button', { hasText: 'Add' }).first().click();
    await rows(page).last().locator('input.description').fill(name);
  }
  await expect(rows(page)).toHaveCount(4);
  const del = page.locator('#btnDelete');
  await expect(del, 'nothing selected yet').toHaveClass(/disableButtons/);

  // One row: selecting it enables Delete, selecting it again turns it off.
  await pick(page, 1);
  await expect(rows(page).nth(1)).toHaveClass(/selectedEntry/);
  await expect(del).toBeEnabled();
  await expect(del).not.toHaveClass(/disableButtons/);
  await pick(page, 1);
  await expect(rows(page).nth(1)).not.toHaveClass(/selectedEntry/);
  await expect(del).toHaveClass(/disableButtons/);
  await expect(del).toBeDisabled();

  // Two rows that are not next to each other.
  await pick(page, 0);
  await pick(page, 2, ['Control']);
  await expect(page.locator('#outputProcessorsBody > tr.selectedEntry')).toHaveCount(2);
  await del.click();
  expect(await descriptions(page), 'both selected rows go, the others stay').toEqual(['two', 'four']);
  await expect(del, 'no selection after a delete').toHaveClass(/disableButtons/);
  // The rows are renumbered.
  await expect(rows(page).locator('td:first-child')).toHaveText(['1', '2']);
});
