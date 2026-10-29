import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// Command Presets (commandPresets.php) naming a command this player doesn't
// have (a plugin's, removed or not yet installed; MQTT not configured):
// the page says so and keeps the preset as it is.  fppd, which runs the
// presets, reads the saved file.

const MISSING = 'fpp-tests Missing Plugin Command';
const PRESETS = {
  commands: [
    { name: 'fpp-tests-ok', command: 'All Lights Off', args: [], multisyncCommand: false, multisyncHosts: '', presetSlot: 0 },
    { name: 'fpp-tests-missing', command: MISSING, args: ['a', 'b'], multisyncCommand: false, multisyncHosts: '', presetSlot: 0 },
  ],
};

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
  await putPresets(request, JSON.stringify(PRESETS));
});
test.afterEach(async ({ request }) => {
  await putPresets(request, before ?? '{"commands": []}');
});

test('a preset with an unavailable command is flagged, shown as unavailable, and kept by a save', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/commandPresets.php');
  const rows = page.locator('#tblCommandsBody > tr');
  await expect(rows).toHaveCount(2);
  const [ok, missing] = [rows.nth(0), rows.nth(1)];
  await expect(ok.locator('input.cmdTmplName')).toHaveValue('fpp-tests-ok');
  await expect(missing.locator('input.cmdTmplName')).toHaveValue('fpp-tests-missing');

  // Feature: 449f0b48d.  A warning names the preset and its command, and its
  // row is marked; the preset's tooltip says the command isn't available.
  // Before, the tooltip looked the command's arguments up in the command list
  // and threw, so nothing marked the preset.
  const warning = page.locator('#commandPresetsWarning');
  await expect(warning).toContainText('reference commands that are not currently available');
  await expect(warning.locator('li')).toHaveCount(1);
  await expect(warning.locator('li')).toContainText(`fpp-tests-missing - Command: ${MISSING}`);
  await expect(missing).toHaveClass(/commandPresetInvalidCommand/);
  await expect(ok).not.toHaveClass(/commandPresetInvalidCommand/);
  await expect(missing.locator('.cmdTmplTooltipIcon')).toHaveAttribute('data-bs-original-title', /WARNING: Command not available/);
  expect(errors).toEqual([]);

  // Feature: c3b0f4b80.  The command picker shows the unavailable command
  // (disabled, so it can't be picked for another preset) rather than nothing.
  const picker = missing.locator('select.cmdTmplCommand');
  await expect(picker).toHaveValue(MISSING);
  const option = picker.locator('option.invalidCommandOption');
  await expect(option).toHaveText(`${MISSING} (unavailable)`);
  await expect(option).toBeDisabled();
  await expect(ok.locator('select.cmdTmplCommand option.invalidCommandOption')).toHaveCount(0);

  // A save of the page keeps the preset with its command and arguments.
  let alerted = '';
  page.on('dialog', (d) => { alerted = d.message(); d.dismiss(); });
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' &&
    new URL(r.url()).pathname === '/api/configfile/commandPresets.json', { timeout: 5_000 }).catch(() => null);
  await page.locator('button[value="Save"]').first().click();
  expect(await saved, `no save was sent (${alerted})`).not.toBeNull();
  const stored = JSON.parse((await getPresets(request))!);
  expect(stored.commands.map((c: any) => [c.name, c.command, c.args])).toEqual([
    ['fpp-tests-ok', 'All Lights Off', []],
    ['fpp-tests-missing', MISSING, ['a', 'b']],
  ]);
  // fppd, which triggers presets by name, has both.
  await expect.poll(async () => (await (await request.get('/api/commandPresets?names=true')).json()).slice().sort(),
    { timeout: 10_000 }).toEqual(expect.arrayContaining(['fpp-tests-missing', 'fpp-tests-ok']));
});
