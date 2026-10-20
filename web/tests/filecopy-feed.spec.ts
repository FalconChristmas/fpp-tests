import { test, expect } from './fixtures';

// Every File Copy run wrote its progress to the same fpp_backup_filecopy.log
// and deleted it on finishing, so an overlapping run (the automatic JSON
// backup to USB, say) could cut off or mix into a dialog's output.  Fixed in
// fpp ef4ed763a ("fix(backups): each File Copy run gets its own progress
// feed"): each run uses fpp_backup_filecopy_<id>.log, the id given by the
// dialog that polls it.
//
// The copy itself goes nowhere (no storage device); what is checked is the
// feed the run names in fppd.log.

test('a File Copy run writes its progress to its own feed', async ({ request }) => {
  const r = await request.get('/copystorage.php?wrapped=1&feed=fppTestsFeed&direction=TOUSB&storageLocation=none&flags=JsonBackups',
    { timeout: 60_000 });
  expect(r.ok()).toBe(true);
  const log = await (await request.get('/api/file/Logs/fppd.log')).text();
  const starts = log.split('\n').filter((l) => l.includes('backup START:'));
  // The control: the run logged its start.
  expect(starts.length).toBeGreaterThan(0);
  expect(starts[starts.length - 1]).toContain('detail: logs/fpp_backup_filecopy_fppTestsFeed.log');
});
