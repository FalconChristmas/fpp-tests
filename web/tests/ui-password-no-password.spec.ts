import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import http from 'http';
import { container, inPlayer } from './container';

// Regression: 7d0727995 ("apply "No Password" as soon as it is selected",
// #2985). The UI password settings are staged and applied by the Save UI
// Password button, and that button hides with the password fields whenever the
// dropdown reads "No Password": once a password was set, choosing No Password
// had nothing to click, and the change was silently dropped. Turning the
// password off now applies at once.

const PASSWORD = 'fpp-tests-pw';
const AUTH = { Authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64') };
const PWCONF = '/home/fpp/media/config/ui-password-config.conf';
const NO_PASSWORD = '<RequireAny>\n  Require all granted\n</RequireAny>\n\nSetEnvIf Host ^ LOCAL_PROTECT=0\n';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// A request on a connection of its own, so a kept-alive one from before a
// reload cannot answer under the old config.
function status(path: string, headers: Record<string, string> = {}): Promise<number> {
  const base = test.info().project.use.baseURL!;
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

async function enablePassword(request: APIRequestContext) {
  expect((await request.put('/api/settings/password?skipBackup=1', { data: PASSWORD })).ok()).toBe(true);
  expect((await request.put('/api/settings/passwordEnable', { data: '1' })).ok()).toBe(true);
  await expect.poll(() => status('/api/fppd/version'), { timeout: 15_000 }).toBe(401);
}

// Whatever the page did, leave the player open for the tests after this one.
async function disablePassword(request: APIRequestContext) {
  if (await status('/api/fppd/version') === 200) return;
  await request.put('/api/settings/passwordEnable', { data: '0', headers: AUTH });
  try {
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  } catch {
    inPlayer('sh', '-c', `printf '%s' '${NO_PASSWORD}' > ${PWCONF}`);
    await reloadApache();
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  }
}

test('choosing No Password on a protected player turns the password off', async ({ browser, request }) => {
  // Room for the clean-up after a failure, which reloads Apache.
  test.setTimeout(90_000);
  await enablePassword(request);
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password: PASSWORD } });
  try {
    const page = await context.newPage();
    await page.goto('/settings.php?tab=UI');
    const select = page.locator('#passwordEnable');
    await expect(select).toHaveValue('1', { timeout: 15_000 });
    await select.selectOption('0');
    // No Save click: the choice is applied by itself.
    await expect.poll(() => status('/api/fppd/version'), { timeout: 20_000, message: 'the password is still required' }).toBe(200);
    expect(inPlayer('sh', '-c', "grep '^passwordEnable' /home/fpp/media/settings || true")).toContain('"0"');
  } finally {
    await context.close();
    await disablePassword(request);
  }
});
