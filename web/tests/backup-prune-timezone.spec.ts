import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// Backups are named with local wall-clock time, in the zone the TimeZone
// setting names at the moment each is written, and only the 60 newest are
// kept.  Regression: a4e938b4b ("order and prune backups by when they were
// taken, not by their names").  The listing dated backups by that name, so
// after TimeZone moved west (London -> Chicago) every new backup's name was
// hours "older" than the ones before, and with 60 of those on the player
// each new backup was deleted as soon as it was written:
// POST /api/backups/configuration answered success with a path that no
// longer existed, and a download from backup.php came back empty.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const BACKUPS = '/home/fpp/media/config/backups';

test('a backup made after the time zone moves west is kept', async ({ request }) => {
  test.setTimeout(300_000);
  const list = () => inPlayer('sh', '-c', `ls ${BACKUPS} 2>/dev/null || true`).split('\n').filter((n) => n.endsWith('.json'));
  const before = new Set(list());
  await keepingSettings(async () => {
    try {
      setSettingInFile('TimeZone', 'Europe/London');
      for (let i = list().length; i <= 60; i++) {
        expect((await request.post('/api/backups/configuration', { data: `fpp-tests fill ${i}` })).ok()).toBe(true);
      }
      // The move comes a moment later, as it would on a player: backups taken
      // in the same second are ordered by name, which cannot tell zones apart.
      await new Promise((r) => setTimeout(r, 2000));
      setSettingInFile('TimeZone', 'America/Chicago');
      const made = await (await request.post('/api/backups/configuration', { data: 'fpp-tests after the move' })).json();
      expect(made.success).toBe(true);
      const name = String(made.backup_file_path).split('/').pop()!;
      expect(list(), `${name} was pruned as it was made`).toContain(name);
      const listed = await (await request.get('/api/backups/configuration/list')).json();
      expect(listed[0].backup_filename, 'the newest backup is not listed first').toBe(name);
      const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'settings' } });
      expect((await dl.body()).length, 'the download came back empty').toBeGreaterThan(0);
    } finally {
      for (const n of list()) if (!before.has(n)) inPlayer('rm', '-f', `${BACKUPS}/${n}`);
    }
  });
});
