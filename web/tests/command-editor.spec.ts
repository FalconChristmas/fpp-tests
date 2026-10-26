import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The command editor, opened as the Run FPP Command dialog: the command list
// (grouped by category, filtered by UI level), the arguments fppd describes
// for each command (help tooltips, content lists), and the If command's Then
// Run list.  fppd's /api/commands is where the editor gets all of it, and
// what the dialog runs goes to fppd, whose variables and effects show what ran.

const PRESETS = 'api/configfile/commandPresets.json';
const INSTANT = 'api/configfile/instantCommand.json';

async function keep(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  return r.ok() ? await r.text() : null;
}
async function put(request: APIRequestContext, path: string, body: unknown) {
  const r = await request.post(path, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

let saved: Record<string, string | null> = {};
let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  saved = { [PRESETS]: await keep(request, PRESETS), [INSTANT]: await keep(request, INSTANT) };
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
});
test.afterEach(async ({ request }) => {
  for (const [path, body] of Object.entries(saved)) await put(request, path, body ?? '{}');
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function openDialog(page: Page) {
  await page.goto('/index.php');
  const presets = page.waitForResponse((r) => r.url().includes('commandPresets.json'));
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  await presets;
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toBeVisible({ timeout: 15_000 });
  return dialog;
}

async function commands(request: APIRequestContext): Promise<any[]> {
  return (await request.get('/api/commands')).json();
}

const variable = async (request: APIRequestContext, name: string) =>
  ((await (await request.get('/api/variables')).json()) ?? {})[name]?.value;

test('the command list is grouped by category and leaves out commands above the UI level', async ({ page, request }) => {
  // Feature: 660c784c9.  fppd gives each command a category and a level
  // (0 Basic .. 3 Developer); the editor groups the list by category and
  // offers only what the UI level allows -- except the command already set,
  // which stays selectable at any level.
  const all = await commands(request);
  const above = all.filter((c) => (c.level ?? 0) > 0);
  expect(all.every((c) => typeof c.category === 'string' && c.category !== ''), 'every command has a category').toBe(true);
  expect(above.length, 'fppd marks some commands above Basic').toBeGreaterThan(0);

  const grouped = async (page: Page) => page.locator('#editorCommand optgroup').evaluateAll((gs) =>
    Object.fromEntries(gs.map((g: any) => [g.label, Array.from(g.querySelectorAll('option')).map((o: any) => o.value)])));
  const want = (level: number) => {
    const g: Record<string, string[]> = {};
    for (const c of all.filter((c) => (c.level ?? 0) <= level)) (g[c.category] ??= []).push(c.name);
    return g;
  };

  for (const level of [0, 1, 3]) {
    await request.put('/api/settings/uiLevel', { data: String(level) });
    await put(request, INSTANT, { command: 'Volume Set', args: ['50'] });
    await openDialog(page);
    expect(await grouped(page), `uiLevel ${level}`).toEqual(want(level));
  }

  // A saved command above the level is kept, selected.
  const advanced = above[0];
  await request.put('/api/settings/uiLevel', { data: '0' });
  await put(request, INSTANT, { command: advanced.name, args: [] });
  const dialog = await openDialog(page);
  await expect(dialog.locator('#editorCommand')).toHaveValue(advanced.name);
});

test.describe('argument help', () => {
  const tooltip = (page: Page) => page.locator('.tooltip');

  test('Start Playlist and FSEQ Effect Start explain If Not Running, and the Multisync box says what it does', async ({ page, request }) => {
    // Feature: d72ba3cf3.  A command argument can carry help text, which
    // fppd sends in /api/commands and the editor shows as a tooltip on an
    // icon by the argument.
    const help = 'Checks to see if this exact item is already running and prevents it from running again.';
    const all = await commands(request);
    for (const name of ['Start Playlist', 'FSEQ Effect Start']) {
      expect(all.find((c) => c.name === name).args.find((a: any) => a.name === 'ifNotRunning').help, name).toBe(help);
    }
    for (const name of ['Start Playlist', 'FSEQ Effect Start']) {
      await put(request, INSTANT, { command: name, args: [] });
      const dialog = await openDialog(page);
      const row = dialog.locator('#tblCommandEditor tr').filter({ hasText: 'If Not Running' });
      await row.locator('.argHelpIcon').hover();
      await expect(tooltip(page).filter({ hasText: help }), name).toBeVisible();
      await dialog.locator('#tblCommandEditor_multisync_row .argHelpIcon').hover();
      await expect(tooltip(page).filter({ hasText: 'Send this command to multiple FPP instances' }), name).toBeVisible();
    }
  });

  test('a help tooltip showing when the command is changed goes with its row', async ({ page, request }) => {
    // Regression: 3a9445dce.  Bootstrap puts a tooltip's popup in <body> and
    // tracks it apart from jQuery, so removing the argument rows for a new
    // command left a showing tooltip behind, which nothing would hide again.
    await put(request, INSTANT, { command: 'Start Playlist', args: [] });
    const dialog = await openDialog(page);
    await dialog.locator('#tblCommandEditor tr').filter({ hasText: 'If Not Running' }).locator('.argHelpIcon').hover();
    await expect(tooltip(page)).toHaveCount(1);
    await dialog.locator('#editorCommand').selectOption('Volume Set');
    await expect(dialog.locator('#tblCommandEditor')).toContainText('Volume');
    await page.waitForTimeout(500);
    await expect(tooltip(page), 'tooltips left in the page').toHaveCount(0);
  });
});

test('a Command Preset picked into an If\'s Then Run list runs as the preset is when the If runs', async ({ page, request }) => {
  // Regression: 594b7fcd7 (the If half; gpio-command-cards.spec.ts has the
  // GPIO one).  Picking a preset for a command list copied the preset's
  // command into it, so an edit of the preset later never reached the If.
  // It now adds Trigger Command Preset with the preset's name.  The receiving
  // end is fppd running the If: after the preset is changed, the If sets the
  // variable to the preset's new value.
  const VAR = 'fppTestsIfPreset';
  const PRESET = 'fpp-tests if preset';
  const preset = (value: string) => ({ commands: [{ name: PRESET, presetSlot: 0,
    command: 'Set Variable', args: [VAR, 'Value', value, '1', '0', '100', ''] }] });
  // A group, as the editor saves a Check: the editor cannot open a bare
  // condition at the top (BackendJSONToTree gives it no items), though fppd
  // runs one.
  const TRUE = { op: 'AND', not: false, conditions: [{ source: 'Expression', name: '1', comparator: 'equal to', value: '1', not: false }] };
  await put(request, PRESETS, preset('first'));
  await put(request, INSTANT, { command: 'If', args: [JSON.stringify(TRUE), '[]', 'Sequential', '', 'Sequential'] });
  const dialog = await openDialog(page);
  await expect(dialog.locator('#editorCommand')).toHaveValue('If');

  // Then Run is the If's first command list.
  await dialog.locator('#tblCommandEditor input[value="+ Add Command"]').first().click();
  await expect(dialog.locator('#btnSaveEditorCommand')).toHaveValue('Add Command', { timeout: 15_000 });
  await dialog.locator('#presetNames').selectOption(PRESET);
  await expect(dialog.locator('#editorCommand')).toHaveValue('Trigger Command Preset');
  await expect(dialog.locator('#btnSaveDirectEditorCommand')).toBeHidden();
  await dialog.locator('#btnSaveEditorCommand').click();

  // The If's editor comes back with the reference in its list.
  await expect(dialog.locator('#editorCommand')).toHaveValue('If', { timeout: 15_000 });
  await expect(dialog.locator('.cmdListLabel')).toHaveText(`Trigger Command Preset: ${PRESET}`);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /api\/command(\?|$)/.test(r.url()));
  await dialog.locator('#btnSaveEditorCommand').click();
  const ran = JSON.parse((await sent).postData() || '{}');
  expect(JSON.parse(ran.args[1]).map((c: any) => ({ command: c.command, args: c.args })))
    .toEqual([{ command: 'Trigger Command Preset', args: [PRESET] }]);
  await expect.poll(() => variable(request, VAR), { timeout: 10_000 }).toBe('first');

  // The preset changes; the same If now does what it does now.
  await put(request, PRESETS, preset('second'));
  await page.waitForTimeout(1500); // fppd reloads the presets when the file changes
  expect((await request.post('/api/command', { data: ran })).ok()).toBe(true);
  await expect.poll(() => variable(request, VAR), { timeout: 10_000 }).toBe('second');
});

test.describe('Effect Stop', () => {
  test.skip(!container, 'puts an effect and a sequence in the run-web.sh container\'s media');
  const EFFECT = 'fpp-tests-stop-fx';
  const SEQUENCE = 'fpp-tests-stop-seq';
  const MEDIA = '/home/fpp/media';

  test.beforeEach(() => {
    // A 3-channel effect of 40 frames at channel 1 (scenarios/eseq.py's format).
    inPlayer('python3', '-c', `import struct
frames = b"".join(bytes([i % 250 + 1] * 3) for i in range(40))
open("${MEDIA}/effects/${EFFECT}.eseq", "wb").write(b"ESEQ" + struct.pack("<B3xIII", 1, 3, 1, 3) + frames)`);
    inPlayer('sh', '-c', `: > ${MEDIA}/sequences/${SEQUENCE}.fseq`);
  });
  test.afterEach(async ({ request }) => {
    await request.post('/api/command', { data: { command: 'Effects Stop', args: [] } });
    inPlayer('rm', '-f', `${MEDIA}/effects/${EFFECT}.eseq`, `${MEDIA}/sequences/${SEQUENCE}.fseq`);
  });

  test('its Effect Name offers the effects there are, and the one picked is stopped', async ({ page, request }) => {
    // Feature: 4e6792da2 ("Tidy up Effect Stop command").  Effect Name was a
    // free-text datalist filled from api/effects/ALL, which lists sequences
    // too; it is now a list of the effects (api/effects).
    const arg = (await commands(request)).find((c) => c.name === 'Effect Stop').args[0];
    expect(arg).toMatchObject({ name: 'effect', type: 'string', contentListUrl: 'api/effects' });

    const start = await request.post('/api/command', { data: { command: 'Effect Start', args: [EFFECT, '1', 'true', 'false', 'false'] } });
    expect(start.ok()).toBe(true);
    const running = async () => ((await (await request.get('/api/fppd/effects')).json()).runningEffects ?? []).map((e: any) => e.name);
    await expect.poll(running, { timeout: 10_000 }).toContain(EFFECT);

    await put(request, INSTANT, { command: 'Effect Stop', args: [] });
    const dialog = await openDialog(page);
    const name = dialog.locator('#tblCommandEditor_arg_1');
    await expect(name).toHaveJSProperty('tagName', 'SELECT');
    const offered = await name.locator('option').evaluateAll((os) => os.map((o: any) => o.value));
    expect(offered).toContain(EFFECT);
    expect(offered, 'sequences are not effects').not.toContain(SEQUENCE);
    await name.selectOption(EFFECT);
    await dialog.locator('#btnSaveEditorCommand').click();
    await expect.poll(running, { timeout: 10_000 }).not.toContain(EFFECT);
  });
});

test('Set Variable warns that a bare name in Expression is stored as text, and ticks a formula', async ({ page, request }) => {
  // Regression: 986fa2943.  An Expression that does not start with "=" is
  // stored verbatim, so a bare variable name becomes the literal text, yet
  // the editor showed it a green check.  fppd now says how it reads the
  // field (kind "literal"), and the editor warns.  The receiving end: what
  // fppd stores when each one runs.
  const VAR = 'fppTestsSetVarKind';
  await request.post('/api/command', { data: { command: 'Set Variable', args: ['fppTestsCount', 'Value', '10', '1', '0', '100', '', 'false'] } });
  await put(request, INSTANT, { command: 'Set Variable', args: [VAR, 'Expression', '', '1', '0', '100', 'fppTestsCount', 'false'] });
  const dialog = await openDialog(page);
  const expr = dialog.locator('#tblCommandEditor .arg_expression');
  const icon = dialog.locator('#tblCommandEditor .expressionValidIcon i');

  await expr.fill('fppTestsCount');
  await expect(icon).toHaveClass(/fa-triangle-exclamation/);
  await expect(icon).toHaveAttribute('title', /Stored as literal text/);
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect.poll(() => variable(request, VAR), { timeout: 10_000 }).toBe('fppTestsCount');

  await put(request, INSTANT, { command: 'Set Variable', args: [VAR, 'Expression', '', '1', '0', '100', '=fppTestsCount+1', 'false'] });
  const again = await openDialog(page);
  await again.locator('#tblCommandEditor .arg_expression').fill('=fppTestsCount+1');
  await expect(again.locator('#tblCommandEditor .expressionValidIcon i')).toHaveClass(/fa-check/);
  await again.locator('#btnSaveEditorCommand').click();
  await expect.poll(() => variable(request, VAR), { timeout: 10_000 }).toBe('11');
});
