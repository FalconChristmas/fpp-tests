import { execFileSync } from 'child_process';
import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The Storage tab's destructive actions: formatting a partition
// (formatstorage.php, which runs scripts/format_storage.sh as root) and
// flashing FPP onto another disk (flash-storage.php, which runs
// SD/flash_storage.sh).  The player has no disks, so the tools they ask are
// stand-ins in /usr/local/bin, which both PHP's shell and sudo's secure_path
// find first: lsblk and findmnt describe a Pi booted from an SD card
// (mmcblk0) with a USB stick (sdz) and an NVMe drive (nvme9n1) attached, and
// fall through to the real tool for anything else; sfdisk, the mkfs tools and
// stdbuf (which flash-storage.php runs flash_storage.sh through) only log how
// they were called.  format_storage.sh itself is the tree's own.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-storage-stub';
const LOG = '/tmp/fpp-tests-storage-calls.log';
const PWNED = '/tmp/fpp-tests-format-pwned';
const LOGGERS = ['sfdisk', 'mkfs.fat', 'mkfs.ext4', 'mkfs.exfat', 'mkfs.btrfs', 'stdbuf'];

// [case pattern over "$*", output]; the first match answers.
type Answers = Array<[string, string]>;

const DISKS: Record<string, Answers> = {
  lsblk: [
    ['-dno NAME', 'mmcblk0\nsdz\nnvme9n1\nloop0'],
    ['-no PKNAME /dev/mmcblk0p*', 'mmcblk0'],
    ['-dno SIZE /dev/sdz', '29.8G'], ['-dno TRAN /dev/sdz', 'usb'], ['-dno MODEL /dev/sdz', 'fpp-tests-stick'],
    ['-dno SIZE /dev/nvme9n1', '238.5G'], ['-dno TRAN /dev/nvme9n1', 'nvme'], ['-dno MODEL /dev/nvme9n1', 'fpp-tests-nvme'],
    ['-dno SIZE /dev/mmcblk0', '29.7G'], ['-dno TRAN /dev/mmcblk0', ''], ['-dno MODEL /dev/mmcblk0', ''],
    ['-nro MOUNTPOINTS /dev/sdz*', ''], ['-nro MOUNTPOINTS /dev/nvme9n1*', ''],
  ],
  findmnt: [
    ['-no SOURCE /', '/dev/mmcblk0p2'],
    ['-no SOURCE -T *', '/dev/mmcblk0p2'],
    ['-n -o TARGET -- /dev/sdz*', ''], ['-n -o TARGET -- /dev/nvme9n1*', ''],
  ],
};

function writeIn(path: string, content: string, mode = '755') {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > '${path}' && chmod ${mode} '${path}'`], { input: content });
}

function install(tool: string, body: string) {
  const path = `/usr/local/bin/${tool}`;
  const real = inPlayer('sh', '-c', `test -e ${path} && ! grep -q ${MARK} ${path} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${path} is a real program in the player; not replacing it`);
  writeIn(path, `#!/bin/sh\n# ${MARK}\n${body}\n`);
}

// The disks above; `mounted` puts sdz5 on the media directory.  `media`
// instead says which partition holds the media directory as findmnt -T sees
// it (the Storage tab's "current storage device"), e.g. 'sdz2'.
function standInDisks(mounted = false, media = '') {
  for (const [tool, base] of Object.entries(DISKS)) {
    const answers: Answers = media === '' ? base : tool === 'findmnt'
      ? [['-no SOURCE -T *', `/dev/${media}`], ...base]
      : [[`-no PKNAME /dev/${media}`, media.replace(/p?[0-9]+$/, '')], ...base];
    const all: Answers = mounted
      ? [[tool === 'lsblk' ? '-nro MOUNTPOINTS /dev/sdz5' : '-n -o TARGET -- /dev/sdz5', '/home/fpp/media'],
        // As a plain `lsblk /dev/sdz5` lists it, which is what fpp asked until 10.x.
        ...(tool === 'lsblk' ? [['/dev/sdz5', 'sdz5   8:5    1 29.8G  0 part /home/fpp/media'] as [string, string]] : []),
        ...answers]
      : answers;
    const cases = all.map(([pattern, out]) =>
      `  ${pattern.replace(/ /g, '\\ ')}) ${out === '' ? 'exit 0' : `printf '%s\\n' '${out.replace(/\n/g, "' '")}'; exit 0`} ;;`);
    install(tool, `case "$*" in\n${cases.join('\n')}\nesac\nexec /usr/bin/${tool} "$@"`);
  }
  for (const tool of LOGGERS) {
    install(tool, `echo "${tool} $*" >> ${LOG}\nexit 0`);
  }
  writeIn(LOG, '', '666');
}

