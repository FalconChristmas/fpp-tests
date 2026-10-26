import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';
import { mountCalls, removeStandIns, standInMounts } from './fake-mounts';

// Regression: 71fb50c04 ("'none' USB guard, short-tag fix, and remote storage
// dropdown reset", from #2783).  "none" is what the Backup page stores in
// jsonConfigBackupUSBLocation when no USB drive is chosen for the JSON
// backups.  Listing, downloading, deleting or restoring those backups took
// any non-empty value for a drive and asked DriveMountHelper() to mount a
// device named "none".  Today DriveMountHelper() refuses that name, and its
// refusal (a JSON string, not a list) then broke the listing with a
// TypeError.  The drives are fake-mounts.ts's mount table, which logs every
// mount and umount.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const BACKUPS = '/home/fpp/media/config/backups';
const NAME = 'fpp-tests-usb-none_2026-10-01_00-00-00.json';

test.afterEach(() => {
  removeStandIns();
  inPlayer('rm', '-f', `${BACKUPS}/${NAME}`);
});

test("with no backup drive chosen ('none'), the JSON backups list, download and delete without mounting anything", async ({ request }) => {
  await keepingSettings(async () => {
    standInMounts([]);
    setSettingInFile('jsonConfigBackupUSBLocation', 'none');
    inPlayer('sh', '-c', `mkdir -p ${BACKUPS} && echo '{"fpp_backup_version":"8.0","backup_comment":"fpp-tests"}' > ${BACKUPS}/${NAME}`);

    const list = await request.get('/api/backups/configuration/list');
    expect(list.status(), await list.text()).toBe(200);
    const names = JSON.stringify(await list.json());
    // The control: the local backup is listed.
    expect(names).toContain('fpp-tests-usb-none');

    const dl = await request.get(`/api/backups/configuration/JsonBackupsAlternate/${NAME}`);
    expect(dl.status()).toBeLessThan(500);
    const del = await request.delete(`/api/backups/configuration/JsonBackupsAlternate/${NAME}`);
    expect(del.status()).toBeLessThan(500);

    expect(mountCalls(), "a drive named 'none' was mounted").toEqual([]);
  });
});
