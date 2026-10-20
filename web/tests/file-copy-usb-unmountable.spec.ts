import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { exists } from './settings-file';

// A File Copy to a USB device that does not mount stops there. Regression:
// 79a6c5b8e ("correct FAT handling order, symlink preservation, and mount
// validation for File Copy backups", #2912). copy_settings_to_storage.sh
// mounted with nofail and never checked, so a device that did not mount had
// the copy written into the bare /tmp/smnt mountpoint -- on tmpfs, until it
// filled. (The remote-drive case is file-copy-unmountable.spec.ts.)

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test("a copy to a USB device that can't be mounted copies nothing", async ({ request }) => {
  inPlayer('rm', '-rf', '/tmp/smnt');
  try {
    const r = await request.get('/copystorage.php?wrapped=1&direction=TOUSB&storageLocation=sdz9' +
      '&path=fpp-tests-usb&flags=Configuration&remoteStorage=none', { timeout: 120_000 });
    const out = await r.text();
    // The control: the script was run for that device.
    expect(out).toContain('copy_settings_to_storage.sh');
    expect(out, 'the copy did not notice the mount failed').toContain('Failed to mount /dev/sdz9');
    expect(out).not.toContain('Copying Configuration');
    expect(exists('/tmp/smnt/fpp-tests-usb'), 'the copy went into the bare mountpoint').toBe(false);
  } finally {
    inPlayer('rm', '-rf', '/tmp/smnt');
  }
});
