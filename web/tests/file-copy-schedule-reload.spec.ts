import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, putFile, snapshotSettings } from './settings-file';

// A File Copy restore of Configuration (or All) copies the files as they are,
// the schedule among them, and fppd keeps the schedule it loaded at start.
// copystorage.php tells fppd to reload it once the copy has run.
//
// The image has no rsync.  The stand-in below logs how it was called and, for
// Configuration's rsync only (the one with --exclude=music/*), copies the
// backup's config/schedule.json into place, which is the part of that copy this
// test is about.  The device scenario test_file_copy_remote.py runs the real
// rsync.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-rsync-schedule-stub';
const RSYNC = '/usr/local/bin/rsync';
const LOG = '/tmp/fpp-tests-rsync-schedule.log';
const FOLDER = 'fpp-tests-filecopy-schedule';
const SOURCE = `${MEDIA}/backups/${FOLDER}`;
const ENTRY = 'fpp-tests-filecopy-raw-entry';

const STUB = `#!/bin/sh
# ${MARK}
echo "rsync $*" >> ${LOG}
src=; dst=
for a in "$@"; do src=$dst; dst=$a; done
case " $* " in
  *" --exclude=music/* "*)
    [ -f "\${src}config/schedule.json" ] && cp "\${src}config/schedule.json" "\${dst%/}/config/schedule.json" ;;
esac
exit 0
`;

// A restore marks the player for a reboot and a boot-time apply; put that back.
const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; /^pluginReinstallNeededAfterOS\\s*=/d; ` +
  `s/^rebootFlag\\s*=.*/rebootFlag = "0"/' ${MEDIA}/settings`;

test.beforeEach(() => {
  const real = inPlayer('sh', '-c', `test -e ${RSYNC} && ! grep -q ${MARK} ${RSYNC} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${RSYNC} is a real program in the player; not replacing it`);
  putFile(RSYNC, STUB);
  inPlayer('sh', '-c', `chmod 755 ${RSYNC} && : > ${LOG} && chmod 666 ${LOG} && rm -rf ${SOURCE} && mkdir -p ${SOURCE}/config`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `grep -q ${MARK} ${RSYNC} 2>/dev/null && rm -f ${RSYNC}; rm -rf ${LOG} ${SOURCE}; ${CLEAR}; true`);
});

const fppdEntries = async (request: APIRequestContext) =>
  ((await (await request.get('/api/fppd/schedule')).json()).schedule?.entries ?? [])
    .map((e: { playlist: string }) => e.playlist);

for (const flags of ['Configuration', 'All']) {
  test(`a File Copy restore of ${flags} has fppd run the restored schedule straight away`, async ({ request }) => {
    // Regression: #3157.  fppd kept the schedule it had loaded, so after a
    // File Copy restore it ran the old one until the reboot the restore asks
    // for.  Fixed by 15c83d41c.
    const restoreSettings = snapshotSettings();
    const before = await (await request.get('/api/schedule')).json();
    try {
      // The backup: this player's schedule with one more (disabled) entry.
      // fppd reloads lazily (on its scheduler's next pass), so each reload
      // below is waited for until fppd shows it: a reload still pending when
      // the copy lands would read the restored file without any help.
      expect((await request.post('/api/schedule', {
        data: [...before, { enabled: 0, day: 7, playlist: ENTRY, startTime: '10:00:00', endTime: '11:00:00',
          startDate: '2099-01-01', endDate: '2099-01-02', repeat: 0, stopType: 0 }],
      })).ok()).toBe(true);
      inPlayer('sh', '-c', `cp ${MEDIA}/config/schedule.json ${SOURCE}/config/schedule.json`);
      expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
      await expect.poll(() => fppdEntries(request), { message: 'the control: fppd shows the entry once reloaded', timeout: 10_000 })
        .toContain(ENTRY);
      expect((await request.post('/api/schedule', { data: before })).ok()).toBe(true);
      expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
      await expect.poll(() => fppdEntries(request), { message: 'the control: fppd runs the schedule without the entry', timeout: 10_000 })
        .not.toContain(ENTRY);

      const r = await request.get(`/copystorage.php?wrapped=1&direction=FROMLOCAL&path=${FOLDER}&flags=${flags}` +
        '&storageLocation=none&remoteStorage=none&delete=no&compress=no', { timeout: 120_000 });
      const out = await r.text();
      expect(r.ok(), out.slice(-1500)).toBe(true);
      expect(out, out.slice(-1500)).toContain('BACKUP COMPLETE');
      // The control: the copy put the backup's schedule in place.
      expect(inPlayer('cat', `${MEDIA}/config/schedule.json`), 'the stand-in did not copy the schedule').toContain(ENTRY);

      await expect.poll(() => fppdEntries(request), { message: 'the schedule fppd runs after the restore', timeout: 10_000 })
        .toContain(ENTRY);
    } finally {
      await request.post('/api/schedule', { data: before });
      await request.post('/api/schedule/reload');
      restoreSettings();
    }
  });
}
