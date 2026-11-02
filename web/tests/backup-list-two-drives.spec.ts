import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container } from './container';
import { mountCalls, removeStandIns, standInMounts } from './fake-mounts';

// Listing the folders of two USB drives at once.  The File Copy dialog asks
// api/backups/list/sda1 and api/backups/list/sdb1 together; each mounts its
// drive, reads it and unmounts it.  The drives are fake-mounts.ts's stand-ins
// (the player has no block devices), but here mount puts a folder named for
// the drive into the mount point it is given and umount empties the mount
// point, as a real one would leave it, so a listing that read the wrong
// drive's mount point shows.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test.afterEach(() => removeStandIns());

const MARK = 'fpp-tests-mount-stub';
const SLOW_MOUNT = `#!/bin/sh
# ${MARK}
echo "mount $*" >> /tmp/fpp-tests-mount-calls.log
dev=; mp=; for a in "$@"; do dev=$mp; mp=$a; done
mkdir -p "$mp/Folder_\${dev##*/}"
sleep 3
exit 0
`;
const EMPTYING_UMOUNT = `#!/bin/sh
# ${MARK}
echo "umount $*" >> /tmp/fpp-tests-mount-calls.log
mp=; for a in "$@"; do mp=$a; done
case "$mp" in /mnt/*) rm -rf "$mp"/* ;; esac
exit 0
`;

function putStub(name: string, body: string) {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > /usr/local/bin/${name} && chmod 755 /usr/local/bin/${name}`], { input: body });
}

test('two drives listed at once each show their own folders, and are mounted side by side', async ({ request }) => {
  // Regression: 307b13fc5 (#2903).  Every listing mounted its drive on the one
  // /mnt/tmp, so with two drives the second request's umount pulled the first
  // drive out from under its scan and it listed as "/" alone.  Each drive has
  // its own mount point now (/mnt/tmp_<device>), with a lock per mount point
  // and per device, so two drives are read together.
  standInMounts([]);
  putStub('mount', SLOW_MOUNT);
  putStub('umount', EMPTYING_UMOUNT);

  const [a, b] = await Promise.all([request.get('/api/backups/list/sdz1'), request.get('/api/backups/list/sdz2')]);
  expect(a.status(), await a.text()).toBe(200);
  expect(b.status(), await b.text()).toBe(200);
  expect(await a.json()).toEqual(['/', 'Folder_sdz1']);
  expect(await b.json()).toEqual(['/', 'Folder_sdz2']);

  const calls = mountCalls();
  const mounted = calls.filter((c) => c.startsWith('mount '));
  // The receiving end saw two mounts, each on a mount point of its drive's own.
  expect(mounted.map((c) => c.split(' ').slice(-2).join(' ')).sort()).toEqual(['/dev/sdz1 /mnt/tmp_sdz1', '/dev/sdz2 /mnt/tmp_sdz2']);

  // Side by side: the second mount came before the first drive was let go.
  const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
  const firstUnmount = at(/^umount -l .*\/mnt\/tmp_sdz[12]$/);
  expect(firstUnmount, calls.join('\n')).toBeGreaterThan(-1);
  const mountsBeforeFirstUnmount = calls.slice(0, firstUnmount).filter((c) => c.startsWith('mount ')).length;
  expect(mountsBeforeFirstUnmount, `the second drive waited for the first:\n${calls.join('\n')}`).toBe(2);
});
