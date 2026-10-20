import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// "Protect sensitive data" is gone: a backup always carries the passwords it
// takes to restore the player.  What still asks for protection:
//
// - The Backup page's form: only a copy of the page loaded before the option
//   went still sends protectSensitive, and its user pressed Download wanting a
//   backup.  It was refused with an error and no backup.  The API, where a
//   caller really did ask for protection, answered that refusal with HTTP 200.
//   Fixed in fpp 26102b0c1 ("fix(backups): ignore a stale protectSensitive on
//   the form, refuse it on the API"): the form ignores it, the API answers 400.
// - The API refused any body with a protectSensitive or protected key, even
//   protectSensitive:false, which asks for what every backup is.  Fixed in fpp
//   8ef364ce1 ("fix(backups): refuse only a request that actually asks to be
//   protected").

const BACKUPS = '/home/fpp/media/config/backups';
const LISTED = '/tmp/fpp-tests-protect-sensitive.backups';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// Every one of these takes a backup into config/backups; drop the new ones.
const backups = () => inPlayer('sh', '-c', `ls ${BACKUPS}`).split('\n').filter(Boolean);
test.beforeEach(() => inPlayer('sh', '-c', `mkdir -p ${BACKUPS} && ls ${BACKUPS} > ${LISTED}`));
test.afterEach(() => inPlayer('sh', '-c', `cd ${BACKUPS} && ls | grep -vxF -f ${LISTED} | xargs -r rm -f; rm -f ${LISTED}`));

async function makeBackup(request: APIRequestContext, body: object) {
  const r = await request.post('/api/backups/configuration', { data: body });
  return { status: r.status(), json: await r.json() };
}

test('the Backup page ignores a stale protectSensitive and downloads the backup', async ({ request }) => {
  const r = await request.post('/backup.php', {
    form: { btnDownloadConfig: '1', backuparea: 'settings', protectSensitive: 'on' },
  });
  expect(r.ok()).toBe(true);
  const text = await r.text();
  let backup: any;
  expect(() => { backup = JSON.parse(text); }, `no backup came back: ${text.slice(0, 300)}`).not.toThrow();
  expect(backup.settings.system_settings[0].HostName).toBeDefined();
  expect(backup.protected).toBe(false);
});

test('the API refuses a request to be protected with a 400', async ({ request }) => {
  const before = backups();
  const { status, json } = await makeBackup(request, { backup_comment: 'fpp-tests protected', protectSensitive: true });
  expect(json.success).toBe(false);
  expect(String(json.error)).toContain('no longer supported');
  expect(status, 'the refusal was answered as a success').toBe(400);
  expect(backups()).toEqual(before);
});

test('the API takes a backup for a request that does not ask to be protected', async ({ request }) => {
  for (const body of [{ protectSensitive: false }, { protected: true }]) {
    const before = backups().length;
    const { status, json } = await makeBackup(request, { backup_comment: 'fpp-tests not protected', ...body });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(json.success, `${JSON.stringify(body)}: ${JSON.stringify(json)}`).toBe(true);
    expect(backups().length).toBe(before + 1);
  }
});
