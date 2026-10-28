import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { container, inPlayer } from './container';

// Save on the Channel Outputs PWM tab before the page has its config -- the
// PWM counterpart of pixel-strings-save-before-load.spec.ts (issue #3124).
// The tab is drawn with defaults (output disabled, every port blank) and
// loadPWMOutputs() fills it in afterwards, with no .fail handler.  A Save in
// that gap, or after a failed load, wrote the defaults over the saved config.
// Fixed in fpp 324fe763a
// ("fix(outputs): check PWM, Other and DMX are fully loaded enabling save").
//
// The PWM tab exists only with a signed cape that provides PWM.  In the
// run-web.sh container the test gives it one for the length of each test,
// where cape detection unpacks it from the EEPROM: media/tmp/cape-info.json
// (provides pwm, signed) and its port layout in media/tmp/pwm.  Against
// another player it runs only if the player has a PWM tab.  The config GET is
// held and answered by a route, and every POST is answered here, so the
// player's PWM config is not changed.

const CONFIG = /\/api\/channel\/output\/co-pwm(\?|$)/;

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const PWM_FILE = `${MEDIA}/tmp/pwm/FppTestsPWM.json`;
// "all" keeps the page's other tabs; any key but the FPP project's own signs it.
const CAPE_INFO_JSON = {
  id: 'FppTestsPWM', name: 'fpp-tests PWM', version: '1.0', serialNumber: 'SN0001',
  provides: ['all', 'pwm'], verifiedKeyId: 'ft',
};
const PWM_CAPE = {
  name: 'FppTestsPWM', longName: 'fpp-tests 2-port PWM cape', driver: 'PCA9685',
  outputs: [{ label: 'Port 1' }, { label: 'Port 2' }],
};
// What the held GET answers: port 1 a servo with a description, so a Save of
// the loaded page can be told from one of the defaults.
const SAVED = {
  channelOutputs: [{
    type: 'PCA9685', subType: 'FppTestsPWM', enabled: 1, frequency: '50hz', startChannel: 0, channelCount: -1,
    outputs: [
      { description: 'fpp-tests servo', startChannel: 10, is16bit: 1, type: 'Servo', min: 1000, max: 2000, reverse: 0, zero: 'Hold', dataType: 'Scaled' },
      { description: '', startChannel: 12, is16bit: 1, type: 'Servo', min: 1000, max: 2000, reverse: 0, zero: 'Hold', dataType: 'Scaled' },
    ],
  }],
};

function writeFile(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}

function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let kept: Record<string, string | null> = {};

test.beforeEach(() => {
  if (!container) return;
  kept = { [CAPE_INFO]: readFile(CAPE_INFO), [PWM_FILE]: readFile(PWM_FILE) };
  writeFile(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
  writeFile(PWM_FILE, JSON.stringify(PWM_CAPE));
});

test.afterEach(() => {
  if (!container) return;
  for (const [p, content] of Object.entries(kept)) {
    if (content === null) inPlayer('rm', '-f', p); else writeFile(p, content);
  }
});

// Holds the page's GET of the config until release(), then answers it with
// SAVED (or answers it at once with `status`); answers every POST here,
// recording the body.
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAVED) });
  });
  return { holding, release, posts };
}

const saveButton = (page: Page) => page.locator('#tab-pwm input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');

async function open(page: Page) {
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  test.skip((await page.locator('#tab-pwm-tab').count()) === 0, 'no PWM cape, so no PWM tab');
  await page.locator('#tab-pwm-tab').click();
}

test('Save does nothing until the page has the PWM config, then saves it', async ({ page }) => {
  const { holding, release, posts } = await routeConfig(page);
  await open(page);
  await holding;
  await expect(saveButton(page), 'Save is offered before the config has loaded').toBeDisabled();
  await saveButton(page).click({ force: true });
  await page.waitForTimeout(1000);
  expect(posts, 'what Save wrote before the config had loaded').toEqual([]);

  release();
  await expect(saveButton(page)).toBeEnabled({ timeout: 15_000 });
  await saveButton(page).click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  const saved = posts[0].channelOutputs[0];
  expect(saved.enabled, 'the output stays enabled').toBe(1);
  expect(saved.outputs[0].description, 'the loaded port is kept').toBe('fpp-tests servo');
});

test('Save stays off when the PWM config cannot be loaded', async ({ page }) => {
  const { posts } = await routeConfig(page, 500);
  await open(page);
  await expect(page.locator('#jGrowl'), 'the user is told why Save is off')
    .toContainText('Unable to load the PWM configuration', { timeout: 15_000 });
  await expect(saveButton(page), 'Save is offered after the config failed to load').toBeDisabled();
  await saveButton(page).click({ force: true });
  await page.waitForTimeout(1000);
  expect(posts, 'what Save wrote after the config failed to load').toEqual([]);
});

test('with no PWM config saved yet, Save is available', async ({ page }) => {
  const { posts } = await routeConfig(page, 404);
  await open(page);
  await expect(saveButton(page), 'Save with no config saved yet').toBeEnabled({ timeout: 15_000 });
  await saveButton(page).click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  await expect(page.locator('#jGrowl')).not.toContainText('Unable to load');
});
