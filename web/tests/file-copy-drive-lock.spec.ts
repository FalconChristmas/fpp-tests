import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';

// A remote backup's mount request waits while another request is working with
// the same drive.  Issue #3107: listing sda1's folders mounts it on
// /mnt/tmp_sda1, and DriveMountHelper's lock was per mountpoint, so a mount of
// sda1 on /mnt/remote_filecopy ran alongside it, found sda1 "already mounted"
// and the backup failed.  Fixed in fpp af4b96537 ("fix(drive-mount): improve
// locking mechanism to prevent mount conflicts during backup operations"):
// the device is locked as well.  7b3aa5bd1 limits the wait to 30 s and keeps
// the lock when the lock file belongs to another user.
//
// The "listing" is a PHP process inside the player holding sdz9's device lock;
// the player has no sdz9, so once the mount request gets the lock it fails
// straight away.  What is checked is that it waited.

test.skip(!container, 'holds a lock inside the run-web.sh container');

const HOLD_SECONDS = 8;
const HOLDER = `
$fp = fopen('/tmp/fpp_backup_mount_dev_sdz9.lock', 'c');
flock($fp, LOCK_EX);
touch('/tmp/fpp-tests-drive-lock-held');
sleep(${HOLD_SECONDS});
`;

test('mounting a drive waits for a request already using it', async ({ request }) => {
  inPlayer('rm', '-f', '/tmp/fpp-tests-drive-lock-held');
  docker('exec', '-d', container, 'php', '-r', HOLDER);
  try {
    await expect.poll(() => inPlayer('sh', '-c', 'test -e /tmp/fpp-tests-drive-lock-held && echo yes || echo no').trim(),
      { timeout: 10_000 }).toBe('yes');
    const started = Date.now();
    const r = await request.post('/api/backups/devices/mount/sdz9/remote_filecopy', { timeout: 60_000 });
    const waited = (Date.now() - started) / 1000;
    // The control: the request was answered (with a mount failure: no sdz9).
    expect(r.status(), await r.text()).toBe(200);
    expect(waited, 'the mount did not wait for the drive lock').toBeGreaterThan(HOLD_SECONDS - 3);
  } finally {
    inPlayer('sh', '-c', 'pkill -f "[f]pp_backup_mount_dev_sdz9" || true; rm -f /tmp/fpp-tests-drive-lock-held');
  }
});
