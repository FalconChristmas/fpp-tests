import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// A settings backup kept only plugin config files whose sniffed MIME type had
// "text" in it, so a plugin's JSON or XML config (application/json, ...) was
// silently left out of every backup.  Fixed in fpp 088ac2e42 ("backup:
// include JSON/XML plugin config files in settings backup").

const CONFIG = '/home/fpp/media/config';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function takeBackup(request: APIRequestContext, comment: string): Promise<string> {
  // A fresh player has no backups directory until its first backup.
  inPlayer('mkdir', '-p', `${CONFIG}/backups`);
  const made = await (await request.post('/api/backups/configuration', { data: comment })).json();
  expect(made.success, JSON.stringify(made)).toBe(true);
  const name = made.backup_file_path.split('/').pop();
  try {
    const r = await request.get(`/api/backups/configuration/JsonBackups/${name}`);
    expect(r.ok()).toBe(true);
    return await r.text();
  } finally {
    await request.delete(`/api/backups/configuration/JsonBackups/${name}`);
  }
}

test('a settings backup carries a plugin JSON config', async ({ request }) => {
  inPlayer('sh', '-c', `printf '{"fppTests": 1}\\n' > ${CONFIG}/plugin.fpp-tests.json`);
  try {
    const backup = JSON.parse(await takeBackup(request, 'fpp-tests-plugin-json'));
    expect(JSON.stringify(backup.plugins ?? null)).toContain('"plugin.fpp-tests.json"');
  } finally {
    inPlayer('rm', '-f', `${CONFIG}/plugin.fpp-tests.json`);
  }
});