function calls(): string[] {
  return inPlayer('cat', LOG).split('\n').filter((l) => l);
}

test.afterEach(() => {
  inPlayer('sh', '-c', `for f in /usr/local/bin/*; do grep -q ${MARK} "$f" 2>/dev/null && rm -f "$f"; done; rm -f ${LOG} ${PWNED}; true`);
});

async function format(request: any, fs: string, dev: string): Promise<string> {
  const r = await request.get(`/formatstorage.php?fs=${encodeURIComponent(fs)}&storageLocation=${encodeURIComponent(dev)}`,
    { timeout: 60_000 });
  return r.text();
}

test('a format request for an unknown filesystem, a bad device name or a mounted partition runs nothing', async ({ request }) => {
  // Regression: cc5c3ea23 (#2830).  formatstorage.php passed fs and
  // storageLocation through escapeshellcmd() to the root script, which
  // checked neither, and nothing refused a partition that was in use: a
  // request could reformat the media drive under the running player.
  standInDisks();
  let out = await format(request, 'NTFS', 'sdz5');
  expect(out).toContain('ERROR: Invalid filesystem type requested.');
  out = await format(request, 'ext4', `sdz5;touch ${PWNED}`);
  expect(out).toContain('ERROR: Invalid storage device requested.');
  out = await format(request, 'ext4', '../sda1');
  expect(out).toContain('ERROR: Invalid storage device requested.');
  expect(out).not.toContain('Command:');
  expect(calls(), 'a refused format still ran the script').toEqual([]);

  standInDisks(true);
  out = await format(request, 'ext4', 'sdz5');
  expect(out).toContain("ERROR: Refusing to format 'sdz5' - ERROR: Partition is mounted on: /home/fpp/media");
  expect(out).not.toContain('Command:');
  expect(calls(), 'the mounted media partition was formatted').toEqual([]);
  expect(inPlayer('sh', '-c', `test -e ${PWNED} && echo y || echo n`).trim()).toBe('n');
});

test('a format of a free partition retypes and formats that partition, NVMe included', async ({ request }) => {
  // Regression: cc5c3ea23, the receiving end: format_storage.sh is given the
  // filesystem and the device as two words, and works out the disk and the
  // partition number from the name.  An NVMe name (nvme9n1p1) lost only its
  // last digit, so sfdisk was asked to retype partition 1 of /dev/nvme9n1p.
  standInDisks();
  await format(request, 'ext4', 'sdz5');
  await format(request, 'FAT', 'nvme9n1p1');
  const ran = calls();
  expect(ran.find((c) => c.startsWith('sfdisk --part-type /dev/sdz ')), ran.join('\n')).toBe('sfdisk --part-type /dev/sdz 5 83');
  expect(ran.some((c) => /^mkfs\.ext4 -F (-- )?\/dev\/sdz5$/.test(c)), ran.join('\n')).toBe(true);
  expect(ran.find((c) => c.startsWith('sfdisk --part-type /dev/nvme')), ran.join('\n')).toBe('sfdisk --part-type /dev/nvme9n1 1 c');
  expect(ran.some((c) => /^mkfs\.fat (-- )?\/dev\/nvme9n1p1$/.test(c)), ran.join('\n')).toBe(true);
});

test('the Storage tab offers Create and Copy for every disk but the booted one', async ({ request }) => {
  // Regression: 7c3b51da7.  The flash buttons were a per-platform chain of
  // hardcoded names -- on a Pi "sda, else nvme0n1" -- so with a USB stick in,
  // the NVMe drive could never be flashed.
  standInDisks();
  const r = await request.get('/settings-storage.php');
  expect(r.status()).toBe(200);
  const html = await r.text();
  const offered = (mode: string) => [...html.matchAll(new RegExp(`flashStorage\\(&quot;([^&]+)&quot;, '${mode}'`, 'g'))].map((m) => m[1]);
  expect(offered('create').sort()).toEqual(['nvme9n1', 'sdz']);
  expect(offered('copy').sort()).toEqual(['nvme9n1', 'sdz']);
  expect(html).toContain('USB - fpp-tests-stick (29.8G)');
  expect(html).toContain('NVMe - fpp-tests-nvme (238.5G)');
});

