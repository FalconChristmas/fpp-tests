import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';

// The E1.31 / ArtNet / DDP tab of Channel Outputs (co-universes.php), with
// the universes given here.  Saving writes co-universes.json, which fppd
// reloads; fppd's own state (its test mode) is the other end checked.

test.skip(!container, 'changes the player\'s output config');

const universe = (i: number, extra: Record<string, unknown> = {}) => ({
  active: 1, description: `fpp-tests ${i}`, id: i, startChannel: 1 + (i - 1) * 510, universeCount: 1, channelCount: 510,
  type: 1, address: '10.0.0.5', priority: 0, monitor: 0, deDuplicate: 0, ...extra,
});

function config(universes: object[], pacingRate = 30) {
  return { channelOutputs: [{ type: 'universes', enabled: 1, interface: 'eth0', threaded: 1, pacingRate,
                              startChannel: 1, channelCount: -1, universes }] };
}

async function put(request: APIRequestContext, body: object) {
  const r = await request.post('/api/channel/output/universeOutputs', { data: body });
  expect(r.ok(), await r.text()).toBe(true);
}

async function stored(request: APIRequestContext) {
  return (await (await request.get('/api/channel/output/universeOutputs')).json()).channelOutputs[0];
}

let before: string | null = null;
let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/universeOutputs');
  before = r.ok() ? await r.text() : null;
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
});
test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  await request.post('/api/channel/output/universeOutputs', {
    data: Buffer.from(before && !before.includes('File not found') ? before : '{"channelOutputs": []}'),
  });
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function openUniverses(page: Page, rows: number) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  await expect(page.locator('#tblUniversesBody > tr')).toHaveCount(rows, { timeout: 15_000 });
}

const row = (page: Page, i: number) => page.locator('#tblUniversesBody > tr').nth(i);

test('the max fps note follows the busiest paced controller as the universes change', async ({ page, request }) => {
  // Feature: 8f805327e.  Pacing caps the rate data goes to each unicast
  // controller, so the note gives the frame rate the busiest one allows:
  // 40 E1.31 universes of 510 channels to one address are 40 x (510 + 168)
  // bytes a frame on the wire, which 30 Mbps sends about 138 times a second.
  await put(request, config([universe(1, { universeCount: 40 }), universe(41, { address: '10.0.0.6', universeCount: 10 })]));
  await openUniverses(page, 2);
  const note = page.locator('#pacingMaxFPS');
  await expect(note).toHaveText('Supports ≈138 fps max (limited by 10.0.0.5)');

  // Twice the universes to it: half the rate.
  await row(page, 0).locator('input.numUniverseCount').fill('80');
  await row(page, 0).locator('input.numUniverseCount').dispatchEvent('change');
  await expect(note).toHaveText('Supports ≈69 fps max (limited by 10.0.0.5)');

  // Moved to the other controller's address, which then carries 90.
  await row(page, 0).locator('input.txtIP').fill('10.0.0.6');
  await row(page, 0).locator('input.txtIP').dispatchEvent('change');
  await expect(note).toHaveText('Supports ≈61 fps max (limited by 10.0.0.6)');

  // Multicast is not paced: nothing to say.
  await row(page, 0).locator('select.universeType').selectOption('0');
  await row(page, 1).locator('select.universeType').selectOption('0');
  await expect(note).toHaveText('');
});

test('Universe Priority and Sync Universe are hidden at the Basic UI level, and kept on save', async ({ page, request }) => {
  // Feature: b973b84cf.  Both columns, header and cells, are hidden in Basic
  // mode and shown from Advanced; a Save in Basic keeps their values.
  await put(request, config([universe(1, { priority: 150, syncUniverse: 7 })]));
  const header = (page: Page, label: string) => page.locator(`#tblUniversesHead th[aria-label="${label}"]`);

  await request.put('/api/settings/uiLevel', { data: '1' });
  await openUniverses(page, 1);
  await expect(header(page, 'Universe Priority')).toBeVisible();
  await expect(header(page, 'E1.31 Synchronization Universe')).toBeVisible();
  await expect(row(page, 0).locator('input.txtPriority')).toHaveValue('150');
  await expect(row(page, 0).locator('input.txtSyncUniverse')).toHaveValue('7');

  await request.put('/api/settings/uiLevel', { data: '0' });
  await openUniverses(page, 1);
  await expect(header(page, 'Universe Priority')).toBeHidden();
  await expect(header(page, 'E1.31 Synchronization Universe')).toBeHidden();
  await expect(row(page, 0).locator('input.txtPriority')).toBeHidden();
  await expect(row(page, 0).locator('input.txtSyncUniverse')).toBeHidden();
  // The columns either side are still there.
  await expect(header(page, 'Universe size')).toBeVisible();
  await expect(header(page, 'Monitor controller')).toBeVisible();

  await row(page, 0).locator('input.txtDesc').fill('fpp-tests saved in basic');
  await page.locator('#frmUniverses input[value="Save"]').click();
  await expect.poll(async () => (await stored(request)).universes[0].description, { timeout: 15_000 }).toBe('fpp-tests saved in basic');
  expect((await stored(request)).universes[0]).toMatchObject({ priority: 150, syncUniverse: 7 });
});

test('the Monitor checkbox sits centred under its header', async ({ page, request }) => {
  // Regression: 364f00d5d.  The Monitor cell left-justified its checkbox in
  // a column only as wide as its header.
  await put(request, config([universe(1)]));
  await openUniverses(page, 1);
  const header = await page.locator('#tblUniversesHead th[aria-label="Monitor controller"]').boundingBox();
  const box = await row(page, 0).locator('input.txtMonitor').boundingBox();
  expect(header && box).toBeTruthy();
  const centre = (b: { x: number; width: number }) => b.x + b.width / 2;
  expect(Math.abs(centre(box!) - centre(header!)), `header ${JSON.stringify(header)}, checkbox ${JSON.stringify(box)}`).toBeLessThan(3);
});

test('saving the universes turns test mode off', async ({ page, request }) => {
  // Feature: 05cc45f5c.  A test pattern left running would keep covering
  // the outputs just changed; saving an output config ends it.
  await put(request, config([universe(1)]));
  await openUniverses(page, 1);
  const t = await request.post('/api/command', { data: { command: 'Test Start', args: ['1000', 'RGB Cycle', '1-510', 'R-G-B'] } });
  expect(t.ok()).toBe(true);
  await expect.poll(async () => (await (await request.get('/api/testmode')).json()).enabled).toBe(1);

  await row(page, 0).locator('input.txtDesc').fill('fpp-tests test mode');
  await page.locator('#frmUniverses input[value="Save"]').click();
  await expect.poll(async () => (await stored(request)).universes[0].description, { timeout: 15_000 }).toBe('fpp-tests test mode');
  await expect.poll(async () => (await (await request.get('/api/testmode')).json()).enabled, { timeout: 10_000 }).toBe(0);
});
