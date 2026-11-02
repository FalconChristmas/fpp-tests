import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A command argument of type range is a slider; the editor shows its current
// value beside it.

async function openWithRangeCommand(page: Page, request: any) {
  const real = await (await request.get('/api/commands')).json();
  const stub = {
    name: 'Range Test', description: 'slider', args: [
      { name: 'Level', description: 'Level', type: 'range', min: 5, max: 95, default: '40' },
    ],
  };
  await page.route((u) => u.pathname === '/api/commands', (route) => route.fulfill({ json: [...real, stub] }));
  await page.goto('/index.php');
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toBeVisible({ timeout: 15_000 });
  await dialog.locator('#editorCommand').selectOption('Range Test');
  return dialog;
}

test('a range argument shows its value beside the slider and follows it', async ({ page, request }) => {
  // Regression: f623de8ee.  The slider had no number beside it, so a setting
  // such as a brightness level could not be read, only dragged.  The value
  // shows the default, follows input, and follows a value loaded from a
  // saved command (a programmatic set plus change()).
  const dialog = await openWithRangeCommand(page, request);
  const slider = dialog.locator('input[type=range]');
  const shown = dialog.locator('span[id$=CurrentValue]');
  await expect(slider).toHaveValue('40');
  await expect(shown).toHaveText('40');

  // Dragging fires input events as it moves, and change only on release.
  await slider.evaluate((el: HTMLInputElement) => { el.value = '73'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(shown).toHaveText('73');

  // Loading a saved value sets the slider and fires change.
  await slider.evaluate((el: HTMLInputElement) => { $(el).val('12').change(); });
  await expect(shown).toHaveText('12');
});
