import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import http from 'http';
import { container, inPlayer, playerAddress } from './container';

// The UI password and /proxy, from fpp d163b8045 ("fix(apache): a localhost
// kiosk's proxied requests stay local; upgrade 155 rewrites old password
// configs").
//
// /proxy marks what it forwards (X-FPP-Proxied), so a request proxied back to
// the player's own LAN address, which "Require local" counts as local, still
// has to give the password (3c0f27b22).  But a kiosk browser on the player at
// http://localhost is local already, and its UI reaches the player itself
// through /proxy/<own LAN IP>/: before the fix those requests were marked too,
// and asked the kiosk for a password it never gave.
//
// Upgrade 155 added the X-FPP-Proxied test to an existing password config by
// inserting a "Require expr" line after "Require local".  In a config whose
// Require lines are bare alternatives (no <RequireAll>), that line is one more
// way in, and every request without the header got in without a password.

const PASSWORD = 'fpp-tests-pw';
const AUTH = { Authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64') };
const PWCONF = '/home/fpp/media/config/ui-password-config.conf';
// What fppinit writes on a player with no UI password, and run-web.sh starts with.
const NO_PASSWORD = '<RequireAny>\n  Require all granted\n</RequireAny>\n\nSetEnvIf Host ^ LOCAL_PROTECT=0\n';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// A request from outside the player, on a connection of its own: one kept
// alive from before a reload could still be answered under the old config.
function status(path: string, headers: Record<string, string> = {}): Promise<number> {
  const base = test.info().project.use.baseURL!;
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on('error', reject);
  });
}

// Reload Apache and wait until the new configuration is the one answering.
async function reloadApache() {
  const generation = () => Number(/ParentServerConfigGeneration: (\d+)/.exec(
    inPlayer('curl', '-s', 'http://127.0.0.1/server-status?auto'))?.[1] ?? NaN);
  const before = generation();
  expect(before).not.toBeNaN();
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(generation, { timeout: 10_000 }).toBeGreaterThan(before);
}

