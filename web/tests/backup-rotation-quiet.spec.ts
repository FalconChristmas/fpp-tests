import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA } from './settings-file';

// Regression: 65813fa6a ("change backup rotation messages to only show in
// verbose logging rather than as a php error"). Every settings backup prunes
// the old ones, and while fewer than the 60 it keeps exist (which is most
// players, most of the time) it wrote "SETTINGS BACKUP: NOT removing JSON
// Settings backup files ..." to the PHP error log: a line in Apache's error
// log for every setting saved. It is now written only with the backup code's
// verbose logging on.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const LOG = `${MEDIA}/logs/apache2-error.log`;
const LISTED = '/tmp/fpp-tests-backup-rotation-quiet.backups';

test.beforeEach(() => inPlayer('sh', '-c', `mkdir -p ${BACKUPS} && ls ${BACKUPS} > ${LISTED}`));
test.afterEach(() => inPlayer('sh', '-c', `cd ${BACKUPS} && ls | grep -vxF -f ${LISTED} | xargs -r rm -f; rm -f ${LISTED}`));

const notRemoving = () => Number(inPlayer('sh', '-c', `grep -c 'NOT removing JSON Settings backup' ${LOG} 2>/dev/null || true`).trim() || 0);

test('a settings backup with fewer backups than the limit logs no rotation message', async ({ request }) => {
  const kept = (await (await request.get('/api/backups/configuration/list')).json()).length;
  expect(kept, 'the player already has the 60 backups the rotation keeps').toBeLessThan(59);
  const before = notRemoving();

  const r = await request.post('/api/backups/configuration', { data: { backup_comment: 'fpp-tests rotation' } });
  const made = await r.json();
  expect(made.success, JSON.stringify(made)).toBe(true);
  // The control: the backup was written, so its rotation ran.
  expect(inPlayer('sh', '-c', `ls ${BACKUPS} | grep -vxF -f ${LISTED} | wc -l`).trim()).not.toBe('0');

  await new Promise((res) => setTimeout(res, 500));
  expect(notRemoving() - before, inPlayer('sh', '-c', `tail -3 ${LOG} 2>/dev/null || true`)).toBe(0);
});
