import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import http from 'http';
import { container, inPlayer, playerAddress } from './container';

// What /proxy forwards back to the player's own address still needs the UI
// password.  Fixed in fpp 3c0f27b22 ("fix(apache): requests /proxy sends back
// to this player are not \"local\""): /proxy/<own address>/ produced requests
// from the server's own address, which "Require local" counts as local, so
// anyone on the LAN skipped the password.  /proxy now marks what it forwards,
// and the local exemptions refuse a marked request.
//
// ui-password-proxy.spec.ts checks this too, but after its kiosk step, which
// is red on 3c0f27b22 itself (d163b8045 fixed the kiosk); this one has no
// kiosk step, so verify-fix can run it on 3c0f27b22.

const PASSWORD = 'fpp-tests-pw';
const AUTH = { Authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64') };
const PWCONF = '/home/fpp/media/config/ui-password-config.conf';
const NO_PASSWORD = '<RequireAny>\n  Require all granted\n</RequireAny>\n\nSetEnvIf Host ^ LOCAL_PROTECT=0\n';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// From outside the player, on a connection of its own (one kept alive from
// before a reload could be answered under the old config).
function status(path: string, headers: Record<string, string> = {}): Promise<number> {
  const base = test.info().project.use.baseURL!;
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on('error', reject);
  });
}

async function disablePassword(request: APIRequestContext) {
  await request.put('/api/settings/passwordEnable', { data: '0', headers: AUTH });
  try {
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  } catch {
    // Put the open config back whatever happened, or every later test is shut out.
    inPlayer('sh', '-c', `printf '%s' '${NO_PASSWORD}' > ${PWCONF} && apache2ctl graceful`);
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  }
}

test('a request /proxy sends back to the player itself still needs the password', async ({ request }) => {
  const proxied = `/proxy/${playerAddress().ip}/api/fppd/version`;
  expect((await request.put('/api/settings/password?skipBackup=1', { data: PASSWORD })).ok()).toBe(true);
  expect((await request.put('/api/settings/passwordEnable', { data: '1' })).ok()).toBe(true);
  try {
    // The control: the password is on, for a request straight to the player.
    await expect.poll(() => status('/api/fppd/version'), { timeout: 15_000 }).toBe(401);
    expect(await status(proxied, AUTH)).toBe(200);
    expect(await status(proxied), 'the proxied request skipped the password').toBe(401);
  } finally {
    await disablePassword(request);
  }
});
