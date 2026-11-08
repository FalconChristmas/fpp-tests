import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Recurring Tasks page (recurringtasks.php) beyond its Command Preset
// column (recurring-tasks-presets.spec.ts): the FPP Command task type with
// its Result Variable and output filters, the checks Save makes, Add and
// Delete, and what the page says when the load or the reload goes wrong.
// Tasks are saved to config/recurringtasks.json; Save then asks fppd to
// reload them (POST api/fppd/recurringtasks {command: "reload"}).

const FILE = 'api/configfile/recurringtasks.json';
const ON_DISK = '/home/fpp/media/config/recurringtasks.json';
const PRESET = 'fpp-tests event';

let before: string | null = null;

async function put(request: APIRequestContext, tasks: unknown) {
  const r = await request.post(FILE, { data: Buffer.from(JSON.stringify(tasks)) });
  expect(r.ok(), await r.text()).toBe(true);
}
const saved = async (request: APIRequestContext) => (await request.get(FILE)).json();

const presetTask = (name: string, o: Record<string, unknown> = {}) => ({
  name, enabled: false, intervalMS: 60000, type: 'preset', preset: PRESET, command: '', args: [],
  resultVariable: '', persistResult: false, ...o,
});

test.beforeEach(async ({ request }) => {
  const r = await request.get(FILE);
  before = r.ok() ? await r.text() : null;
});

test.afterEach(async ({ request }) => {
  await request.post(FILE, { data: Buffer.from(before ?? '[]') });
  await request.post('api/fppd/recurringtasks', { data: { command: 'reload' } });
});

async function openPage(page: Page, rows: number) {
  await page.goto('/recurringtasks.php');
  await expect(page.locator('#tblTasksBody > tr')).toHaveCount(rows, { timeout: 15_000 });
  return page.locator('#tblTasksBody > tr');
}

async function save(page: Page) {
  await page.locator('button', { hasText: /^Save$/ }).click();
}

test('FPP Command tasks, with their Result Variable and filters, are saved back as they were', async ({ page, request }) => {
  // The command and its arguments come from the player's command list; the
  // ones here are the ones its "fpp-tests event" preset uses.
  const preset = ((await (await request.get('/api/configfile/commandPresets.json')).json()).commands as any[])
    .find((c) => c.name === PRESET);
  expect(preset, 'the control: the player has the preset').toBeTruthy();
  const tasks = [
    { name: 'fpp-tests regex', enabled: false, intervalMS: 90000, type: 'command', preset: '',
      command: preset.command, args: preset.args, resultVariable: 'fppTestsResult', persistResult: true,
      filterType: 'regex', filterJsonPath: '', filterBetweenStart: '', filterBetweenEnd: '', filterRegex: 'temp=(\\d+)' },
    { name: 'fpp-tests json', enabled: true, intervalMS: 3600000, type: 'command', preset: '',
      command: preset.command, args: preset.args, resultVariable: 'fppTestsJson', persistResult: false,
      filterType: 'json', filterJsonPath: 'status.value', filterBetweenStart: '', filterBetweenEnd: '', filterRegex: '' },
    presetTask('fpp-tests preset', { enabled: true, intervalMS: 30000 }),
  ];
  await put(request, tasks);
  const rows = await openPage(page, 3);
  await expect(rows.nth(0).locator('.cmdTmplCommand')).toHaveValue(preset.command);
  await expect(rows.nth(0).locator('.ptTmplIntervalSec')).toHaveValue('90');
  await expect(rows.nth(0).locator('.ptTmplEnabled')).not.toBeChecked();
  await expect(rows.nth(1).locator('.ptTmplFilterType')).toHaveValue('json');

  const growl = page.locator('#jGrowl');
  await save(page);
  await expect(growl).toContainText('Recurring tasks saved and reloaded.');
  expect(await saved(request)).toEqual(tasks);
});

test('Save refuses a task without a name, a name used twice, or one with nothing to run, and saves nothing', async ({ page, request }) => {
  const original = [presetTask('fpp-tests one'), presetTask('fpp-tests two')];
  await put(request, original);
  const rows = await openPage(page, 2);
  const said: string[] = [];
  page.on('dialog', (d) => { said.push(d.message()); d.accept(); });

  const cases: [(p: Page) => Promise<void>, string][] = [
    [async () => { await rows.nth(0).locator('.ptTmplName').fill('  '); }, 'A task is missing a Name and will not be saved.'],
    [async () => { await rows.nth(1).locator('.ptTmplName').fill('fpp-tests one'); },
      'Task name "fpp-tests one" is used more than once - names must be unique.'],
    [async () => { await rows.nth(1).locator('.ptTmplPreset').selectOption(''); }, 'Task "fpp-tests two" has no Command Preset selected.'],
    [async () => { await rows.nth(1).locator('.ptTmplType').selectOption('command'); },
      'Task "fpp-tests two" has no FPP Command selected.'],
  ];
  for (const [change, message] of cases) {
    await page.reload();
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await expect(rows.nth(1).locator('.ptTmplPreset')).toHaveValue(PRESET);
    said.length = 0;
    await change(page);
    await save(page);
    await expect.poll(() => said.join('\n')).toContain(message);
    expect(await saved(request), message).toEqual(original);
  }
});

