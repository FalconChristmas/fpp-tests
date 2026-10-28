import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { container, inPlayer } from './container';

// Save on the Channel Inputs DMX tab before the page has the saved inputs --
// the DMX counterpart of pixel-strings-save-before-load.spec.ts (issue #3124).
// Every serial port's row is drawn with defaults (off, start 1, 512 channels)
// and LoadDMX() fills them in afterwards, with no .fail handler.  A Save in
// that gap, or after a failed load, wrote the defaults over every port's saved
// input.  Fixed in fpp 324fe763a
// ("fix(outputs): check PWM, Other and DMX are fully loaded enabling save").
//
// The DMX tab has a row only for a serial port the player has.  The
// run-web.sh container has none, so it gets a stand-in /dev/ttyUSB9 (the page
// only lists names in /dev) for the length of the file; on a device the
// first real port is used (verified on a Pi 5, ttyAMA0, PLAYWRIGHT_BASE_URL
// at the player).  The config GET is held and answered by a route, and every
// POST is answered here, so the player's DMX config is not changed.

const CONFIG = /\/api\/channel\/output\/dmxInputs(\?|$)/;
const FAKE_PORT = '/dev/ttyUSB9';
let madePort = false;

test.beforeAll(() => {
  if (!container) return;
  madePort = inPlayer('sh', '-c', '[ -e "$1" ] && echo there || { touch "$1"; echo made; }', 'sh', FAKE_PORT).trim() === 'made';
});

test.afterAll(() => {
  if (madePort) inPlayer('rm', '-f', FAKE_PORT);
});

// Holds the page's GET of the inputs until release(), then answers it with
// `saved()` (or answers it at once with `status`); answers every POST here,
// recording the body.
async function routeConfig(page: Page, saved: () => object, status?: number) {
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(saved()) });
  });
  return { holding, release, posts };
}

const saveButton = (page: Page) => page.locator('#tab-dmx input[type=button][value="Save"]');

// Opens the DMX tab and returns the first serial port's name, skipping the
// test when the player has none.
async function open(page: Page): Promise<string> {
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channelinputs.php');
  const ports = page.locator('#tblDMXs tbody tr');
  test.skip((await ports.count()) === 0, 'no serial port, so no DMX inputs; verified on a Pi');
  await page.locator('#tab-dmx-tab').click();
  return (await ports.first().getAttribute('id'))!;
}

test('Save does nothing until the page has the inputs, then saves them', async ({ page }) => {
  let port = '';
  const saved = () => ({ channelInputs: [{ device: port, enabled: true, startAddress: 100, channelCount: 10, type: 'dmx' }] });
  const { holding, release, posts } = await routeConfig(page, saved);
  port = await open(page);
  await holding;
  await expect(saveButton(page), 'Save is offered before the inputs have loaded').toBeDisabled();
  await saveButton(page).click({ force: true });
  await page.waitForTimeout(1000);
  expect(posts, 'what Save wrote before the inputs had loaded').toEqual([]);

  release();
  await expect(saveButton(page)).toBeEnabled({ timeout: 15_000 });
  await saveButton(page).click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  const row = posts[0].channelInputs.find((i: any) => i.device === port);
  expect(row, 'the saved input is kept').toMatchObject({ enabled: true, startAddress: 100, channelCount: 10 });
});

test('Save stays off when the inputs cannot be loaded', async ({ page }) => {
  const { posts } = await routeConfig(page, () => ({}), 500);
  await open(page);
  await expect(page.locator('#jGrowl'), 'the user is told why Save is off')
    .toContainText('Unable to load the DMX input configuration', { timeout: 15_000 });
  await expect(saveButton(page), 'Save is offered after the inputs failed to load').toBeDisabled();
  await saveButton(page).click({ force: true });
  await page.waitForTimeout(1000);
  expect(posts, 'what Save wrote after the inputs failed to load').toEqual([]);
});

test('with no inputs saved yet, Save is available', async ({ page }) => {
  const { posts } = await routeConfig(page, () => ({}), 404);
  await open(page);
  await expect(saveButton(page), 'Save with no inputs saved yet').toBeEnabled({ timeout: 15_000 });
  await saveButton(page).click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  await expect(page.locator('#jGrowl')).not.toContainText('Unable to load');
});
