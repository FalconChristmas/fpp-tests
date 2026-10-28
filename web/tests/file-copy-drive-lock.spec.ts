import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';
import { denying, preloadDeny, unpreloadDeny } from './fakedeny';

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
const holder = (seconds: number) => `
$fp = fopen('/tmp/fpp_backup_mount_dev_sdz9.lock', 'c');
flock($fp, LOCK_EX);
touch('/tmp/fpp-tests-drive-lock-held');
sleep(${seconds});
`;
const HOLDER = holder(HOLD_SECONDS);

// Starts a "listing" holding sdz9's device lock for `seconds`, and waits
// until it has it.
async function hold(seconds: number) {
  inPlayer('rm', '-f', '/tmp/fpp-tests-drive-lock-held');
  docker('exec', '-d', container, 'php', '-r', holder(seconds));
  await expect.poll(() => inPlayer('sh', '-c', 'test -e /tmp/fpp-tests-drive-lock-held && echo yes || echo no').trim(),
    { timeout: 10_000 }).toBe('yes');
}

function release() {
  inPlayer('sh', '-c', 'pkill -f "[f]pp_backup_mount_dev_sdz9" || true; rm -f /tmp/fpp-tests-drive-lock-held');
}

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

test('a mount gives up with "busy" when the drive stays in use past 30 s', async ({ request }) => {
  // Regression: 7b3aa5bd1.  The wait had no limit: a mount that got the lock
  // after the remote's 60 s curl had given up (and sent its unmount) left the
  // drive mounted for good.  Now it gives up after 30 s and says the drive is
  // busy.
  test.setTimeout(120_000);
  await hold(45);
  try {
    const started = Date.now();
    const r = await request.post('/api/backups/devices/mount/sdz9/remote_filecopy', { timeout: 90_000 });
    const waited = (Date.now() - started) / 1000;
    const body = await r.text();
    expect(r.status(), body).toBe(200);
    expect(body, 'the mount did not give up on the busy drive').toContain('busy');
    // The control: it did wait for the lock, and then not for the whole hold.
    expect(waited).toBeGreaterThan(25);
    expect(waited).toBeLessThan(40);
  } finally {
    release();
  }
});

test.describe('a lock file another user made', () => {
  test.beforeAll(() => preloadDeny());
  test.afterAll(() => unpreloadDeny());

  test('still locks the drive', async ({ request }) => {
    // Regression: 7b3aa5bd1.  A lock file made by another user (root, on a
    // player) can't be opened for writing by php-fpm, and locking was then
    // skipped without a word, so the mount ran alongside the listing.  It is
    // opened read-only now, which is enough for flock.  fakedeny refuses
    // php-fpm's write opens of the lock file here, as the file's owner would.
    await hold(HOLD_SECONDS);
    try {
      const waited = await denying({ write: ['/tmp/fpp_backup_mount_dev_sdz9.lock'] }, async () => {
        const started = Date.now();
        const r = await request.post('/api/backups/devices/mount/sdz9/remote_filecopy', { timeout: 60_000 });
        expect(r.status(), await r.text()).toBe(200);
        return (Date.now() - started) / 1000;
      });
      expect(waited, 'the mount did not wait for the drive lock').toBeGreaterThan(HOLD_SECONDS - 3);
    } finally {
      release();
    }
  });
});
