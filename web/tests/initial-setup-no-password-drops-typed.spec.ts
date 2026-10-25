import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { snapshotSettings, putFile, exists } from './settings-file';

// A password typed into the setup wizard and then dropped by choosing "No
// Password" is not saved. Regression: 52f72663c ("choosing "No Password" and
// Saving errors if the browser autofills the password boxes", #2605), which
// first filtered the password values out under No Password, and 71a4efa71
// ("fix(setup): a password typed before choosing "No Password" is not
// saved"), which put that filter back. 93e3590f2 moved
// finishSetup()'s No Password filter from the password values to the enable
// keys, so a value typed (or autofilled) before the choice went out on its
// own. The UI password was written to the settings file and to .htpasswd,
// where turning the password on later from the Settings page picks it up.
// The OS password field is reset to the default when its choice goes back to
// the default, and that went out too, without skipApply: a chpasswd nobody
// asked for, and an osPassword left in the settings file.
//
// The OS password is offered only on a player: /etc/fpp/platform present and
// /etc/fpp/container absent. So the page is rendered with the container
// marker moved aside and a platform marker holding what config.php falls back
// to without one (uname -s), and both are put back as soon as it has loaded,
// before anything is saved. The password PUTs are answered here and never
// reach the player: what is asserted is that the wizard sends none, and
// nothing in the container runs chpasswd.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const PLATFORM = '/etc/fpp/platform';
const CONTAINER = '/etc/fpp/container';
const ASIDE = '/etc/fpp/container.fpp-tests';
let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => {
  restoreMarkers();
  restoreSettings();
});

let wrotePlatform = false;
function claimPlayer() {
  if (!exists(PLATFORM)) {
    putFile(PLATFORM, inPlayer('uname', '-s'));
    wrotePlatform = true;
  }
  if (exists(CONTAINER)) {
    inPlayer('mv', CONTAINER, ASIDE);
  }
}
function restoreMarkers() {
  if (exists(ASIDE)) {
    inPlayer('mv', ASIDE, CONTAINER);
  }
  if (wrotePlatform) {
    inPlayer('rm', '-f', PLATFORM);
    wrotePlatform = false;
  }
}

async function typePassword(page: Page, enable: string, field: string, value: string) {
  await page.selectOption(`#${enable}`, '1');
  for (const id of [field, `${field}Verify`]) {
    await page.fill(`#${id}`, value);
    await page.locator(`#${id}`).blur();
  }
}

test('a password typed before choosing No Password is not saved', async ({ page }) => {
  test.setTimeout(120_000);
  const sent: string[] = [];
  await page.route(/\/api\/settings\/(password|osPassword)(\?|$)/, async (route) => {
    if (route.request().method() !== 'PUT') {
      return route.continue();
    }
    sent.push(`${new URL(route.request().url()).pathname} = ${route.request().postData()}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"OK"}' });
  });
  page.on('dialog', (d) => d.accept());

  claimPlayer();
  try {
    await page.goto('/initialSetup.php', { waitUntil: 'domcontentloaded' });
  } finally {
    restoreMarkers();
  }
  await expect(page.locator('#osPasswordEnable'), 'the OS password is not offered').toBeAttached();
  for (const step of [2, 3, 4]) {
    await page.click('#setupNextBtn');
    await expect(page.locator(`.setupStep[data-step="${step}"]`)).toBeVisible({ timeout: 60_000 });
  }

  await typePassword(page, 'passwordEnable', 'password', 'fpp-tests-ui-pw');
  await typePassword(page, 'osPasswordEnable', 'osPassword', 'fpp-tests-os-pw');
  await page.selectOption('#passwordEnable', '0');
  await page.selectOption('#osPasswordEnable', '0');
  // Both values reached the wizard, so dropping them is the wizard's doing.
  const pending = await page.evaluate(() => {
    const p = (window as any).pendingSettings;
    return { password: p.password, osPassword: p.osPassword };
  });
  expect(pending.password).toBe('fpp-tests-ui-pw');
  expect(pending.osPassword, 'no OS password is pending').toBeTruthy();

  const choice = page.waitForRequest((r) => r.method() === 'PUT' && /\/api\/settings\/passwordEnable(\?|$)/.test(r.url()));
  await page.click('#finishSetupBtn');
  await expect(page).toHaveURL(/index\.php/, { timeout: 30_000 });
  // The No Password choice itself is still recorded (288ca0d2f).
  expect((await choice).postData()).toBe('0');
  expect(sent, 'a password went out although No Password was chosen').toEqual([]);
});
