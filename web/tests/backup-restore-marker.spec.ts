import { test, expect } from '@playwright/test';
import { container, inPlayer } from './container';

// A JSON backup restore asks the next boot to install the restored packages
// and run the config migrations. It did that by touching /fppos_upgraded,
// which also says the OS was replaced: that boot then cleared the sticky
// unknown-plugin record and held every native plugin back until the user
// reinstalled them all. Fixed in fpp fe1c85217 ("fix(restore): a restore no
// longer looks like an OS reflash"), which touches /fpp_restored instead.

function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e ${path} && echo yes || echo no`).trim() === 'yes';
}

test('A backup restore marks a restore, not an OS reflash', async ({ request }) => {
  test.skip(!container, 'needs the player container that run-web.sh serves');
  inPlayer('rm', '-f', '/fpp_restored', '/fppos_upgraded');
  try {
    const made = await (await request.post('/api/backups/configuration', { data: 'fpp-tests restore marker' })).json();
    expect(made.success, JSON.stringify(made)).toBe(true);
    const file = String(made.backup_file_path).split('/').pop();
    const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${file}`, { data: 'settings' });
    expect(r.status()).toBe(200);
    expect((await r.json()).Success, 'the restore did not run').toBe(true);
    expect(exists('/fppos_upgraded'), 'a restore marked the OS as reflashed').toBe(false);
    expect(exists('/fpp_restored'), 'the restore left no marker for the next boot').toBe(true);
  } finally {
    inPlayer('rm', '-f', '/fpp_restored', '/fppos_upgraded');
    await request.put('/api/settings/rebootFlag', { data: '0' });
  }
});
