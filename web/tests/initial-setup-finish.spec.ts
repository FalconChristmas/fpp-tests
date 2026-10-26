import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import http from 'http';
import { container, inPlayer } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// The setup wizard, run again over this player (initialSetup-02 back to 0):
// what it shows before it is finished, and what finishing it with a UI
// password saves.  The settings file is put back after each test, and a UI
// password turned on is turned off again.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const PASSWORD = 'fpp-tests-pw3';
const PWCONF = '/home/fpp/media/config/ui-password-config.conf';
const NO_PASSWORD = '<RequireAny>\n  Require all granted\n</RequireAny>\n\nSetEnvIf Host ^ LOCAL_PROTECT=0\n';

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

// A request on a connection of its own, so a kept-alive one from before an
// Apache reload cannot answer under the old config.
function status(path: string, password = ''): Promise<number> {
  const base = test.info().project.use.baseURL!;
  const headers: Record<string, string> = password
    ? { Authorization: 'Basic ' + Buffer.from(`admin:${password}`).toString('base64') } : {};
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on('error', reject);
  });
}

async function disablePassword(request: APIRequestContext) {
  if (await status('/api/fppd/version') === 200) return;
  const auth = { Authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64') };
  await request.put('/api/settings/passwordEnable', { data: '0', headers: auth });
  try {
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  } catch {
    inPlayer('sh', '-c', `printf '%s' '${NO_PASSWORD}' > ${PWCONF} && apache2ctl graceful`);
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  }
}

test('the reboot banner waits until setup is finished', async ({ page }) => {
  // Regression: 51f809c55 (#2752).  A reboot flagged before the wizard was
  // done (the first boot's filesystem expansion sets one) showed its banner
  // over the wizard, as if the user had changed something.
  setSettingInFile('rebootFlag', '1');
  setSettingInFile('initialSetup-02', '0');
  await page.goto('/initialSetup.php');
  await page.waitForFunction(() => typeof (window as any).CheckRestartRebootFlags === 'function');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#rebootFlag')).toBeAttached();
  await expect(page.locator('#rebootFlag'), 'the reboot banner shows during setup').toBeHidden();

  // The control: once setup is done the same flag shows its banner.
  setSettingInFile('initialSetup-02', '1');
  await page.goto('/index.php');
  await expect(page.locator('#rebootFlag')).toBeVisible({ timeout: 15_000 });
});

async function walkWizard(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/initialSetup.php');
  await expect(page.locator('.setupStep[data-step="1"]')).toBeVisible();
  await page.selectOption('#LegalJurisdiction', 'US');
  for (const step of [2, 3, 4]) {
    await page.click('#setupNextBtn');
    await expect(page.locator(`.setupStep[data-step="${step}"]`)).toBeVisible({ timeout: 60_000 });
  }
}

test('finishing setup with a UI password saves the password, not its verify field, and goes on to the status page', async ({ page, request }) => {
  // Regression: acb8f91a6.  The wizard's save wrote every pending field,
  // the UI-only passwordVerify (and osPasswordVerify) among them, and a
  // failed save (the callback was misspelled failcallback) never reached
  // the redirect.  The receiving end is Apache: it now asks for the
  // password chosen.
  test.setTimeout(180_000);
  setSettingInFile('initialSetup-02', '0');
  setSettingInFile('passwordEnable', '0');
  try {
    await walkWizard(page);
    await page.selectOption('#passwordEnable', '1');
    await page.fill('#password', PASSWORD);
    await page.fill('#passwordVerify', PASSWORD);
    await page.click('#finishSetupBtn');
    await expect(page).toHaveURL(/index\.php/, { timeout: 60_000 });
    expect(settingInFile('initialSetup-02')).toBe('1');
    expect(settingInFile('passwordVerify'), 'the verify field was saved as a setting').toBeUndefined();
    expect(settingInFile('osPasswordVerify')).toBeUndefined();
    await expect.poll(() => status('/api/fppd/version'), { timeout: 20_000 }).toBe(401);
    expect(await status('/api/fppd/version', PASSWORD)).toBe(200);
  } finally {
    await disablePassword(request);
  }
});
