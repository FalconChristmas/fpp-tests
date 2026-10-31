import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// Command Presets: a preset that cannot be saved as it stands is refused with
// a message and nothing is written; a presets file that is not valid JSON
// does not stop the Channel Outputs page from loading.

async function getPresets(request: APIRequestContext) {
  const r = await request.get('/api/configfile/commandPresets.json');
  return r.ok() ? r.text() : null;
}
async function putPresets(request: APIRequestContext, body: string) {
  const r = await request.post('/api/configfile/commandPresets.json', { data: Buffer.from(body) });
  expect(r.ok(), await r.text()).toBe(true);
}

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  before = await getPresets(request);
});
test.afterEach(async ({ request }) => {
  await putPresets(request, before ?? '{"commands": []}');
});

test('a preset with a name and no command is refused on Save and nothing is written', async ({ page, request }) => {
  // Regression: 169353ba7.  Save wrote every row, a nameless or commandless
  // preset included, and fppd's load of the file then failed on it.
  const good = JSON.stringify({ commands: [{ name: 'fpp-tests-ok', command: 'All Lights Off', args: [], multisyncCommand: false, multisyncHosts: '', presetSlot: 0 }] });
  await putPresets(request, good);
  await page.goto('/commandPresets.php');
  await expect(page.locator('#tblCommandsBody > tr')).toHaveCount(1);
  await page.locator('button[onclick^="AddCommand"]').click();
  await expect(page.locator('#tblCommandsBody > tr')).toHaveCount(2);
  await page.locator('#tblCommandsBody > tr').nth(1).locator('input.cmdTmplName').fill('fpp-tests-no-command');
  const dialog = page.waitForEvent('dialog');
  await page.evaluate(() => setTimeout(() => (window as any).SaveCommands(), 0));
  const d = await dialog;
  expect(d.message()).toContain('Preset Name: fpp-tests-no-command has empty FPP command');
  await d.accept();
  expect(await getPresets(request), 'a refused save still wrote the file').toBe(good);
});

test('a presets file that is not JSON still lets the Channel Outputs page load', async ({ page, request }) => {
  // Regression: 091329170.  co-other-modules.php decoded the file and used
  // the result's "commands" without checking it.
  await putPresets(request, 'this is not json {');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/channeloutputs.php#tab-other');
  await expect(page.locator('#channelOutputTabs, .nav-tabs').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify((window as any).commandPresets)), 'the page falls back to no presets').toBe('{"commands":[]}');
  expect(await page.content()).not.toMatch(/Fatal error|Warning:|Uncaught/);
});
