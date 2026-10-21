import { test, expect } from './fixtures';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { container } from './container';

// Save on the E1.31 / ArtNet / DDP pages before they have their config -- the
// universes counterpart of pixel-strings-save-before-load.spec.ts (issue
// #3124).  getUniverses() fills the table after the page is up, and its .fail
// treated every failure as "no config saved yet": a Save before the load
// finished, or after it failed, wrote no universes and output disabled over
// the real config.  The Save button is a submit button, so Enter in any field
// of the form saved too; a disabled default button stops that, and the submit
// handlers refuse while Save is disabled for any other submit.  Fixed in fpp e2fc00594 ("fix(outputs): E1.31/DDP
// Save waits for the saved universes").
//
// The config GET is held (or failed) by a route, and every POST of it is
// answered here and never reaches the player.  Run by run-web.sh, the outputs
// get one enabled universe first; against any other player its own output
// config must have at least one universe.

const OUTPUTS = /\/api\/channel\/output\/universeOutputs(\?|$)/;
const INPUTS = /\/api\/channel\/output\/universeInputs(\?|$)/;

const SEEDED = {
  channelOutputs: [{
    type: 'universes', enabled: 1, interface: 'eth0', threaded: 3, pacingRate: 90, startChannel: 1, channelCount: -1,
    universes: [{
      active: 1, description: 'fpp-tests universe', id: 1, startChannel: 1, universeCount: 1, channelCount: 510,
      type: 0, address: '', priority: 0, monitor: 1, deDuplicate: 0,
    }],
  }],
};

let before: string | null = null;

test.beforeEach(async ({ request }) => {
  if (!container) return;
  const r = await request.get('/api/channel/output/universeOutputs');
  before = r.ok() ? await r.text() : null;
  const s = await request.post('/api/channel/output/universeOutputs', { data: SEEDED });
  expect(s.ok(), await s.text()).toBe(true);
});

test.afterEach(async ({ request }) => {
  if (!container) return;
  await request.post('/api/channel/output/universeOutputs', {
    data: Buffer.from(before ?? '{"channelOutputs": []}'),
  });
});

// Holds the page's GET of the config until release() (or answers it with
// `status`), and answers every POST of it here, recording the body.
async function routeConfig(page: Page, url: RegExp, status?: number) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const posts: any[] = [];
  await page.route(url, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      posts.push(JSON.parse(req.postData() || 'null'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"OK"}' });
      return;
    }
    if (status) {
      await route.fulfill({ status, contentType: 'application/json', body: '{"status":"fpp-tests"}' });
      return;
    }
    held();
    await released;
    await route.continue();
  });
  return { holding, release, posts };
}

const saveButton = (page: Page) => page.locator('#frmUniverses input[value="Save"]');

async function trySave(page: Page) {
  // A click on the button, forced in case it is disabled; Enter in a field of
  // the form (implicit submission, which a disabled default button stops); and
  // a submit of the form itself, which no button state stops -- only the
  // page's submit handler (UniverseSaveAllowed()).
  await saveButton(page).click({ force: true });
  await page.locator('#txtUniverseCount').press('Enter');
  await page.evaluate(() => (window as any).$('#frmUniverses').trigger('submit'));
  await page.waitForTimeout(1000);
}

async function universeCount(request: APIRequestContext) {
  const data = await (await request.get('/api/channel/output/universeOutputs')).json();
  return data.channelOutputs?.[0]?.universes?.length ?? 0;
}

test('Save does nothing until the page has the universes, then saves them', async ({ page, request }) => {
  const expected = await universeCount(request);
  expect(expected, 'the player needs at least one output universe for this test').toBeGreaterThan(0);
  const { holding, release, posts } = await routeConfig(page, OUTPUTS);
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  await holding;
  await page.locator('#tab-e131-tab').click();
  await expect(saveButton(page)).toBeVisible();

  await expect(saveButton(page), 'Save is offered before the config has loaded').toBeDisabled();
  await trySave(page);
  expect(posts, 'what Save wrote before the config had loaded').toEqual([]);

  release();
  await expect(page.locator('#tblUniversesBody tr')).toHaveCount(expected, { timeout: 15_000 });
  await expect(saveButton(page)).toBeEnabled();
  await saveButton(page).click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  expect(posts[0].channelOutputs[0].universes.length, 'the universes are kept').toBe(expected);
});

test('Save stays off when the universes cannot be loaded', async ({ page }) => {
  const { posts } = await routeConfig(page, OUTPUTS, 500);
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  await expect(page.locator('#jGrowl'), 'the user is told why Save is off')
    .toContainText('Unable to load the universe configuration', { timeout: 15_000 });
  await expect(saveButton(page), 'Save is offered after the config failed to load').toBeDisabled();
  await trySave(page);
  expect(posts, 'what Save wrote after the config failed to load').toEqual([]);
});

test('with no universes saved yet, Save is available for the first ones', async ({ page }) => {
  const { posts } = await routeConfig(page, OUTPUTS, 404);
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  await expect(saveButton(page), 'Save with no config saved yet').toBeEnabled({ timeout: 15_000 });
  await saveButton(page).click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  await expect(page.locator('#jGrowl')).not.toContainText('Unable to load');
});

test('Channel Inputs: Save does nothing until the page has the input universes', async ({ page }) => {
  const { holding, release, posts } = await routeConfig(page, INPUTS);
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channelinputs.php');
  await holding;
  await expect(saveButton(page)).toBeVisible();
  await expect(saveButton(page), 'Save is offered before the config has loaded').toBeDisabled();
  await trySave(page);
  expect(posts, 'what Save wrote before the config had loaded').toEqual([]);
  release();
  await expect(saveButton(page)).toBeEnabled({ timeout: 15_000 });
});
