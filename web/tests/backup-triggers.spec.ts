import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA } from './settings-file';

// The automatic JSON settings backup: a change made through the API takes a
// backup of its own, commented with what changed, which then shows in the
// backups list.  Feature: 16ba48687 ("Enhancement - Automatic JSON Settings
// Backup"), which wired GenerateBackupViaAPI() into the playlist, DNS,
// schedule, proxies, script and config-file handlers (a setting change is
// backup-listing.spec.ts).  Before it a change was only ever in the live
// config, with nothing to restore it from.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function backupsWith(request: APIRequestContext, text: string) {
  const r = await request.get('/api/backups/configuration/list');
  const rows = JSON.parse(await r.text()) as Array<Record<string, any>>;
  return rows.filter((b) => String(b.backup_comment).includes(text));
}

async function dropBackups(request: APIRequestContext, text: string) {
  for (const b of await backupsWith(request, text)) {
    await request.delete(`/api/backups/configuration/JsonBackups/${b.backup_filename}`);
  }
}

test('saving and deleting a playlist each take a backup that says so', async ({ request }) => {
  const name = `fpp-tests-backup-${Date.now()}`;
  try {
    const made = await request.post(`/api/playlist/${name}`, { data: { name, desc: 'fpp-tests backup trigger', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [] } });
    expect(made.ok(), await made.text()).toBe(true);
    expect(await backupsWith(request, `Playlist ${name} was updated.`), 'no backup for the saved playlist').toHaveLength(1);

    const gone = await request.delete(`/api/playlist/${name}`);
    expect(gone.ok(), await gone.text()).toBe(true);
    expect(await backupsWith(request, `Playlist ${name} was deleted.`), 'no backup for the deleted playlist').toHaveLength(1);
  } finally {
    await request.delete(`/api/playlist/${name}`);
    await dropBackups(request, name);
  }
});

test('saving the DNS servers takes a backup that says so', async ({ request }) => {
  const dns = `${MEDIA}/config/dns`;
  const before = (await request.get('/api/network/dns')).ok() ? inPlayer('sh', '-c', `cat ${dns} 2>/dev/null || true`) : '';
  const had = new Set((await backupsWith(request, 'DNS Configuration was modified.')).map((b) => b.backup_filename));
  try {
    const r = await request.post('/api/network/dns', { data: { DNS1: '192.0.2.53', DNS2: '' } });
    expect(await r.json()).toMatchObject({ status: 'OK' });
    expect(await backupsWith(request, 'DNS Configuration was modified.'), 'no backup for the DNS change').toHaveLength(had.size + 1);
  } finally {
    inPlayer('sh', '-c', before ? `printf '%s' '${before}' > ${dns}` : `rm -f ${dns}`);
    for (const b of await backupsWith(request, 'DNS Configuration was modified.')) {
      if (!had.has(b.backup_filename)) await request.delete(`/api/backups/configuration/JsonBackups/${b.backup_filename}`);
    }
  }
});
