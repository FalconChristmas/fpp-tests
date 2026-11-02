import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// ShowCommandEditor() takes args.validCommands: the commands the editor may
// offer.  Nothing in FPP's own pages passes it; it is for a plugin page that
// asks for one of a few commands (a button that can only Start or Stop
// something, say).
//
// Regression: f863d73e4 ("Allow ShowCommandEditor() callers to limit commands
// shown").  The editor always listed every command.

async function open(page: Page, args: Record<string, unknown>) {
  await page.evaluate((extra) => {
    const w = window as any;
    w.ShowCommandEditor(w.$('#runCommandJSON'), { command: 'Stop Now', args: [] }, 'RunCommandSaved', '',
      { title: 'fpp-tests', saveButton: 'OK', cancelButton: 'Cancel', ...extra });
  }, args);
  const select = page.locator('#commandEditorPopup #editorCommand');
  await expect(select).toBeVisible({ timeout: 15_000 });
  await expect(select).toHaveValue('Stop Now');
  return select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''));
}

test('validCommands limits the editor to those commands', async ({ page }) => {
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).ShowCommandEditor === 'function');
  expect(await open(page, { validCommands: ['Stop Now', 'Volume Set'] })).toEqual(['Stop Now', 'Volume Set']);

  // The control: without it, every command is offered.
  await page.reload();
  await page.waitForFunction(() => typeof (window as any).ShowCommandEditor === 'function');
  const all = await open(page, {});
  expect(all.length).toBeGreaterThan(10);
  expect(all).toEqual(expect.arrayContaining(['Stop Now', 'Volume Set', 'Start Playlist']));
});
