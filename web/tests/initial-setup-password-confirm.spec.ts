import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import http from 'http';
import { container, inPlayer } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Finishing the setup wizard with a UI password asks the user to confirm it.
// The settings file is put back after the test, and a UI password turned on
// is turned off again.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const PASSWORD = 'fpp-tests-pw4';
const PWCONF = '/home/fpp/media/config/ui-password-config.conf';
const NO_PASSWORD = '<RequireAny>\n  Require all granted\n</RequireAny>\n\nSetEnvIf Host ^ LOCAL_PROTECT=0\n';

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

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

async function toSecurityStep(page: Page) {
  await page.goto('/initialSetup.php');
  await expect(page.locator('.setupStep[data-step="1"]')).toBeVisible();
  await page.selectOption('#LegalJurisdiction', 'US');
  for (const step of [2, 3, 4]) {
    await page.click('#setupNextBtn');
    await expect(page.locator(`.setupStep[data-step="${step}"]`)).toBeVisible({ timeout: 60_000 });
  }
}

test('Finish shows the UI password to be written down, and turning that down saves nothing', async ({ page, request }) => {
  // Regression: 7e83d7a9e.  Setup with a UI password went straight to
  // saving it: a password typed wrong, or not written down, could lock the
  // user out of the web UI (and xLights' FPP Connect) with no way back but
  // a reinstall.  Finish now confirms the password first.
  test.setTimeout(180_000);
  setSettingInFile('initialSetup-02', '0');
  setSettingInFile('passwordEnable', '0');
  const asked: string[] = [];
  page.on('dialog', (d) => {
    if (d.message().includes('as a password')) { asked.push(d.message()); d.dismiss(); } else d.accept();
  });
  try {
    await toSecurityStep(page);
    await page.selectOption('#passwordEnable', '1');
    await page.fill('#password', PASSWORD);
    await page.fill('#passwordVerify', PASSWORD);
    await page.click('#finishSetupBtn');
    await expect.poll(() => asked.length, { timeout: 15_000, message: 'no confirmation of the password' }).toBe(1);
    expect(asked[0]).toContain(`'${PASSWORD}'`);
    // Turned down: setup is not finished, the password not saved, Apache not asking for one.
    await page.waitForTimeout(3_000);
    expect(page.url()).toContain('initialSetup.php');
    expect(settingInFile('initialSetup-02')).toBe('0');
    expect(settingInFile('password')).toBeUndefined();
    expect(await status('/api/fppd/version')).toBe(200);
  } finally {
    await disablePassword(request);
  }
});
