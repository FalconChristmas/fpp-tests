import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';

// The Clone button of the E1.31 / ArtNet / DDP tab (CloneUniverses in
// fpp.js): the selected row is copied over the rows after it, as many as
// asked for, each one's universe and start channel carrying on from the one
// before.

test.skip(!container, 'changes the player\'s output config');

const universe = (id: number, extra: Record<string, unknown> = {}) => ({
  active: 1, description: `fpp-tests ${id}`, id, startChannel: 5000 + id, universeCount: 1, channelCount: 510,
  type: 0, address: '', priority: 0, monitor: 0, deDuplicate: 0, ...extra,
});
const SOURCE = universe(10, {
  description: 'fpp-tests source', startChannel: 1, universeCount: 2, channelCount: 100, type: 1, address: '10.0.0.5', priority: 7, deDuplicate: 1,
});

async function put(request: APIRequestContext, universes: object[]) {
  const body = { channelOutputs: [{ type: 'universes', enabled: 1, interface: 'eth0', threaded: 1, startChannel: 1, channelCount: -1, universes }] };
  const r = await request.post('/api/channel/output/universeOutputs', { data: body });
  expect(r.ok(), await r.text()).toBe(true);
}

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/universeOutputs');
  before = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/universeOutputs', {
    data: Buffer.from(before && !before.includes('File not found') ? before : '{"channelOutputs": []}'),
  });
});

// The page with the universes given, and what Clone's "how many" prompt is
// answered with.
async function openUniverses(page: Page, request: APIRequestContext, universes: object[], answer: string | null) {
  await put(request, universes);
  page.on('dialog', (d) => (d.type() === 'prompt' && answer !== null ? d.accept(answer) : d.type() === 'prompt' ? d.dismiss() : d.accept()));
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  await expect(page.locator('#tblUniversesBody > tr')).toHaveCount(universes.length, { timeout: 15_000 });
}

const row = (page: Page, i: number) => page.locator('#tblUniversesBody > tr').nth(i);

// What a row shows: description, type, address (and whether it can be
// typed in), universe, universe count, size, start and end channel.
async function shown(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll('#tblUniversesBody > tr')].map((tr, i) => {
    const v = (n: string) => (document.getElementById(`${n}[${i}]`) as HTMLInputElement).value;
    const ip = document.getElementById(`txtIP[${i}]`) as HTMLInputElement;
    return [v('txtDesc'), v('universeType'), ip.disabled ? '(disabled)' : ip.value, v('txtUniverse'), v('numUniverseCount'), v('txtSize'), v('txtStartAddress'),
      (tr.querySelector('.numEndChannel, [id^="numEndChannel"], .endChannel') as HTMLElement | null)?.textContent?.trim() ?? ''].join(' | ');
  }));
}

const UNTOUCHED = [
  'fpp-tests source | 1 | 10.0.0.5 | 10 | 2 | 100 | 1 | 200',
  'fpp-tests 50 | 0 | (disabled) | 50 | 1 | 510 | 5050 | 5559',
  'fpp-tests 51 | 0 | (disabled) | 51 | 1 | 510 | 5051 | 5560',
  'fpp-tests 52 | 0 | (disabled) | 52 | 1 | 510 | 5052 | 5561',
];

async function clone(page: Page, from: number) {
  await row(page, from).dispatchEvent('mousedown');
  await expect(row(page, from)).toHaveClass(/selectedEntry/);
  await page.locator('#btnCloneUniverses').click();
}

test('Clone copies the selected universe over the rows after it, numbering each on from the last', async ({ page, request }) => {
  await openUniverses(page, request, [SOURCE, universe(50), universe(51), universe(52)], '2');
  expect(await shown(page)).toEqual(UNTOUCHED);
  await clone(page, 0);
  // Two universes of 100 channels each: the next row starts two universes
  // and 200 channels on, and so does the one after it.  The fourth row was
  // not asked for.
  expect(await shown(page)).toEqual([
    UNTOUCHED[0],
    'fpp-tests source | 1 | 10.0.0.5 | 12 | 2 | 100 | 201 | 400',
    'fpp-tests source | 1 | 10.0.0.5 | 14 | 2 | 100 | 401 | 600',
    UNTOUCHED[3],
  ]);

  // And that is what Save stores, the columns not shown above included.
  await page.locator('#btnSaveUniverses').click();
  await expect.poll(async () => {
    const out = (await (await request.get('/api/channel/output/universeOutputs')).json()).channelOutputs[0];
    return out.universes.map((u: any) => [u.description, u.type, u.address, u.id, u.universeCount, u.channelCount, u.startChannel, u.priority, u.deDuplicate]);
  }).toEqual([
    ['fpp-tests source', 1, '10.0.0.5', 10, 2, 100, 1, 7, 1],
    ['fpp-tests source', 1, '10.0.0.5', 12, 2, 100, 201, 7, 1],
    ['fpp-tests source', 1, '10.0.0.5', 14, 2, 100, 401, 7, 1],
    ['fpp-tests 52', 0, '', 52, 1, 510, 5052, 0, 0],
  ]);
});

test('Clone from a row in the middle leaves the rows above it alone', async ({ page, request }) => {
  await openUniverses(page, request, [universe(50), SOURCE, universe(51), universe(52)], '1');
  await clone(page, 1);
  expect(await shown(page)).toEqual([UNTOUCHED[1], UNTOUCHED[0], 'fpp-tests source | 1 | 10.0.0.5 | 12 | 2 | 100 | 201 | 400', UNTOUCHED[3]]);
});

test('Clone changes nothing when the answer is not a number, is nothing, or the prompt is cancelled', async ({ page, request }) => {
  for (const [answer, error] of [['two', true], ['0', false], [null, false]] as [string | null, boolean][]) {
    await openUniverses(page, request, [SOURCE, universe(50), universe(51), universe(52)], answer);
    await clone(page, 0);
    if (error) {
      await expect(page.locator('.modal.show')).toContainText('Error, invalid number');
    } else {
      await expect(page.locator('.modal.show')).toHaveCount(0);
    }
    expect(await shown(page), String(answer)).toEqual(UNTOUCHED);
    page.removeAllListeners('dialog');
  }
});

async function cloneCollectingErrors(page: Page, request: APIRequestContext, answer: string, from: number | null) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openUniverses(page, request, [SOURCE, universe(50), universe(51), universe(52)], answer);
  if (from === null) {
    await page.locator('#btnCloneUniverses').click();
  } else {
    await clone(page, from);
  }
  return errors;
}

test('Clone asked for two more rows than follow the selected one changes nothing', async ({ page, request }) => {
  // Three rows follow the first.  The control for the next test: five is refused.
  expect(await cloneCollectingErrors(page, request, '5', 0)).toEqual([]);
  expect(await shown(page)).toEqual(UNTOUCHED);
});

test('Clone asked for one more row than follow the selected one changes nothing', async ({ page, request }) => {
  // FUTURE.md: the check is one short (selected + count - 1 >= rows), so four
  // is let through: the three rows there are overwritten, then the script
  // dies on the row that isn't.
  test.fail();
  const errors = await cloneCollectingErrors(page, request, '4', 0);
  expect(await shown(page)).toEqual(UNTOUCHED);
  expect(errors).toEqual([]);
});

test('Clone with no row selected does nothing, without a script error', async ({ page, request }) => {
  // FUTURE.md: nothing checks for a selected row (Delete does), so the
  // script dies reading row -1, after asking how many.
  test.fail();
  const errors = await cloneCollectingErrors(page, request, '1', null);
  expect(await shown(page)).toEqual(UNTOUCHED);
  expect(errors).toEqual([]);
});
