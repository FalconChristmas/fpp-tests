import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { container, inPlayer } from './container';

// Save on the Pixel Strings page before the page has its config (issue #3124),
// in the run-web.sh container.  Fixed in fpp 1470ffeeb ("fix(outputs): Pixel
// Strings Save waits for the saved config (#3124)").
//
// pixel-strings-save-before-load.spec.ts checks the same against a real Pi and
// skips here, as the container has no Pixel Strings tab.  This one gives the
// container one the way pixel-strings-dpi.spec.ts does: the player claims to
// be a Raspberry Pi for the length of each test (config.php reads
// /etc/fpp/platform), with a two-port DPIPixels hat where cape detection
// unpacks it and a saved co-pixelStrings.json with the cape enabled and two
// strings.  fppd, already running, is not affected.
//
// loadPixelStringOutputs() draws the page from built-in defaults -- no strings,
// "Enable" unchecked -- and only then asks for the real config, with no .fail
// handler.  A Save pressed in between wrote those defaults over the real
// config: the cape disabled and every string gone.  The config GET is held by
// a route until the test lets it go, so the gap is certain; every POST of the
// config is answered by the test, and the file on the player is checked to be
// unchanged afterwards.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsDPI.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG_FILE = `${MEDIA}/config/co-pixelStrings.json`;

const CAPE = {
  name: 'FppTestsDPI', longName: 'fpp-tests 2-port DPI hat', driver: 'DPIPixels', numSerial: 0,
  outputs: [{ pin: 'P1-7' }, { pin: 'P1-11' }],
  groups: [{ start: 1, count: 2 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsDPI', name: 'fpp-tests DPI', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};
const vstring = (startChannel: number, pixelCount: number) => ({
  description: 'fpp-tests', startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
  nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
});
const SAVED = JSON.stringify({ channelOutputs: [{
  type: 'DPIPixels', subType: 'FppTestsDPI', pinoutVersion: '1.x', enabled: 1, startChannel: 1, channelCount: -1,
  outputCount: 2, outputs: [
    { portNumber: 0, protocol: 'ws2811', virtualStrings: [vstring(0, 100)] },
    { portNumber: 1, protocol: 'ws2811', virtualStrings: [vstring(300, 50)] }],
}] });

function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}
function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG_FILE]) saved[p] = read(p);
  write(PLATFORM, 'Raspberry Pi');
  write(CAPE_FILE, JSON.stringify(CAPE));
  write(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
  write(CONFIG_FILE, SAVED);
});
test.afterEach(() => {
  // Nothing the page sent reached the player: every POST was answered here.
  expect(read(CONFIG_FILE), 'the saved string config on the player').toBe(SAVED);
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

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

const saveButton = (page: Page) => page.locator('#stringTab input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');

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

  // The page is showing its defaults: the gap a slow phone was in.
  await expect(page.locator('#PixelString_enable')).not.toBeChecked();
  await expect(save, 'Save is offered before the config has loaded').toBeDisabled();
  await save.click({ force: true });
  await page.waitForTimeout(1000);
  expect(posts, 'what Save wrote before the config had loaded').toEqual([]);

  release();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  const out = posts[0].channelOutputs.find((o: any) => o.type === 'DPIPixels');
  expect(out.enabled, 'the cape stays enabled').toBe(1);
  expect(stringCount(posts[0]), 'the strings are kept').toBe(2);
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
  // A new cape or Reset Config leaves no file and the API answers 404: the
  // defaults on the page are then the config, and Save writes the first one.
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
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
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
