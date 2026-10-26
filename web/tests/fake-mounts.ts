import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';

// A fake mount table for the backup API's drive handling.  The player has no
// block devices and can't mount (no CAP_SYS_ADMIN, so not even nsenter into
// PID 1's namespace), so the tools the PHP asks are stand-ins in
// /usr/local/bin, which PHP's shell and sudo's secure_path find first: lsblk
// and findmnt report what the table says is mounted where, umount takes a
// table entry out, mount fails as the real one does here, and nsenter runs
// its command in place, as nsenter -m -t 1 does on a player.  umount and
// mount log each call.  Anything the table doesn't hold goes to the real
// tool.

const MARK = 'fpp-tests-mount-stub';
const TABLE = '/tmp/fpp-tests-mounts';
const LOG = '/tmp/fpp-tests-mount-calls.log';
const TOOLS = ['lsblk', 'findmnt', 'umount', 'mount', 'nsenter'];

const STUBS: Record<string, string> = {
  lsblk: `
dev=; for a in "$@"; do case "$a" in /dev/*) dev="$a" ;; esac; done
if [ -n "$dev" ] && grep -q "^$dev " ${TABLE} 2>/dev/null; then
  awk -v d="$dev" '$1 == d { print $2 }' ${TABLE}; exit 0
fi
exec /usr/bin/lsblk "$@"`,
  findmnt: `
mp=; dev=; prev=
for a in "$@"; do
  [ "$prev" = --mountpoint ] && mp="$a"
  case "$a" in /dev/*) dev="$a" ;; esac
  prev="$a"
done
if [ -n "$mp" ] && grep -q " $mp\\$" ${TABLE} 2>/dev/null; then
  awk -v m="$mp" '$2 == m { print $1 }' ${TABLE}; exit 0
fi
if [ -n "$dev" ] && grep -q "^$dev " ${TABLE} 2>/dev/null; then
  awk -v d="$dev" '$1 == d { print $2 }' ${TABLE}; exit 0
fi
exec /usr/bin/findmnt "$@"`,
  umount: `
for a in "$@"; do mp="$a"; done
echo "umount $*" >> ${LOG}
if grep -q " $mp\\$" ${TABLE} 2>/dev/null; then
  grep -v " $mp\\$" ${TABLE} > ${TABLE}.new; mv ${TABLE}.new ${TABLE}; exit 0
fi
exec /usr/bin/umount "$@"`,
  mount: `
echo "mount $*" >> ${LOG}
exec /usr/bin/mount "$@"`,
  nsenter: `
if [ "$1 $2 $3" = "-m -t 1" ]; then shift 3; exec "$@"; fi
exec /usr/bin/nsenter "$@"`,
};

function writeIn(path: string, content: string, mode = '755') {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > '${path}' && chmod ${mode} '${path}'`], { input: content });
}

// Mounts: "<source> <target>" lines, e.g. "/dev/sdz8 /media/somewhere".
export function standInMounts(mounts: string[]) {
  for (const tool of TOOLS) {
    const path = `/usr/local/bin/${tool}`;
    const real = inPlayer('sh', '-c', `test -e ${path} && ! grep -q ${MARK} ${path} && echo real || true`).trim();
    if (real === 'real') throw new Error(`${path} is a real program in the player; not replacing it`);
    writeIn(path, `#!/bin/sh\n# ${MARK}\n${STUBS[tool].trim()}\n`);
  }
  writeIn(TABLE, mounts.map((m) => `${m}\n`).join(''), '666');
  writeIn(LOG, '', '666');
}

export function removeStandIns() {
  inPlayer('sh', '-c', `for t in ${TOOLS.join(' ')}; do f=/usr/local/bin/$t; grep -q ${MARK} $f 2>/dev/null && rm -f $f; done; ` +
    `rm -f ${TABLE} ${LOG}; rmdir /mnt/fpp-tests-um 2>/dev/null; true`);
}

export function mounts(): string[] {
  return inPlayer('cat', TABLE).split('\n').filter((l) => l);
}

// The umount and mount calls made since standInMounts(), in order.
export function mountCalls(): string[] {
  return inPlayer('cat', LOG).split('\n').filter((l) => l);
}

export function umountCalls(): string[] {
  return mountCalls().filter((c) => c.startsWith('umount '));
}
