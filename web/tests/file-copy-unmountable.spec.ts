import { test, expect } from './fixtures';
import { container, inPlayer, playerAddress } from './container';

// A File Copy from another player's drive stops when that player can't mount
// the drive, and leaves no "restored" markers behind.  Fixed in fpp 2fefeddb2
// ("fix(backups): Make file Copy stop if the drive can't be mounted", #3107).
// Before it copy_settings_to_storage.sh ignored the mount reply and ran every
// rsync anyway, and copystorage.php then set rebootFlag, BootActions and
// /fpp_restored as if a configuration had been copied in.
//
// The "other player" is this one, at its own address, asked to mount a drive
// it doesn't have.

test.skip(!container, 'checks markers inside the run-web.sh container');

const SETTINGS = '/home/fpp/media/settings';
// Back to no markers: a restore elsewhere in the suite sets them legitimately.
const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; /^pluginReinstallNeededAfterOS\\s*=/d; s/^rebootFlag\\s*=.*/rebootFlag = "0"/' ${SETTINGS}`;

test("a copy from a remote drive that can't be mounted copies and marks nothing", async ({ request }) => {
  const ip = playerAddress().ip;
  inPlayer('sh', '-c', CLEAR);
  try {
    const r = await request.get(`/copystorage.php?direction=FROMREMOTE&storageLocation=${ip}` +
      '&remoteStorage=sdz9&path=fpp-tests&flags=Configuration', { timeout: 180_000 });
    const out = await r.text();
    // The control: the remote was asked, and refused.
    expect(out).toContain(`Remote Host: ${ip} reported`);
    expect(out).toContain('could not mount');
    const settings = inPlayer('cat', SETTINGS);
    expect(settings, 'BootActions was set').not.toMatch(/^BootActions\s*=/m);
    expect(settings, 'rebootFlag was set').not.toMatch(/^rebootFlag\s*=\s*"1"/m);
    expect(inPlayer('sh', '-c', 'test -e /fpp_restored && echo yes || echo no').trim(), '/fpp_restored was made').toBe('no');
  } finally {
    inPlayer('sh', '-c', CLEAR);
  }
});