test('Add puts a new task on the page and Save keeps it; Delete takes the selected one out', async ({ page, request }) => {
  await put(request, [presetTask('fpp-tests first')]);
  const rows = await openPage(page, 1);
  await page.locator('button', { hasText: /Add$/ }).click();
  await expect(rows).toHaveCount(2);
  const added = rows.nth(1);
  // A new task: enabled, every 60 seconds, a Command Preset task.
  await expect(added.locator('.ptTmplEnabled')).toBeChecked();
  await expect(added.locator('.ptTmplIntervalSec')).toHaveValue('60');
  await expect(added.locator('.ptTmplType')).toHaveValue('preset');
  await added.locator('.ptTmplName').fill('fpp-tests added');
  await added.locator('.ptTmplIntervalSec').fill('45');
  await added.locator('.ptTmplPreset').selectOption(PRESET);
  await save(page);
  await expect.poll(async () => (await saved(request)).map((t: any) => [t.name, t.intervalMS, t.enabled]))
    .toEqual([['fpp-tests first', 60000, false], ['fpp-tests added', 45000, true]]);

  // A row is selected by a mousedown on it (HandleTableRowMouseClick).
  await rows.nth(0).locator('td').first().dispatchEvent('mousedown');
  const del = page.locator('button.deleteTaskButton');
  await expect(del).toBeEnabled();
  await del.click();
  await expect(rows).toHaveCount(1);
  await save(page);
  await expect.poll(async () => (await saved(request)).map((t: any) => t.name)).toEqual(['fpp-tests added']);
});

test('an interval under 30 seconds is refused, not saved as 60', async ({ page, request }) => {
  // Regression: 2edd0c0d7.  The field turned red under 30 s, but Save quietly stored any
  // interval under 30 s (or none) as 60 s.
  const original = [presetTask('fpp-tests short')];
  await put(request, original);
  const rows = await openPage(page, 1);
  const said: string[] = [];
  page.on('dialog', (d) => { said.push(d.message()); d.accept(); });
  for (const value of ['10', '']) {
    said.length = 0;
    await rows.nth(0).locator('.ptTmplIntervalSec').fill(value);
    await expect(rows.nth(0).locator('.ptTmplIntervalSec')).toHaveClass(/intervalInvalid/);
    await save(page);
    await expect.poll(() => said.join('\n'), { message: `interval "${value}"` })
      .toContain('Task "fpp-tests short" needs an interval of at least 30 seconds.');
    expect(await saved(request)).toEqual(original);
  }
  // 30 is the shortest allowed, and is saved as it is.
  await rows.nth(0).locator('.ptTmplIntervalSec').fill('30');
  await save(page);
  await expect.poll(async () => (await saved(request))[0].intervalMS).toBe(30000);
});

test('a reload fppd refuses is reported, not shown as saved and reloaded', async ({ page, request }) => {
  // Regression: 2edd0c0d7.  SaveTasks() showed "saved and reloaded" from the reload
  // call's complete handler, so it said so even when the reload failed
  // (fppd not running) and fppd went on running the old tasks.
  await put(request, [presetTask('fpp-tests reload')]);
  const rows = await openPage(page, 1);
  await page.route('**/api/fppd/recurringtasks', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'fppd is not running' }) : route.continue());
  await rows.nth(0).locator('.ptTmplName').fill('fpp-tests reload 2');
  await save(page);
  await expect.poll(async () => (await saved(request)).map((t: any) => t.name)).toEqual(['fpp-tests reload 2']);
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('The tasks were saved, but fppd did not reload them');
  await expect(dialog).toContainText('500');
  await expect(page.getByText('saved and reloaded')).toHaveCount(0);
});

test('a task file that cannot be read is not shown as empty and then overwritten', async ({ page, request }) => {
  // Regression: 2edd0c0d7.  LoadTasks() treated any failed load as "no tasks saved yet":
  // a file with a syntax error (hand-edited, or cut off) showed an empty
  // table, and the next Save wrote [] over every task in it.
  test.skip(!container, 'writes the file inside the run-web.sh container');
  const broken = '[{"name": "fpp-tests broken", "type": "preset", "preset": "x",}\n';
  inPlayer('sh', '-c', `printf '%s' '${broken}' > ${ON_DISK}`);
  await page.goto('/recurringtasks.php');
  await expect(page.locator('#tasksLoadError')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#tblTasksBody > tr')).toHaveCount(0);
  const said: string[] = [];
  page.on('dialog', (d) => { said.push(d.message()); d.accept(); });
  await save(page);
  await expect.poll(() => said.join('\n')).toContain('could not be read');
  await page.waitForTimeout(500);
  expect(inPlayer('cat', ON_DISK)).toBe(broken);

  // No file at all is still a player with no tasks yet: no warning, and the
  // first tasks can be saved.
  inPlayer('rm', '-f', ON_DISK);
  await page.goto('/recurringtasks.php');
  await expect(page.locator('#tblTasksBody > tr')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('#tasksLoadError')).toBeHidden();
  await page.locator('button', { hasText: /Add$/ }).click();
  const row = page.locator('#tblTasksBody > tr').nth(0);
  await row.locator('.ptTmplName').fill('fpp-tests first');
  await row.locator('.ptTmplPreset').selectOption(PRESET);
  await save(page);
  await expect.poll(async () => (await saved(request)).map((t: any) => t.name)).toEqual(['fpp-tests first']);
});
