import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { container } from './container';

// Save on the Pixel Strings page before the page has its config (issue #3124).
// Fixed in fpp 1470ffeeb ("fix(outputs): Pixel Strings Save waits for the
// saved config (#3124)").
// loadPixelStringOutputs() draws the page from built-in defaults -- no strings,
// "Enable" unchecked -- and only then asks for the real config, with no .fail
// handler.  A Save pressed in between wrote those defaults over the real
// config: the cape disabled and every string gone.  On a phone on Wi-Fi the
// gap is seconds, and if the request fails it never closes.
//
// The config GET is held by a route until the test lets it go, so the gap is
// certain rather than a matter of speed.  Every POST of the config is answered
// by the test and never reaches the player, so the player's config is the same
// after the test as before, whatever the page sends.
//
// The Pixel Strings tab exists only on a Pi, a BeagleBone, or Linux with the X11
// headers, and the run-web.sh container is none of these, so this skips there.
// It is verified against a Pi with a PiHat (fpp 10.x master, PLAYWRIGHT_BASE_URL
// at the player): it fails on the page before the fix and passes after.  The
// player's string config must have the cape enabled and at least one string.
// Nothing on the player is changed.

test.skip(!!container, 'no Pixel Strings tab in the run-web.sh container; verified on a Pi');

const CONFIG = /\/api\/channel\/output\/co-(pixel|bbb)Strings(\?|$)/;

// Holds the page's GET of the string config until release(), and answers every
// POST of it here, recording the body.
async function holdConfig(page: Page) {
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
    held();
    await released;
    await route.continue();
  });
  return { holding, release, posts };
}

const saveButton = (page: Page) => page.locator('#stringTab input[type=button][value="Save"]');

function stringCount(post: any): number {
  let n = 0;
  for (const o of post?.channelOutputs ?? []) {
    for (const p of o.outputs ?? []) n += (p.virtualStrings ?? []).filter((s: any) => s.pixelCount > 0).length;
  }
  return n;
}

test('Save does nothing until the page has the string config, then saves it', async ({ page }) => {
  const { holding, release, posts } = await holdConfig(page);
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  await holding;
  await page.locator('#stringTab-tab').click();
  const save = saveButton(page);
  await expect(save).toBeVisible();

  // The page is showing its defaults: the gap heffneil's phone was in.
  await expect(page.locator('#PixelString_enable')).not.toBeChecked();
  await expect(save, 'Save is offered before the config has loaded').toBeDisabled();
  // A disabled button runs nothing however it is clicked.
  await save.click({ force: true });
  await page.waitForTimeout(1000);
  expect(posts, 'what Save wrote before the config had loaded').toEqual([]);

  release();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  const out = posts[0].channelOutputs.find((o: any) => o.type !== 'BBBSerial');
  expect(out.enabled, 'the cape stays enabled').toBe(1);
  expect(stringCount(posts[0]), 'the strings are kept').toBeGreaterThan(0);
});

test('Save stays off when the string config cannot be loaded', async ({ page }) => {
  const posts: any[] = [];
  await page.route(CONFIG, async (route: Route) => {
    if (route.request().method() === 'POST') {
      posts.push(JSON.parse(route.request().postData() || 'null'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"OK"}' });
      return;
    }
    await route.fulfill({ status: 500, body: 'fpp-tests: load failed' });
  });
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  const save = saveButton(page);
  await expect(save).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(save, 'Save is offered after the config failed to load').toBeDisabled();
  await expect(page.locator('#jGrowl'), 'the user is told why Save is off').toContainText('Unable to load the Pixel String configuration');
  await save.click({ force: true });
  await page.waitForTimeout(1000);
  expect(posts, 'what Save wrote after the config failed to load').toEqual([]);
});

test('with no string config saved yet, Save is available for the first one', async ({ page }) => {
  // A new cape, a changed virtual EEPROM or Reset Config leaves no file, and
  // the API answers 404: the defaults on the page are then the config, and
  // Save is the only way to write the first one.
  const posts: any[] = [];
  await page.route(CONFIG, async (route: Route) => {
    if (route.request().method() === 'POST') {
      posts.push(JSON.parse(route.request().postData() || 'null'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"OK"}' });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{"status":"OK"}' });
  });
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  const save = saveButton(page);
  await expect(save, 'Save with no config saved yet').toBeEnabled({ timeout: 15_000 });
  await save.click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  await expect(page.locator('#jGrowl')).not.toContainText('Unable to load');
});

test('Revert turns Save off again until the config is back', async ({ page }) => {
  const { holding, release, posts } = await holdConfig(page);
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  await holding;
  release();
  await page.locator('#stringTab-tab').click();
  const save = saveButton(page);
  await expect(save).toBeEnabled({ timeout: 15_000 });

  const again = await holdConfig(page);
  await page.locator('#stringTab input[type=button][value="Revert"]').click();
  await again.holding;
  await expect(save, 'Save while Revert is reloading').toBeDisabled();
  await save.click({ force: true });
  await page.waitForTimeout(1000);
  expect([...posts, ...again.posts], 'what Save wrote while Revert was reloading').toEqual([]);
  again.release();
  await expect(save).toBeEnabled({ timeout: 15_000 });
});