test('a flash request is run only for a disk the Storage tab offers', async ({ request }) => {
  // Regression: 7c3b51da7.  The old endpoints (flash-pi-usb.php and the
  // BeagleBone eMMC ones) passed ?dev= to the root flash script escaped but
  // unchecked, so a request could name the booted disk.
  standInDisks();
  for (const dev of ['mmcblk0', 'sdy', 'loop0']) {
    const out = await (await request.get(`/flash-storage.php?dev=${dev}&mode=create`)).text();
    expect(out, dev).toContain(`ERROR: '${dev}' is not a valid target device.`);
  }
  expect(calls(), 'a refused flash still ran the script').toEqual([]);

  // The control, and what flash_storage.sh's option parser is handed: -y,
  // --clone or --fresh, then the disk.  (It runs through stdbuf, the
  // stand-in, since 10.x.)
  const out = await (await request.get('/flash-storage.php?dev=nvme9n1&mode=copy', { timeout: 60_000 })).text();
  expect(out).toMatch(/Command: sudo TERM=vt100 (stdbuf --output=L --error=L )?\/opt\/fpp\/SD\/flash_storage\.sh -y --clone 'nvme9n1'/);
});

test('a flash request whose device carries a shell command runs nothing', async ({ request }) => {
  // Regression: d463b03c7 (#1863).  flash-pi-usb.php put ?dev= into its root
  // shell command as it came, so ?dev=sda;<command> ran the command as
  // root.  That endpoint is gone (3a284394d); its successor takes only a
  // disk it offers and still quotes the one it passes on.
  standInDisks();
  const outs: Record<string, string> = {};
  for (const dev of [`sdz;touch ${PWNED}`, `$(touch ${PWNED})`, `sdz\`touch ${PWNED}\``]) {
    outs[dev] = await (await request.get(`/flash-storage.php?dev=${encodeURIComponent(dev)}&mode=create`, { timeout: 60_000 })).text();
  }
  expect(inPlayer('sh', '-c', `test -e ${PWNED} && echo y || echo n`).trim(), 'the command in ?dev= ran').toBe('n');
  for (const [dev, out] of Object.entries(outs)) expect(out, dev).toContain('is not a valid target device.');
  expect(calls(), 'a refused flash still ran the script').toEqual([]);
});

test('the drive holding the media directory is not offered to flash, and a flash of it is refused', async ({ request }) => {
  // Regression: a0da0768b.  On a Pi booted from its SD card with the media
  // directory moved to a USB or NVMe drive, the Storage tab still offered to
  // flash FPP onto that drive -- wiping the media the running player was
  // using.  (Its check is GetFlashTargetDevices()'s storage-disk exclusion
  // since 7c3b51da7; flash-storage.php refuses what that leaves out.)
  standInDisks(false, 'sdz2');
  const html = await (await request.get('/settings-storage.php')).text();
  const offered = (mode: string) => [...html.matchAll(new RegExp(`flashStorage\\(&quot;([^&]+)&quot;, '${mode}'`, 'g'))].map((m) => m[1]);
  // The control: the NVMe drive beside it is still offered.
  expect(offered('create')).toEqual(['nvme9n1']);
  expect(offered('copy')).toEqual(['nvme9n1']);
  const out = await (await request.get('/flash-storage.php?dev=sdz&mode=copy')).text();
  expect(out).toContain("ERROR: 'sdz' is not a valid target device.");
  expect(calls(), 'the media drive was flashed').toEqual([]);
});

test('the format prompt offers exFAT, and choosing it types the partition 07 and makes an exFAT filesystem', async ({ page }) => {
  // Feature: 23add459e ("Ability to format devices to exFAT").  The Storage
  // tab's format prompt offered ext4 and FAT only, and format_storage.sh had
  // no exFAT case.  The device scenario test_storage_exfat.py runs the real
  // sfdisk and mkfs.exfat on a loop device; here they are the stand-ins.
  standInDisks();
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    await page.goto('/settings.php#settings-storage');
    await page.waitForFunction(() => typeof (window as any).checkFormatStorage === 'function', null, { timeout: 30_000 });
    // The player is a container, so the tab prints no Storage Device select:
    // put the one it prints on a device, with a partition not yet mounted.
    await page.evaluate(() => {
      const $ = (window as any).$;
      $('#storageDevice').remove();
      $('body').append('<select id="storageDevice"><option value="sdz5" selected>sdz5 - 29.8GB (Not Mounted) (USB)</option></select>');
      (window as any).checkFormatStorage();
    });
    const exfat = page.locator('input[name=formatType][value=exFAT]');
    await expect(exfat).toBeVisible({ timeout: 10_000 });
    await exfat.check();
    const formatted = page.waitForResponse((r) => r.url().includes('formatstorage.php'), { timeout: 60_000 });
    await page.locator('input.msgButton[value="OK"]').click();
    const r = await formatted;
    expect(new URL(r.url()).searchParams.get('fs')).toBe('exFAT');
  });
  const ran = calls();
  expect(ran.find((c) => c.startsWith('sfdisk --part-type')), ran.join('\n')).toBe('sfdisk --part-type /dev/sdz 5 07');
  expect(ran.some((c) => /^mkfs\.exfat (-- )?\/dev\/sdz5$/.test(c)), ran.join('\n')).toBe(true);
});
