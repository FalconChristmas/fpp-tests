import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile } from './settings-file';

// Regression: 24c22f508 ("php error - check array populated before reading
// first value"). The Storage settings tab's device select looks the root
// device up with lsblk (findmnt on a BeagleBone) and took the first line of
// the answer without checking there was one: where the root filesystem is
// not on a block device lsblk lists -- an overlay, as in this container --
// every load of the tab wrote an "Undefined array key 0" warning to the
// error log.
//
// The select is printed only off Docker, so the page is rendered with the
// container marker moved aside and a platform marker holding what config.php
// falls back to without one (uname -s); both are put back straight after.
// Only warnings from PrintStorageDeviceSelect() count there; the tab's
// later findmnt lookup has a test of its own below.

test.skip(!container, 'reads the error log inside the run-web.sh container');

const LOG = `${MEDIA}/logs/apache2-error.log`;
const PAGE = '/opt/fpp/www/settings-storage.php';
const PLATFORM = '/etc/fpp/platform';
const CONTAINER = '/etc/fpp/container';
const ASIDE = '/etc/fpp/container.fpp-tests';
const sh = (cmd: string) => inPlayer('sh', '-c', cmd);

// The source lines of PrintStorageDeviceSelect(), from its declaration to the
// next top-level closing brace.
function functionLines(): [number, number] {
  const out = sh(`awk '/^function PrintStorageDeviceSelect/ {s=NR} s && NR>s && /^}/ {print s, NR; exit}' ${PAGE}`).trim();
  const [a, b] = out.split(' ').map(Number);
  return [a, b];
}

function warningsIn([a, b]: [number, number]): string[] {
  return sh(`grep 'settings-storage.php on line' ${LOG} 2>/dev/null || true`).split('\n').filter((l) => {
    const m = /settings-storage\.php on line (\d+)/.exec(l);
    return m !== null && Number(m[1]) >= a && Number(m[1]) <= b;
  });
}

test('the Storage tab prints its device select with no root device found and logs no warning', async ({ request }) => {
  // The control: the lookup the select makes finds nothing here.
  expect(sh(`lsblk -l 2>/dev/null | grep " /$" | cut -f1 -d" "`).trim(), 'the root filesystem is on a listed device here').toBe('');
  const range = functionLines();
  expect(range[1], 'PrintStorageDeviceSelect() not found').toBeGreaterThan(range[0]);
  const before = warningsIn(range).length;

  const wrotePlatform = !exists(PLATFORM);
  if (wrotePlatform) putFile(PLATFORM, sh('uname -s'));
  inPlayer('mv', CONTAINER, ASIDE);
  let body: string;
  try {
    const r = await request.get('/settings-storage.php');
    expect(r.status()).toBe(200);
    body = await r.text();
  } finally {
    inPlayer('mv', ASIDE, CONTAINER);
    if (wrotePlatform) inPlayer('rm', '-f', PLATFORM);
  }
  // It printed the select, so it got past the lookup.
  expect(body).toContain('Storage Device:');
  expect(body).toContain("id='storageDevice'");
  await new Promise((r) => setTimeout(r, 500));
  expect(warningsIn(range).slice(before), 'the device select logged a warning').toEqual([]);
});

test('the Storage tab logs no warning when the root device lookup for its new-partition button finds nothing', async ({ request }) => {
  // Regression: the same unchecked $output[0] as 24c22f508, in the tab's
  // top-level lookup (findmnt piped through colrm) that decides whether to
  // offer a new filesystem in the unpartitioned space.  It answers nothing
  // here (the image has no colrm), and every load of the tab logged
  // "Undefined array key 0".  This one runs on Docker too.
  // The control: the lookup answers nothing here.
  expect(sh(`findmnt -n -o SOURCE / | colrm 1 5 2>/dev/null || true`).trim(), 'the root device lookup found something here').toBe('');
  const all = (): string[] => sh(`grep 'settings-storage.php on line' ${LOG} 2>/dev/null || true`).split('\n').filter((l) => l !== '');
  const before = all().length;
  const r = await request.get('/settings-storage.php');
  expect(r.status()).toBe(200);
  // It got past the lookup, to the end of the page.
  expect(await r.text()).toContain('id="mounted-device-callout-warning"');
  await new Promise((r) => setTimeout(r, 500));
  expect(all().slice(before), 'the Storage tab logged a warning').toEqual([]);
});
