import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

// The condition editor of an If command's Check (fpp.js: RenderConditionTree
// and RenderConditionFields), opened from the Run FPP Command dialog: a leaf's
// Edit Condition sub-editor (its Source, Name, Is and Value fields, the quick
// picks, the unwrapped-variable warning, the insert-variable helper and the
// "how this condition evaluates" popup, which asks fppd), and the tree around
// it (groups, Match ALL/ANY, moving and removing).  What the editor builds is
// read from the Check's hidden field and, saved, run by fppd.

const INSTANT = 'api/configfile/instantCommand.json';
const GPIO = 'api/configfile/gpio.json';
const VAR = 'fppTestsCond';

async function keep(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  return r.ok() ? await r.text() : null;
}
async function put(request: APIRequestContext, path: string, body: unknown) {
  const r = await request.post(path, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}
const setVar = (value: string) => JSON.stringify([{ command: 'Set Variable', args: [VAR, 'Value', value, '1', '0', '100', ''] }]);
const ifWith = (check: unknown) =>
  ({ command: 'If', args: [check === '' ? '' : JSON.stringify(check), setVar('then'), 'Sequential', setVar('otherwise'), 'Sequential'] });
const variable = async (request: APIRequestContext, name: string) =>
  ((await (await request.get('/api/variables')).json()) ?? {})[name]?.value;
async function setVariable(request: APIRequestContext, name: string, value: string) {
  expect((await request.post('/api/command', { data: { command: 'Set Variable', args: [name, 'Value', value, '1', '0', '100', ''] } })).ok()).toBe(true);
}

let saved: Record<string, string | null> = {};
let errors: string[] = [];
test.beforeEach(async ({ request, page }) => {
  saved = { [INSTANT]: await keep(request, INSTANT), [GPIO]: await keep(request, GPIO) };
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(async ({ request }) => {
  for (const [path, body] of Object.entries(saved)) await put(request, path, body ?? (path === GPIO ? '[]' : '{}'));
  expect(errors, 'the page threw').toEqual([]);
});

// The Run FPP Command dialog, opened on `check` as the If's Check.
async function openIf(page: Page, request: APIRequestContext, check: unknown) {
  await put(request, INSTANT, ifWith(check));
  await page.goto('/index.php');
  const presets = page.waitForResponse((r) => r.url().includes('commandPresets.json'));
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  await presets;
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toHaveValue('If');
  await expect(dialog.locator('.conditionListRoot')).toHaveCount(1);
  return dialog;
}
// What the editor would send as the Check.
async function check(dialog: Locator) {
  const raw = await dialog.locator('.conditionListRoot').inputValue();
  return raw ? JSON.parse(raw) : '';
}
// Once a dialog has faded in: closed during the fade, an fppDialog stays open
// (dialog-close-during-fade.spec.ts).
const settled = (modal: Locator) => modal.evaluate((el) => new Promise<void>((resolve) => {
  const m = (window as any).bootstrap.Modal.getInstance(el);
  if (!m || !m._isTransitioning) resolve();
  else el.addEventListener('shown.bs.modal', () => resolve(), { once: true });
}));
async function editLeaf(page: Page, row: Locator) {
  await row.locator('button[title=Edit]').click();
  const editor = page.locator('.modal:has(.modal-title:text-is("Edit Condition"))').last();
  await expect(editor).toBeVisible();
  await settled(editor);
  return editor;
}
// The column under a field's small label ("Source", "Is", "Value", ...).
const field = (editor: Locator, label: string) =>
  editor.locator('span.text-muted.text-center', { hasText: new RegExp(`^${label}`) }).locator('xpath=..');

test('a condition is edited in its own dialog: Source, Name, Is and Value, previewed as it is typed', async ({ page, request }) => {
  const dialog = await openIf(page, request, { op: 'AND', conditions: [{ source: 'Expression', name: '1', comparator: 'equal to', value: '2' }] });
  const row = dialog.locator('.condListRow');
  await expect(row).toHaveText('Expression 1 equal to "2"');
  const editor = await editLeaf(page, row);
  // An Expression's Name is a formula box, with Value beside it.
  const name = field(editor, 'Name').locator('textarea');
  await expect(name).toHaveValue('1');
  await name.fill(`${VAR} + 1`);
  await field(editor, 'Is').locator('select').selectOption('greater than');
  await field(editor, 'Value').locator('textarea').fill('3');
  // The preview above the fields and the row behind the dialog follow.
  await expect(editor.locator('[id$=_body] > div').first()).toContainText(`${VAR} + 1`);
  await expect(row).toHaveText(`Expression ${VAR} + 1 greater than "3"`);
  await expect(editor.locator('.text-muted.small.mt-2')).toContainText("Type a Variable's exact name");
  await editor.locator('input[value=Close]').click();
  await expect(editor).toBeHidden();
  expect(await check(dialog)).toEqual({ op: 'AND', conditions: [{ source: 'Expression', name: `${VAR} + 1`, comparator: 'greater than', value: '3' }] });
  await expect(dialog.locator('[id$=_formula]')).toContainText(`${VAR} + 1`);

  // Saved and run, fppd evaluates the edited condition: 3 + 1 > 3.
  await setVariable(request, VAR, '3');
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect.poll(() => variable(request, VAR), { timeout: 10_000 }).toBe('then');
});

test("each Source shows the Name it takes: none, Sunrise or Sunset, or a GPIO input's pin", async ({ page, request }) => {
  await put(request, GPIO, [
    { pin: 'TF-3', enabled: true, mode: 'gpio', desc: '', debounceTime: 100, debounceEdge: 'both', rising: [], falling: [] },
    { pin: 'TF-4', enabled: false, mode: 'gpio', desc: '', debounceTime: 100, debounceEdge: 'both', rising: [], falling: [] },
  ]);
  const dialog = await openIf(page, request, { op: 'AND', conditions: [{ source: 'Expression', name: 'x', comparator: 'less than', value: 'y' }] });
  const row = dialog.locator('.condListRow');
  const editor = await editLeaf(page, row);
  const source = field(editor, 'Source').locator('select');

  // A new Source starts the condition over.
  await source.selectOption('Day');
  await expect(row).toHaveText('Day equal to');
  await expect(field(editor, 'Name')).toHaveCount(0);
  await expect(editor.locator('textarea')).toHaveCount(1);
  // Day's quick pick fills Value in, and goes back to its prompt.
  const pick = field(editor, 'Value').locator('select');
  await pick.selectOption('Saturday');
  await expect(field(editor, 'Value').locator('textarea')).toHaveValue('Saturday');
  await expect(pick).toHaveValue('');
  await expect(row).toHaveText('Day equal to "Saturday"');

  await source.selectOption('Sun');
  const sun = field(editor, 'Sunrise or Sunset').locator('select');
  await expect(sun).toHaveValue('Sunrise');
  await sun.selectOption('Sunset');
  await expect(row).toHaveText('Sun Sunset equal to');

  // GPIO Pin suggests the pins enabled as GPIO inputs.
  await source.selectOption('GPIO Pin');
  const pin = field(editor, 'GPIO Pin Name').locator('input');
  await expect(pin).toHaveAttribute('placeholder', 'GPIO Pin Name');
  const listId = await pin.getAttribute('list');
  await expect.poll(() => page.locator(`datalist[id="${listId}"] option`).evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).toEqual(['TF-3']);
  await pin.fill('TF-3');
  await field(editor, 'Value').locator('select').selectOption('1');
  await expect(row).toHaveText('GPIO Pin TF-3 equal to "1"');
  await expect(editor.locator('.text-muted.small.mt-2')).toContainText('GPIO pin');
  await editor.locator('input[value=Close]').click();
  expect(await check(dialog)).toEqual({ op: 'AND', conditions: [{ source: 'GPIO Pin', name: 'TF-3', comparator: 'equal to', value: '1' }] });
});

test('a variable name inside literal text is warned about, and the helper inserts one where the cursor was', async ({ page, request }) => {
  await setVariable(request, VAR, '4');
  const dialog = await openIf(page, request, { op: 'AND', conditions: [{ source: 'Expression', name: 'fpp_status_name', comparator: 'equal to', value: 'idle' }] });
  const editor = await editLeaf(page, dialog.locator('.condListRow'));
  const warning = editor.locator('.text-warning');
  const value = field(editor, 'Value').locator('textarea');
  // Bare text with an fpp_ variable in it is compared as that text.
  await value.fill('Status: fpp_status_name');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('Contains "fpp_status_name"');
  await expect(warning.locator('code').last()).toHaveText('%%fpp_status_name%%');
  // Wrapped, or used in a formula, it is substituted: no warning.
  await value.fill('Status: %%fpp_status_name%%');
  await expect(warning).toBeHidden();
  await value.fill('fpp_current_playlist_count + 1');
  await expect(warning).toBeHidden();

  // The helper offers every variable, and sends the one typed in it up to
  // the field whose arrow is clicked, where that field's cursor was: bare, not
  // in %%...%% (which would turn a formula into text).
  const name = field(editor, 'Name').locator('textarea');
  await name.fill('1 + ');
  await value.fill('x');
  const helper = editor.locator('input[placeholder="-- Select Variable to Insert --"]');
  const varList = await helper.getAttribute('list');
  await expect.poll(() => page.locator(`datalist[id="${varList}"] option[value="${VAR}"]`).count()).toBe(1);
  await expect(page.locator(`datalist[id="${varList}"] option[value="fpp_status_name"]`)).toHaveCount(1);
  await helper.click();
  await page.keyboard.type(VAR);
  await editor.locator('button[title="Insert into the Value field above"]').click();
  await expect(value).toHaveValue(`x${VAR}`);
  await expect(helper).toHaveValue('');
  await expect(name).toHaveValue('1 + ');
  await helper.click();
  await page.keyboard.type(VAR);
  await editor.locator('button[title="Insert into the Expression field above"]').click();
  await expect(name).toHaveValue(`1 + ${VAR}`);
  await editor.locator('input[value=Close]').click();
  expect((await check(dialog)).conditions[0]).toEqual({ source: 'Expression', name: `1 + ${VAR}`, comparator: 'equal to', value: `x${VAR}` });
});

test('the eye shows how the condition evaluates now, with each variable it uses', async ({ page, request }) => {
  await setVariable(request, VAR, '7');
  const dialog = await openIf(page, request, { op: 'AND', conditions: [{ source: 'Expression', name: VAR, comparator: 'greater than', value: '5' }] });
  const editor = await editLeaf(page, dialog.locator('.condListRow'));
  const asked = page.waitForRequest((r) => r.url().includes('api/fppd/condition/preview') && r.url().includes('comparator='));
  await editor.locator('button[title="Show how this condition currently evaluates"]').click();
  const q = new URL((await asked).url()).searchParams;
  expect(Object.fromEntries(q)).toMatchObject({ source: 'Expression', name: VAR, comparator: 'greater than', value: '5' });
  const popup = page.locator('.modal:has(.modal-title:text-is("How this condition evaluates"))');
  const body = popup.locator('.condValuePreviewBody');
  await expect(body).toContainText('Values substituted');
  await expect(body).toContainText('Expression("7") greater than Expression(5)');
  await expect(body.locator('code')).toHaveText(['"7"', '"5"']);
  await expect(body.locator('.fw-semibold')).toHaveText('true');
  await settled(popup);
  await popup.locator('.modal-footer button', { hasText: 'Close' }).click();
  await expect(popup).toHaveCount(0);

  // A GPIO pin fppd has no reading for: nothing was compared.
  await field(editor, 'Source').locator('select').selectOption('GPIO Pin');
  await field(editor, 'GPIO Pin Name').locator('input').fill('NoSuchPin');
  await field(editor, 'Value').locator('textarea').fill('1');
  await editor.locator('button[title="Show how this condition currently evaluates"]').click();
  await expect(body).toContainText("GPIO Pin NoSuchPin has no current value");
  await expect(body.locator('.fw-semibold')).toContainText('(no current value, so nothing was actually compared)');
  await settled(popup);
  await popup.locator('.modal-footer button', { hasText: 'Close' }).click();
  await expect(popup).toHaveCount(0);

  // fppd not answering says so.
  await page.route('**/api/fppd/condition/preview*', (r) => r.fulfill({ status: 500, body: 'no' }));
  await editor.locator('button[title="Show how this condition currently evaluates"]').click();
  await expect(body).toHaveText('Failed to fetch condition evaluation.');
});

test('groups nest, are named, match ALL or ANY, and move and go as a whole', async ({ page, request }) => {
  const dialog = await openIf(page, request, '');
  const root = dialog.locator('[id$=_container]').first();
  // A new If starts with one blank condition, and no Match toggle for one.
  await expect(root.locator('.condListRow')).toHaveCount(1);
  await expect(root.locator('text=Match:')).toHaveCount(0);
  await root.locator('input[value="+ Add Group"]').last().click();
  const group = root.locator('.condGroupCard');
  await expect(group).toHaveCount(1);
  await expect(root.locator('> div:has-text("Match:")')).toHaveCount(1);
  // A new group is empty.
  await expect(group.locator('.condListRow')).toHaveCount(0);
  await group.locator('.condGroupLabel').fill('Weekend');
  await group.locator('input[value="+ Add Condition"]').click();
  await group.locator('input[value="+ Add Condition"]').click();
  await expect(group.locator('.condListRow')).toHaveCount(2);
  // The group's own Match toggle, separate from the root's.
  await group.locator('label', { hasText: 'Match ANY (OR)' }).click();
  expect(await check(dialog)).toEqual({ op: 'AND', conditions: [
    { source: 'Expression', name: '', comparator: 'equal to', value: '' },
    { op: 'OR', label: 'Weekend', conditions: [
      { source: 'Expression', name: '', comparator: 'equal to', value: '' },
      { source: 'Expression', name: '', comparator: 'equal to', value: '' }] }] });
  await root.locator('> div.mb-2:not(.condGroupCard) label', { hasText: 'Match ANY (OR)' }).click();
  expect((await check(dialog)).op).toBe('OR');

  // Moved up, the group comes first; collapsed, its rows are hidden.
  await group.locator('> div > button[title="Move up"]').click();
  expect((await check(dialog)).conditions[0].label).toBe('Weekend');
  await expect(root.locator('> .condGroupCard ~ .condListRow')).toHaveCount(1);
  await root.locator('.condGroupCard button[title="Collapse/expand"]').click();
  await expect(root.locator('.condGroupCard .condListRow').first()).toBeHidden();
  // Removed, it goes with everything in it.
  await root.locator('.condGroupCard button[title="Remove group"]').click();
  expect(await check(dialog)).toEqual({ op: 'OR', conditions: [{ source: 'Expression', name: '', comparator: 'equal to', value: '' }] });
  // And the last condition removed, there is no Check at all.
  await root.locator('.condListRow button[title=Remove]').click();
  expect(await check(dialog)).toBe('');
  await expect(dialog.locator('[id$=_formula]')).toHaveText('No conditions configured yet.');
});

// Three levels of groups inside the Check is the most the editor offers
// ("+ Add Group" goes inside the third).  Moving or removing a condition re-renders its group as if
// it were at the top (RenderConditionLeafRow calls RenderConditionTree with
// no depth), so the button comes back and a fourth level can be made.
// In FUTURE.md.
async function threeDeep(page: Page, request: APIRequestContext) {
  const leaf = { source: 'Expression', name: '1', comparator: 'equal to', value: '1' };
  const dialog = await openIf(page, request, { op: 'AND', conditions: [{ op: 'AND', conditions: [{ op: 'AND', conditions: [
    { op: 'AND', conditions: [leaf, leaf] }] }] }] });
  const third = dialog.locator('.condGroupCard .condGroupCard .condGroupCard');
  await expect(third).toHaveCount(1);
  return third.locator('> .condGroupBody');
}

test('a group three levels deep offers no further group', async ({ page, request }) => {
  const body = await threeDeep(page, request);
  await expect(body.locator('> input[value="+ Add Condition"]')).toHaveCount(1);
  await expect(body.locator('> input[value="+ Add Group"]')).toHaveCount(0);
});

test('a group three levels deep still offers no further group once a condition in it is moved or removed', async ({ page, request }) => {
  test.fail(true, 'RenderConditionLeafRow re-renders without the depth (FUTURE.md)');
  const body = await threeDeep(page, request);
  await body.locator('.condListRow').first().locator('button[title="Move down"]').click();
  await expect(body.locator('> input[value="+ Add Group"]')).toHaveCount(0, { timeout: 2000 });
});
