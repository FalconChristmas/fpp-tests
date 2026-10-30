import { test, expect } from './fixtures';
import { container } from './container';
import { BACKUPS, readFile, setSettingInFile, snapshotSettings } from './settings-file';

// "Protect Sensitive Data" is gone: a backup always carries what it takes to
// restore the player. Feature: 511812a18 ("remove "Protect Sensitive Data" --
// it protected far less than it claimed"). Before it, automatic and API
// backups were the protected kind, with emailpass blanked (and osPassword,
// MQTTPassword and the WiFi keys in clear anyway).
//
// Asking the API for a protected backup is refused with a 400, so a caller
// that asked for redaction is not handed every credential; the backup page's
// own form ignores a stale protectSensitive from a copy of the page loaded
// before the option went, and downloads the backup. Regression: 26102b0c1
// ("ignore a stale protectSensitive on the form, refuse it on the API"),
// before which the form refused and the API answered 200 with an error. Only a
// request that really asks for protection is refused: before 8ef364ce1
// ("refuse only a request that actually asks to be protected") the presence of
// protectSensitive:false, or of a stray 'protected' key, was refused too.
//
// The form test also backs up the "System Settings" area alone. Regression:
// e5ccf755a ("Fix 'System Settings' failing & generating HTTP 500", #2163):
// the email sub-area, which has no file of its own, was dropped only from an
// "All" backup, so a "settings" backup answered 500.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const made: string[] = [];
test.afterAll(async ({ request }) => {
  for (const f of made) await request.delete(`/api/backups/configuration/JsonBackups/${f}`);
});

async function makeBackup(request: import('@playwright/test').APIRequestContext, data: object | string) {
  const r = await request.post('/api/backups/configuration', { data });
  const body = await r.text();
  let reply: any = {};
  try { reply = JSON.parse(body); } catch { /* reported below */ }
  if (reply.backup_file_path) made.push(String(reply.backup_file_path).split('/').pop()!);
  return { status: r.status(), reply, body };
}

test('an API backup is complete, and says it is not protected', async ({ request }) => {
  const restore = snapshotSettings();
  try {
    setSettingInFile('emailpass', 'fpp-tests-mail-pw');
    setSettingInFile('MQTTPassword', 'fpp-tests-mqtt-pw');
    const { reply, body } = await makeBackup(request, 'fpp-tests complete');
    expect(reply.success, body).toBe(true);
    const backup = JSON.parse(readFile(`${BACKUPS}/${made[made.length - 1]}`));
    expect(backup.protected).toBe(false);
    const s = backup.settings.system_settings[0];
    expect(s.emailpass, 'the backup blanked the email password').toBe('fpp-tests-mail-pw');
    expect(s.MQTTPassword).toBe('fpp-tests-mqtt-pw');
  } finally {
    restore();
  }
});

test('the API refuses only a request to be protected', async ({ request }) => {
  for (const data of [{ backup_comment: 'fpp-tests', protectSensitive: false }, { backup_comment: 'fpp-tests', protected: true }]) {
    const { status, reply, body } = await makeBackup(request, data);
    expect(status, JSON.stringify(data)).toBe(200);
    expect(reply.success, `${JSON.stringify(data)}: ${body}`).toBe(true);
  }
  const { status, reply } = await makeBackup(request, { backup_comment: 'fpp-tests', protectSensitive: true });
  expect(status, 'a request for a protected backup was not refused with a 400').toBe(400);
  expect(reply.success).toBe(false);
  expect(reply.backup_file_path).toBeUndefined();
});

test("the backup page's form downloads a backup even with a stale protectSensitive", async ({ request, page }) => {
  const r = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'settings', protectSensitive: '1' } });
  expect(r.status()).toBe(200);
  expect(r.headers()['content-disposition'], 'no backup was downloaded').toMatch(/attachment; filename="FPP_settings-backup_/);
  const backup = JSON.parse(await r.text());
  expect(backup.protected).toBe(false);
  expect(backup.settings.system_settings[0]).toHaveProperty('statsPublish');

  // And the page no longer offers the option.
  await page.goto('/backup.php');
  await expect(page.locator('#btnDownloadConfig, [name="btnDownloadConfig"]').first()).toBeAttached();
  await expect(page.locator('[name="protectSensitive"]')).toHaveCount(0);
});
