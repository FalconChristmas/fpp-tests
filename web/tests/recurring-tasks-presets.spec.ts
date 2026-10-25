import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The Recurring Tasks page's Command Preset column.  Tasks are saved to
// config/recurringtasks.json, and Save asks fppd to reload them: fppd's
// /api/fppd/recurringtasks is the receiving end.  The player's one preset is
// "fpp-tests event", which web_serve.py's event file becomes.

const FILE = 'api/configfile/recurringtasks.json';
const PRESET = 'fpp-tests event';

const task = (name: string, preset: string) => ({
  name, enabled: false, intervalMS: 60000, type: 'preset', preset, command: '', args: [],
  resultVariable: '', persistResult: false,
});

let before: string | null = null;

async function put(request: APIRequestContext, body: string) {
  const r = await request.post(FILE, { data: Buffer.from(body) });
  expect(r.ok(), await r.text()).toBe(true);
}

test.beforeEach(async ({ request }) => {
  const r = await request.get(FILE);
  before = r.ok() ? await r.text() : null;
});

test.afterEach(async ({ request }) => {
  await put(request, before ?? '[]');
  await request.post('api/fppd/recurringtasks', { data: { command: 'reload' } });
});

test('a task\'s preset is picked from the presets there are, and one that has gone is kept and marked', async ({ page, request }) => {
  // Feature: a8c6d4b84.  The preset was a free-text box with a datalist built
  // when the page was drawn; it is now a select filled from
  // api/commandPresets?names=true, and a saved preset that no longer exists
  // shows as a disabled "(unavailable)" entry rather than being lost.
  await put(request, JSON.stringify([task('fpp-tests kept', PRESET), task('fpp-tests orphan', 'fpp-tests gone')]));
  const names = await (await request.get('/api/commandPresets?names=true')).json();
  expect(names, 'the control: the player has the preset').toContain(PRESET);

  await page.goto('/recurringtasks.php');
  const rows = page.locator('#tblTasksBody > tr');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  const kept = rows.nth(0).locator('select.ptTmplPreset');
  await expect(kept).toHaveValue(PRESET);
  expect(await kept.locator('option').allInnerTexts()).toEqual(['', ...names]);
  const orphan = rows.nth(1).locator('select.ptTmplPreset');
  await expect(orphan).toHaveValue('fpp-tests gone');
  await expect(orphan.locator('option:checked')).toHaveText('fpp-tests gone (unavailable)');
  await expect(orphan.locator('option:checked')).toBeDisabled();

});

test('Save with an unavailable preset on the page saves every task, that one still naming it', async ({ page, request }) => {
  // Regression: a disabled option reads as null through jQuery's .val(), so
  // Save threw (null.trim()) and saved nothing while any task showed an
  // "(unavailable)" preset.  Receiving ends: the saved file, fppd's reload of
  // it, and the page reading it back.
  await put(request, JSON.stringify([task('fpp-tests kept', PRESET), task('fpp-tests orphan', 'fpp-tests gone')]));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/recurringtasks.php');
  const rows = page.locator('#tblTasksBody > tr');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(rows.nth(1).locator('select.ptTmplPreset option:checked')).toHaveText('fpp-tests gone (unavailable)');
  // An edit, so the save is seen to happen.
  await rows.nth(0).locator('.ptTmplName').fill('fpp-tests renamed');
  await page.locator('button', { hasText: /^Save$/ }).click();
  await expect.poll(async () => ((await (await request.get(FILE)).json()) as any[]).map((t) => [t.name, t.type, t.preset]),
    { timeout: 15_000, message: `page errors: ${errors.join('; ')}` })
    .toEqual([['fpp-tests renamed', 'preset', PRESET], ['fpp-tests orphan', 'preset', 'fpp-tests gone']]);
  expect(errors).toEqual([]);
  await expect.poll(async () => (((await (await request.get('/api/fppd/recurringtasks')).json())?.tasks ?? []) as any[])
    .map((t) => [t.name, t.preset]), { timeout: 15_000 })
    .toEqual([['fpp-tests renamed', PRESET], ['fpp-tests orphan', 'fpp-tests gone']]);
  await page.reload();
  await expect(rows.nth(1).locator('select.ptTmplPreset option:checked')).toHaveText('fpp-tests gone (unavailable)', { timeout: 15_000 });
});

test('a task saved with a preset picked from the list reloads with it, and fppd runs the saved task list', async ({ page, request }) => {
  // Feature: a8c6d4b84, the receiving ends: the saved file, fppd's reload
  // of it, and the page reading it back.
  await put(request, JSON.stringify([task('fpp-tests kept', '')]));
  await page.goto('/recurringtasks.php');
  const row = page.locator('#tblTasksBody > tr').first();
  const preset = row.locator('select.ptTmplPreset');
  await expect(preset).toHaveValue('', { timeout: 15_000 });
  await preset.selectOption(PRESET);
  await row.locator('.ptTmplName').fill('fpp-tests saved');
  await page.locator('button', { hasText: /^Save$/ }).click();
  await expect.poll(async () => ((await (await request.get(FILE)).json()) as any[]).map((t) => [t.name, t.type, t.preset]),
    { timeout: 15_000 }).toEqual([['fpp-tests saved', 'preset', PRESET]]);
  await expect.poll(async () => (((await (await request.get('/api/fppd/recurringtasks')).json())?.tasks ?? []) as any[])
    .map((t) => t.name), { timeout: 15_000 }).toEqual(['fpp-tests saved']);
  await page.reload();
  await expect(page.locator('#tblTasksBody > tr').first().locator('select.ptTmplPreset')).toHaveValue(PRESET, { timeout: 15_000 });
});
