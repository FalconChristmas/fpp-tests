import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// fpp-bootstrap's table styles, read back as the browser applies them: a
// plain .table (the variables page's) gets Bootstrap's table rules, and the
// tables Bootstrap Table builds (the file manager's, inside
// .fixed-table-body/-header) do not.  What marks the rules is what they set:
// the --bs-table-* custom properties on the table, and on each cell the
// 0.5rem padding and the inset box-shadow that paints stripes and hover.

async function tableStyles(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('table.table')).map((t) => {
    const cell = t.querySelector('th, td') as HTMLElement;
    const cs = getComputedStyle(cell);
    return {
      parent: t.parentElement?.classList.contains('fixed-table-body') ? 'fixed-table-body'
        : t.parentElement?.classList.contains('fixed-table-header') ? 'fixed-table-header' : 'plain',
      tableBg: getComputedStyle(t).getPropertyValue('--bs-table-bg').trim(),
      padding: cs.paddingLeft,
      shadow: cs.boxShadow,
    };
  }));
}

test('a plain .table gets Bootstrap\'s table styles', async ({ page }) => {
  // Regression: 18efabbf9.  fpp-bootstrap never imported Bootstrap's
  // _tables, so .table, -striped, -sm, -hover and -bordered had no styles.
  await page.goto('/variables.php');
  await expect(page.locator('#variablesTableBody')).toBeAttached();
  const plain = (await tableStyles(page)).filter((t) => t.parent === 'plain');
  expect(plain.length).toBeGreaterThan(0);
  for (const t of plain) {
    expect(t.tableBg, '--bs-table-bg').not.toBe('');
    expect(t.padding, 'cell padding').toBe('8px');
    expect(t.shadow, 'cell box-shadow').toMatch(/inset/);
  }
});

test('Bootstrap Table\'s own tables are left without them', async ({ page }) => {
  // Regression: b3567404a.  Bootstrap Table adds .table and friends to every
  // table it builds, and with the _tables import those (multisync, file
  // manager, effects, status) took on cell borders and Bootstrap's wider
  // padding they were never laid out for.
  await page.goto('/filemanager.php');
  await expect(page.locator('.fixed-table-body > table.table').first()).toBeAttached({ timeout: 15_000 });
  const built = (await tableStyles(page)).filter((t) => t.parent !== 'plain');
  expect(built.map((t) => t.parent)).toEqual(expect.arrayContaining(['fixed-table-body', 'fixed-table-header']));
  for (const t of built) {
    expect(t, t.parent).toMatchObject({ tableBg: '', padding: '0px', shadow: 'none' });
  }
});
