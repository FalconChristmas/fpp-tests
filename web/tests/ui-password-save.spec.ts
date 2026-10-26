import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import http from 'http';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// Feature: 2d0e1ccf2 ("improve UI password handling and save process",
// #2829).  The UI password fields on Settings > UI saved one at a time as
// they changed, so turning the password on was applied (Apache reloaded
// with basic auth) before the password typed had been written, and the
// browser was challenged for the interim default; and choosing "Enter a
// Password" asked to reset a saved password to 'falcon'.  Now the fields are
// staged, and Save UI Password writes the password first and the switch
// last.  The receiving end is Apache: what it asks for afterwards.

const PASSWORD = 'fpp-tests-pw2';
const PWCONF = '/home/fpp/media/config/ui-password-config.conf';
const NO_PASSWORD = '<RequireAny>\n  Require all granted\n</RequireAny>\n\nSetEnvIf Host ^ LOCAL_PROTECT=0\n';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// A request on a connection of its own, so a kept-alive one from before a
// reload cannot answer under the old config.
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

async function reloadApache() {
  const generation = () => Number(/ParentServerConfigGeneration: (\d+)/.exec(
    inPlayer('curl', '-s', 'http://127.0.0.1/server-status?auto'))?.[1] ?? NaN);
  const before = generation();
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(generation, { timeout: 10_000 }).toBeGreaterThan(before);
}

// Whatever the page did, leave the player open for the tests after this one.
async function disablePassword(request: APIRequestContext) {
  if (await status('/api/fppd/version') === 200) return;
  for (const pw of [PASSWORD, 'falcon']) {
    const auth = { Authorization: 'Basic ' + Buffer.from(`admin:${pw}`).toString('base64') };
    await request.put('/api/settings/passwordEnable', { data: '0', headers: auth });
  }
  try {
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  } catch {
    inPlayer('sh', '-c', `printf '%s' '${NO_PASSWORD}' > ${PWCONF}`);
    await reloadApache();
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  }
}

test('choosing Enter a Password keeps the saved password, asks nothing and saves nothing yet', async ({ page }) => {
  await keepingSettings(async () => {
    setSettingInFile('passwordEnable', '0');
    setSettingInFile('password', PASSWORD);
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    // Nothing is to be saved by choosing; any save is recorded and swallowed.
    const saves: string[] = [];
    await page.route((u) => /\/api\/settings\/(password|passwordVerify|passwordEnable)$/.test(u.pathname),
      (route) => {
        if (route.request().method() === 'GET') return route.continue();
        saves.push(new URL(route.request().url()).pathname);
        return route.fulfill({ json: { status: 'OK' } });
      });
    await page.goto('/settings.php?tab=UI');
    await page.click('#settings-ui-tab');
    await expect(page.locator('#passwordEnable')).toHaveValue('0', { timeout: 15_000 });
    await page.locator('#passwordEnable').selectOption('1');
    await expect(page.locator('#password')).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(dialogs, 'choosing asked to reset the saved password').toEqual([]);
    await expect(page.locator('#password')).toHaveValue(PASSWORD);
    await expect(page.locator('#passwordVerify')).toHaveValue(PASSWORD);
    expect(saves, 'choosing saved a password setting').toEqual([]);
    await expect(page.locator('#uiPasswordSaveStatus')).toContainText('Not applied yet');
  });
});

test('Save UI Password writes the password before turning it on, so Apache asks for the one chosen', async ({ page, request }) => {
  test.setTimeout(90_000);
  try {
    await keepingSettings(async () => {
      setSettingInFile('passwordEnable', '0');
      setSettingInFile('password', '');
      await page.goto('/settings.php?tab=UI');
      await page.click('#settings-ui-tab');
      await expect(page.locator('#passwordEnable')).toHaveValue('0', { timeout: 15_000 });
      await page.locator('#passwordEnable').selectOption('1');
      // With no password saved the fields are seeded with the default.
      await expect(page.locator('#password')).toHaveValue('falcon');
      await page.fill('#password', PASSWORD);
      await page.fill('#passwordVerify', PASSWORD);
      const order: string[] = [];
      page.on('request', (r) => {
        const m = /\/api\/settings\/(password|passwordEnable)(\?|$)/.exec(r.url());
        if (m && r.method() === 'PUT') order.push(m[1]);
      });
      page.on('dialog', (d) => d.accept());
      await page.click('#saveUIPasswordBtn');
      await expect.poll(() => status('/api/fppd/version'), { timeout: 20_000, message: 'no password is asked for' }).toBe(401);
      expect(order).toEqual(['password', 'passwordEnable']);
      expect(await status('/api/fppd/version', PASSWORD), 'Apache refuses the password chosen').toBe(200);
      expect(await status('/api/fppd/version', 'falcon'), 'Apache takes the interim default').toBe(401);
    });
  } finally {
    await disablePassword(request);
  }
});
