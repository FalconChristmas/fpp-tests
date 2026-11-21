import { execFileSync } from 'child_process';
import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Storage tab's "Storage Device" select (PrintStorageDeviceSelect() in
// settings-storage.php): which partitions it lists, in what order, which is
// labelled the boot device and the current storage device, and which is
// selected.  The player has no disks, so lsblk, findmnt and sfdisk are
// stand-ins in /usr/local/bin (as in storage-format-flash.spec.ts) and the
// partitions are empty files named in /dev, which is all the page lists from.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-storage-select-stub';
const NODES = ['mmcblk9p1', 'mmcblk9p2', 'sdz1'];

function writeIn(path: string, content: string, mode = '755') {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > '${path}' && chmod ${mode} '${path}'`], { input: content });
}

// A Pi booted from an SD card: boot partition mmcblk9p1 mounted on the boot
// directory, root on mmcblk9p2, and a USB partition sdz1; `media` is the
// partition the media directory is on, as `findmnt -T` reports it.
function standIn(media: string) {
  const stub = (tool: string, body: string) =>
    writeIn(`/usr/local/bin/${tool}`, `#!/bin/sh\n# ${MARK}\n${body}\n`);
  stub('lsblk', `case "$*" in
  -l) printf '%s\\n' 'NAME MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS' 'mmcblk9p1 179:1 0 256M 0 part /boot/firmware' 'mmcblk9p2 179:2 0 29G 0 part /' 'sdz1 8:1 1 29G 0 part'; exit 0 ;;
esac
exec /usr/bin/lsblk "$@"`);
  stub('findmnt', `case "$*" in
  "-no source -T "*) echo /dev/${media}; exit 0 ;;
  "-n -o SOURCE /") echo /dev/mmcblk9p2; exit 0 ;;
esac
exec /usr/bin/findmnt "$@"`);
  stub('sfdisk', 'case "$1" in -s) echo 31457280; exit 0 ;; esac\nexit 0');
  inPlayer('sh', '-c', `touch ${NODES.map((n) => '/dev/' + n).join(' ')}`);
}

test.afterEach(() => {
  inPlayer('sh', '-c', `for f in /usr/local/bin/*; do grep -q ${MARK} "$f" 2>/dev/null && rm -f "$f"; done; rm -f ${NODES.map((n) => '/dev/' + n).join(' ')}; true`);
});

// The player is a container, which is why the tab prints no select: with
// the container marker moved aside and a platform claimed (as
// settings-storage-no-root.spec.ts does) it prints it.
const PLATFORM = '/etc/fpp/platform';
const CONTAINER = '/etc/fpp/container';
const ASIDE = '/etc/fpp/container.fpp-tests-aside';

// [device, label, selected] for each option, in page order.
async function options(request: any): Promise<Array<[string, string, boolean]>> {
  const wrotePlatform = inPlayer('sh', '-c', `test -e ${PLATFORM} && echo y || echo n`).trim() === 'n';
  if (wrotePlatform) inPlayer('sh', '-c', `uname -s > ${PLATFORM}`);
  inPlayer('mv', CONTAINER, ASIDE);
  let html: string;
  try {
    html = await (await request.get('/settings-storage.php')).text();
  } finally {
    inPlayer('mv', ASIDE, CONTAINER);
    if (wrotePlatform) inPlayer('rm', '-f', PLATFORM);
  }
  const sel = html.match(/<select[^>]*id=['"]storageDevice['"][\s\S]*?<\/select>/i);
  expect(sel, 'the Storage Device select').toBeTruthy();
  return [...sel![0].matchAll(/<option([^>]*)value=['"]([^'"]*)['"]([^>]*)>([^<]*)<\/option>/g)]
    .map((m) => [m[2], m[4].replace(/\s+/g, ' ').trim(), /selected/.test(m[1] + m[3])]);
}

test('the select labels the media directory\'s partition, found by its mount, and selects it', async ({ request }) => {
  // Regressions: 3848350a8 and 3f06c0216.  The current storage device was
  // read from /etc/fstab, which does not say where the media directory is
  // mounted; findmnt -T does.
  standIn('sdz1');
  const opts = await options(request);
  const byDev = Object.fromEntries(opts.map(([d, l, s]) => [d, { l, s }]));
  expect(Object.keys(byDev).sort()).toEqual([...NODES].sort());
  expect(byDev.sdz1.l).toContain('(current storage device)');
  expect(byDev.sdz1.s, 'the media partition is selected').toBe(true);
  expect(opts.filter(([, l]) => l.includes('(current storage device)')).length).toBe(1);
});

test('only the boot partition is labelled the boot device, not every partition of its disk', async ({ request }) => {
  // Regression: 9de61d272.  The boot device was the disk's name with its
  // partition number stripped, which every partition of the SD card matched.
  standIn('mmcblk9p2');
  const opts = await options(request);
  const boot = opts.filter(([, l]) => l.includes('(boot device)')).map(([d]) => d);
  expect(boot).toEqual(['mmcblk9p1']);
});

test('the list is in the disks\' order when the media partition is listed, reversed when not', async ({ request }) => {
  // Regression: 1975e2468.  Whatever the order of /dev, a media directory
  // on a partition the list does not hold put the offered ones last first.
  standIn('sdz1');
  const listed = (await options(request)).map(([d]) => d);
  expect(listed).toEqual([...NODES].sort());
  // Since 13e98c1c4 that media partition gets an entry of its own, after the
  // reversed ones, and is selected: the page never opens on a device it is
  // not on, which would rewrite /etc/fstab on its load-time save.
  standIn('elsewhere9');
  const opts = await options(request);
  expect(opts.map(([d]) => d)).toEqual([...NODES].sort().reverse().concat('elsewhere9'));
  expect(opts.filter(([, , s]) => s).map(([d]) => d), 'the selected entry').toEqual(['elsewhere9']);
});

test('a partition name with shell syntax in it is passed to the disk tools as one argument', async ({ request }) => {
  // Regression: c3e457b02.  The names read from /dev went into sfdisk and df
  // command lines unquoted, so a node named "sdz2;<command>" ran the command.
  // This one would leave a file in /tmp (no '/' can be in a name).
  const injected = '/tmp/fpp-tests-storage-injected';
  const node = 'sdz2;cd $(dirname $(mktemp -u));touch fpp-tests-storage-injected';
  inPlayer('rm', '-f', injected);
  standIn('sdz1');
  inPlayer('touch', `/dev/${node}`);
  try {
    await options(request);
  } finally {
    inPlayer('rm', '-f', `/dev/${node}`);
  }
  const left = inPlayer('sh', '-c', `test -e ${injected} && echo yes || echo no`).trim();
  inPlayer('rm', '-f', injected);
  expect(left, 'a command in a /dev name ran').toBe('no');
});
