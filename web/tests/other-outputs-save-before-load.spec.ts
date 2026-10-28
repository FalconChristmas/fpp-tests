import { test, expect } from './fixtures';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { container } from './container';

// Save on the Other output tabs before the page has the saved outputs -- the
// Other counterpart of pixel-strings-save-before-load.spec.ts (issue #3124).
// GetChannelOutputs() fetches co-other.json after the page is up, with no
// .fail handler, and Add Output Group can build a tab, Save button included,
// before it returns.  A Save in that gap, or after a failed load, wrote only
// what that tab held over every saved output.  Add Output Group is now off
// until the outputs load, and Save on any tab built before then (by the
// menu or not) stays off too.  Fixed in fpp 324fe763a
// ("fix(outputs): check PWM, Other and DMX are fully loaded enabling save").
//
// The config GET is held (or failed) by a route, and every POST of it is
// answered here and never reaches the player.  The saved outputs are seeded
// first, so this runs only in the run-web.sh container.

test.skip(!container, 'seeds co-other.json, so only in the run-web.sh container');

const CONFIG = /\/api\/channel\/output\/co-other(\?|$)/;

const udp = {
  type: 'GenericUDP', enabled: 1, startChannel: 1, channelCount: 3, address: '127.0.0.1', port: 9999,
  tokenData: '{data}', description: 'fpp-tests output',
};

let before: string | null = null;

test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
  const s = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [udp] } });
  expect(s.ok(), await s.text()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
});

// Holds the page's GET of the config until release() (or answers it with
// `status`), and answers every POST of it here, recording the body.
async function routeConfig(page: Page, status?: number) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const posts: any[] = [];
  await page.route(CONFIG, async (route: Route) => {
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

const saveButton = (page: Page, cat: string) => page.locator(`#tab-other-${cat} input[type=button][value="Save"]`);
const addButton = (page: Page) => page.locator('#addOutputDropdown');

// Adds the Virtuals group from the Add Output Group menu: a tab with its own Save.
async function addVirtuals(page: Page) {
  await addButton(page).click();
  await page.locator('#addOutputCategoryMenu a.dropdown-item', { hasText: 'Virtuals' }).click();
  await expect(saveButton(page, 'VirtualDisplay')).toBeAttached();
}

// While the menu is off, a tab can still be built the way the menu builds one;
// its Save must be off as well.
async function buildVirtuals(page: Page) {
  await page.evaluate(() => (window as any).AddNewCategoryTab('VirtualDisplay'));
  await expect(saveButton(page, 'VirtualDisplay')).toBeAttached();
}

async function trySave(page: Page, cat: string) {
  // The button, forced in case it is disabled, and the function it calls.
  await saveButton(page, cat).click({ force: true });
  await page.evaluate(() => (window as any).SaveOtherChannelOutputs());
  await page.waitForTimeout(1000);
}

async function open(page: Page) {
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
}

test('Add and Save do nothing until the page has the outputs, then the outputs are kept', async ({ page }) => {
  const { holding, release, posts } = await routeConfig(page);
  await open(page);
  await holding;
  await expect(addButton(page), 'Add Output Group is offered before the outputs have loaded').toBeDisabled();
  await buildVirtuals(page);
  await expect(saveButton(page, 'VirtualDisplay'), 'Save is offered before the outputs have loaded').toBeDisabled();
  await trySave(page, 'VirtualDisplay');
  expect(posts, 'what Save wrote before the outputs had loaded').toEqual([]);

  release();
  await expect(page.locator('#tblOther-DMXSerial > tbody > tr')).toHaveCount(1, { timeout: 15_000 });
  await expect(addButton(page)).toBeEnabled();
  await page.locator('#tab-other-DMXSerial-tab').click();
  await expect(saveButton(page, 'DMXSerial')).toBeEnabled();
  await saveButton(page, 'DMXSerial').click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  expect(posts[0].channelOutputs.map((o: any) => [o.type, o.address]), 'the saved output is kept')
    .toEqual([[udp.type, udp.address]]);
});

test('Add and Save stay off when the outputs cannot be loaded', async ({ page }) => {
  const { posts } = await routeConfig(page, 500);
  await open(page);
  await expect(page.locator('#jGrowl'), 'the user is told why Save is off')
    .toContainText('Unable to load the Other output configuration', { timeout: 15_000 });
  await expect(addButton(page), 'Add Output Group is offered after the outputs failed to load').toBeDisabled();
  await buildVirtuals(page);
  await expect(saveButton(page, 'VirtualDisplay'), 'Save is offered after the outputs failed to load').toBeDisabled();
  await trySave(page, 'VirtualDisplay');
  expect(posts, 'what Save wrote after the outputs failed to load').toEqual([]);
});

test('with no outputs saved yet, Add and Save are available for the first group', async ({ page }) => {
  const { posts } = await routeConfig(page, 404);
  await open(page);
  await expect(addButton(page), 'Add Output Group with no outputs saved yet').toBeEnabled({ timeout: 15_000 });
  await addVirtuals(page);
  await expect(saveButton(page, 'VirtualDisplay'), 'Save with no outputs saved yet').toBeEnabled();
  await saveButton(page, 'VirtualDisplay').click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  await expect(page.locator('#jGrowl')).not.toContainText('Unable to load');
});
