import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The Variables page's row buttons: Clear empties a variable and keeps its
// row, Delete removes it, and the eye shows the whole value as it is now
// (www/variables.php ClearVariable, DeleteVariable, ViewVariable).  Both ask
// first.  The variables are read back from fppd through /api/variables.

const A = 'fpp-tests-rowact-a';
const B = 'fpp-tests-rowact-b';
// A name with what an inline onclick could not carry.
const ODD = `fpp-tests-rowact it's "q" <b>&`;
const NAMES = [A, B, ODD];

const set = async (request: APIRequestContext, name: string, value: string) => {
  const r = await request.post(`/api/variables/${encodeURIComponent(name)}?persist=false`, { data: value, headers: { 'Content-Type': 'text/plain' } });
  expect(r.ok(), `${name}: ${r.status()}`).toBe(true);
};
const all = async (request: APIRequestContext) => (await (await request.get('/api/variables')).json()) ?? {};
const mine = async (request: APIRequestContext) =>
  Object.fromEntries(Object.entries(await all(request)).filter(([k]) => k.startsWith('fpp-tests-rowact')).map(([k, v]: any) => [k, v.value]));

test.beforeEach(async ({ request }) => {
  await set(request, A, 'alpha');
  await set(request, B, 'bravo');
});
test.afterEach(async ({ request }) => {
  for (const n of NAMES) await request.delete(`/api/variables/${encodeURIComponent(n)}`);
});

const rowOf = (page: Page, name: string) =>
  page.locator('#variablesTableBody tr').filter({ has: page.locator('.variableDeleteBtn').and(page.locator(`[data-name=${JSON.stringify(name).replace(/\\"/g, '\\"')}]`)) });

async function open(page: Page, ...names: string[]) {
  await page.goto('/variables.php');
  for (const n of names) await expect(rowOf(page, n)).toHaveCount(1, { timeout: 15_000 });
}

test('Clear asks first, then empties the variable and keeps its row; the other one is untouched', async ({ page, request }) => {
  await open(page, A, B);
  const asked: string[] = [];
  let answer = false;
  page.on('dialog', (d) => { asked.push(d.message()); answer ? d.accept() : d.dismiss(); });

  await rowOf(page, A).locator('.variableClearBtn').click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain(`Clear variable "${A}"?`);
  expect(await mine(request), 'Cancel changed something').toEqual({ [A]: 'alpha', [B]: 'bravo' });

  answer = true;
  await rowOf(page, A).locator('.variableClearBtn').click();
  await expect.poll(() => mine(request)).toEqual({ [A]: '', [B]: 'bravo' });
  await expect(rowOf(page, A)).toHaveCount(1);
  await expect(rowOf(page, A)).not.toContainText('alpha');
  await expect(rowOf(page, B)).toContainText('bravo');
});

test('Delete asks first, then removes that variable and its row only', async ({ page, request }) => {
  await open(page, A, B);
  const asked: string[] = [];
  let answer = false;
  page.on('dialog', (d) => { asked.push(d.message()); answer ? d.accept() : d.dismiss(); });

  await rowOf(page, B).locator('.variableDeleteBtn').click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain(`Delete variable "${B}"?`);
  expect(await mine(request)).toEqual({ [A]: 'alpha', [B]: 'bravo' });

  answer = true;
  await rowOf(page, B).locator('.variableDeleteBtn').click();
  await expect.poll(() => mine(request)).toEqual({ [A]: 'alpha' });
  await expect(rowOf(page, B)).toHaveCount(0);
  await expect(rowOf(page, A)).toHaveCount(1);
});

test('a name with quotes and markup is cleared and deleted as that name, and is shown as text', async ({ page, request }) => {
  await set(request, ODD, 'odd value');
  await open(page, A, ODD);
  expect(await page.locator('#variablesTableBody b').count(), 'the name was written as HTML').toBe(0);
  const asked: string[] = [];
  page.on('dialog', (d) => { asked.push(d.message()); d.accept(); });

  await rowOf(page, ODD).locator('.variableClearBtn').click();
  await expect.poll(() => mine(request)).toEqual({ [A]: 'alpha', [B]: 'bravo', [ODD]: '' });
  expect(asked[0]).toContain(`Clear variable "${ODD}"?`);

  await rowOf(page, ODD).locator('.variableDeleteBtn').click();
  await expect.poll(() => mine(request)).toEqual({ [A]: 'alpha', [B]: 'bravo' });
  await expect(rowOf(page, ODD)).toHaveCount(0);
});

test('the eye shows the whole value as it is now, not as it was when the page loaded', async ({ page, request }) => {
  const long = 'fpp-tests long value '.repeat(120).trim();
  await set(request, A, long);
  await open(page, A);
  const eye = rowOf(page, A).locator('.variableEyeBtn');
  await expect(eye, 'a value too long for its cell has an eye').toBeVisible();

  const newer = `${long} and then changed <i>after</i> the page was read`;
  await set(request, A, newer);
  await eye.click();
  const popup = page.locator('[id^="viewVariablePopup_"]');
  await expect(popup.locator('pre')).toHaveText(newer);
  expect(await popup.locator('i').count(), 'the value was written as HTML').toBe(0);
  await page.locator('.ui-dialog-buttonpane button, .modal-footer button', { hasText: 'Close' }).click();
  await expect(popup).toBeHidden();
});

test('a list that cannot be read says so', async ({ page }) => {
  await page.route((u) => u.pathname.endsWith('/api/variables'), (route) => route.fulfill({ status: 500, body: 'no' }));
  await page.goto('/variables.php');
  await expect(page.locator('#variablesTableBody')).toHaveText('Error loading variables.', { timeout: 15_000 });
  await expect(page.locator('#variablesTableBody .variableDeleteBtn')).toHaveCount(0);
});