// From the player's own loopback, as its kiosk browser asks.
function statusFromLoopback(path: string) {
  return inPlayer('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1${path}`);
}

// As the UI does it: the password first, then switching it on (which
// rewrites the password config and reloads Apache).
async function enablePassword(request: APIRequestContext) {
  expect((await request.put('/api/settings/password?skipBackup=1', { data: PASSWORD })).ok()).toBe(true);
  expect((await request.put('/api/settings/passwordEnable', { data: '1' })).ok()).toBe(true);
  await expect.poll(() => status('/api/fppd/version'), { timeout: 15_000 }).toBe(401);
}

async function disablePassword(request: APIRequestContext) {
  await request.put('/api/settings/passwordEnable', { data: '0', headers: AUTH });
  try {
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  } catch {
    // Whatever state the config was left in, put the open one back, or every
    // later test is shut out.
    inPlayer('sh', '-c', `printf '%s' '${NO_PASSWORD}' > ${PWCONF}`);
    await reloadApache();
    await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
  }
}

test('a kiosk on loopback reaches the player through /proxy/<own IP>/ without the password', async ({ request }) => {
  const { ip } = playerAddress();
  const proxied = `/proxy/${ip}/api/fppd/version`;
  await enablePassword(request);
  try {
    // Before the fix: 401, the proxied hop marked and so not local.
    expect(statusFromLoopback(proxied)).toBe('200');
    // Still the password for everyone else, through /proxy or not.
    expect(await status(proxied)).toBe(401);
    expect(await status('/api/fppd/version')).toBe(401);
    expect(await status(proxied, AUTH)).toBe(200);
  } finally {
    await disablePassword(request);
  }
});

test('upgrade 155 leaves an old password config still asking for the password', async ({ request }) => {
  await enablePassword(request);
  try {
    // A password config of the older shape: bare Require alternatives.
    inPlayer('sh', '-c', `cat > ${PWCONF} <<'EOF'
AuthUserFile /home/fpp/media/config/.htpasswd
AuthType Basic
AuthName "Falcon Player"
<RequireAny>
  Require local
  Require valid-user
</RequireAny>

SetEnvIf Host ^ LOCAL_PROTECT=1
EOF`);
    await reloadApache();
    expect(await status('/api/fppd/version')).toBe(401);

    // Its own reload goes through systemd, which the container doesn't run,
    // so it exits non-zero after doing its work; reload Apache for it.
    try {
      inPlayer('bash', '/opt/fpp/upgrade/155/upgrade.sh');
    } catch {
      // the failed reload
    }
    await reloadApache();
    expect(inPlayer('cat', PWCONF)).toContain('X-FPP-Proxied');

    // Before the fix: 200 for anyone, the inserted line letting them in.
    expect(await status('/api/fppd/version')).toBe(401);
    expect(await status('/api/fppd/version', AUTH)).toBe(200);
    expect(statusFromLoopback('/api/fppd/version')).toBe('200');
  } finally {
    await disablePassword(request);
  }
});

// What the first version of upgrade 155 (fpp 3c0f27b22) left behind on the
// older shape: its inserted line is a bare alternative, and lets in anyone.
// That version was published before d163b8045 rewrote it, and a player that
// ran it is past 155 for good. Upgrade 156 (fpp f1e62402c, "fix(upgrade): 156
// repairs a password config the first upgrade 155 broke") rewrites it.
test('upgrade 156 repairs a password config the first upgrade 155 opened up', async ({ request }) => {
  await enablePassword(request);
  try {
    inPlayer('sh', '-c', `cat > ${PWCONF} <<'EOF'
AuthUserFile /home/fpp/media/config/.htpasswd
AuthType Basic
AuthName "Falcon Player"
<RequireAny>
  Require local
  Require expr "%{HTTP:X-FPP-Proxied} == ''"
  Require valid-user
</RequireAny>

SetEnvIf Host ^ LOCAL_PROTECT=1
EOF`);
    await reloadApache();
    // The broken config really is open: no password asked.
    expect(await status('/api/fppd/version')).toBe(200);

    try {
      inPlayer('bash', '/opt/fpp/upgrade/156/upgrade.sh');
    } catch {
      // no upgrade 156 in the tree under test
    }
    await reloadApache();

    expect(await status('/api/fppd/version')).toBe(401);
    expect(await status('/api/fppd/version', AUTH)).toBe(200);
    expect(statusFromLoopback('/api/fppd/version')).toBe('200');
    // Run again, it changes nothing.
    const once = inPlayer('cat', PWCONF);
    inPlayer('bash', '/opt/fpp/upgrade/156/upgrade.sh');
    expect(inPlayer('cat', PWCONF)).toBe(once);
  } finally {
    await disablePassword(request);
  }
});

test('upgrade 156 leaves a player with no UI password open', async () => {
  const before = inPlayer('cat', PWCONF);
  expect(before).toContain('Require all granted');
  try {
    inPlayer('bash', '/opt/fpp/upgrade/156/upgrade.sh');
  } catch {
    // no upgrade 156 in the tree under test
  }
  await reloadApache();
  expect(inPlayer('cat', PWCONF)).toBe(before);
  expect(await status('/api/fppd/version')).toBe(200);
});

// The UI password was stored as unsalted SHA-1 ({SHA}), because bcrypt at
// PHP's default cost made every page take seconds on a single-core BeagleBone.
// Fixed in fpp 651d8e4e5 ("fix(security): hash the UI password with bcrypt on
// multi-core boards"): a board with more than one core, as the test player
// has, gets bcrypt at a cost calibrated to verify in about 10 ms.
test('the UI password is stored as a bcrypt hash, and Apache checks it', async ({ request }) => {
  await enablePassword(request);
  try {
    expect(inPlayer('cat', '/home/fpp/media/config/.htpasswd')).toMatch(/^admin:\$2y\$/);
    expect(await status('/api/fppd/version', AUTH)).toBe(200);
    const wrong = { Authorization: 'Basic ' + Buffer.from('admin:not-the-password').toString('base64') };
    expect(await status('/api/fppd/version', wrong)).toBe(401);
  } finally {
    await disablePassword(request);
  }
});
