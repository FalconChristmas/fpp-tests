import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// CopyTextToClipboard() in js/fpp.js: on a player reached over plain HTTP
// there is no navigator.clipboard, and it copies through a hidden textarea
// and document.execCommand('copy').  The Variables page's copy button shows
// a check mark once the name is copied.  The test takes navigator.clipboard
// away, as plain HTTP does, and has execCommand('copy') copy or fail.

const NAME = 'fpp-tests-copy-me';

async function openVariables(page: Page, copyWorks: boolean | 'real') {
  await page.addInitScript((works) => {
    Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
    if (works !== 'real') {
      const real = document.execCommand.bind(document);
      document.execCommand = (cmd: string, ...rest: any[]) => {
        if (cmd !== 'copy') return real(cmd, ...rest);
        const ta = document.querySelector('textarea[readonly]') as HTMLTextAreaElement | null;
        (window as any).__fppTestsCopied = ta?.value;
        return works as boolean;
      };
    }
    // Whether the button ever showed its check mark: it only does for a second.
    new MutationObserver(() => {
      if (document.querySelector('.variableCopyBtn i.fa-check')) (window as any).__fppTestsSawCheck = true;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }, copyWorks);
  await page.goto('/variables.php');
  const row = page.locator('#variablesTableBody tr', { has: page.locator(`code[data-full="${NAME}"]`) });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  return row.locator('.variableCopyBtn');
}

test.beforeEach(async ({ request }) => {
  const r = await request.post(`/api/variables/${NAME}?persist=false`, { data: 'x', headers: { 'Content-Type': 'text/plain' } });
  expect(r.ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/api/variables/${NAME}`);
});

test('a copy that fails is reported, not shown as copied', async ({ page }) => {
  // Regression: 4bb984051.  CopyTextToClipboard() ignored what
  // execCommand('copy') returned and resolved either way, and the button
  // showed its check mark without waiting for it.
  const button = await openVariables(page, false);
  await button.click();
  // The control: the copy was tried, with the name.
  await expect.poll(() => page.evaluate(() => (window as any).__fppTestsCopied)).toBe(NAME);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__fppTestsSawCheck ?? false)).toBe(false);
  await expect(page.locator('.jGrowl-notification', { hasText: 'Could not copy to the clipboard' })).toBeVisible();
});

test('a copy that works shows the check mark and puts the name on the clipboard', async ({ page, context }) => {
  // The control for the test above, through the browser's own
  // execCommand('copy'), read back from the clipboard.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const button = await openVariables(page, 'real');
  await button.click();
  await expect(button.locator('i')).toHaveClass(/fa-check/);
  await expect(page.locator('.jGrowl-notification', { hasText: 'Could not copy' })).toHaveCount(0);
  const reader = await context.newPage();
  await reader.goto('/variables.php');
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(NAME);
});
