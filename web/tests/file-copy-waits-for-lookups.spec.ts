import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The File Copy section's Copy button waits for the page's lookups, and a copy
// to a remote host doesn't list the folders on its drive.  Issue #3107: picking
// the master's sda1 listed its folders, which mounts sda1 on /mnt/tmp_sda1 for
// a moment, and a Copy clicked meanwhile failed with "Partition is mounted on:
// /mnt/tmp_sda1".  Fixed in fpp:
// - af4b96537 ("fix(drive-mount): improve locking mechanism to prevent mount
//   conflicts during backup operations"): a copy to a remote no longer lists
//   folders; the list only fills the path select, which it hides.
// - 88514936b ("fix(backup): a Backup Host change lists folders once, for the
//   right host"): a host that can't be reached no longer leaves the previous
//   host's folders.
// - c89d6920a ("fix(backup): the saved Remote Storage device is selected
//   again"): it stopped being after 90efa4726, so the device had to be
//   picked, and listed, every time.
// - d70046fb4 ("fix(backup): Copy waits for the drive and folder lookups").
//
// Every request the section makes is answered by the test; settings writes are
// swallowed so the player's own backup settings are left alone.

const HOST = '192.0.2.10'; // TEST-NET-1: never a real player

async function common(page: Page) {
  await page.route((u) => u.pathname.includes('/api/settings/') && !u.pathname.endsWith('/backup.RemoteStorage'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.pathname.endsWith('/api/settings/backup.RemoteStorage'),
    (route) => route.request().method() === 'GET'
      ? route.fulfill({ json: { name: 'backup.RemoteStorage', value: 'sda1' } })
      : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.searchParams.get('ip') === HOST && u.pathname.endsWith('/api/settings/Service_rsync'),
    (route) => route.fulfill({ json: { name: 'Service_rsync', value: '1' } }));
}

function held() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release };
}

test('Copy waits for the drive list to load', async ({ page }) => {
  await common(page);
  const devices = held();
  await page.route((u) => u.pathname.endsWith('/api/backups/devices') && !u.searchParams.has('ip'), async (route) => {
    await devices.gate;
    await route.fulfill({ json: [] });
  });
  await page.goto('/backup.php');
  const copy = page.locator('#tab-fileCopy input[type=button][value="Copy"]');
  await expect(copy).toBeDisabled({ timeout: 15_000 });
  devices.release();
  await expect(copy).toBeEnabled({ timeout: 15_000 });
});

test("a copy to a remote waits for its storage list, keeps the saved device and doesn't list its folders", async ({ page }) => {
  await common(page);
  await page.route((u) => u.pathname.endsWith('/api/backups/devices') && !u.searchParams.has('ip'),
    (route) => route.fulfill({ json: [] }));
  const storage = held();
  await page.route((u) => u.pathname.endsWith('/api/backups/devices') && u.searchParams.get('ip') === HOST, async (route) => {
    await storage.gate;
    await route.fulfill({ json: [{ name: 'sda1', vendor: 'fpp-tests', model: 'SSD', size: 465 }] });
  });
  const listed: string[] = [];
  await page.route((u) => u.pathname.includes('/api/backups/list'), (route) => {
    listed.push(route.request().url());
    return route.fulfill({ json: ['/'] });
  });

  await page.goto('/backup.php');
  const copy = page.locator('#tab-fileCopy input[type=button][value="Copy"]');
  await expect(copy).toBeEnabled({ timeout: 15_000 });
  listed.length = 0;
  await page.click('#backups-fileCopy-tab');

  // The host list is the player's MultiSync systems; add one without its onchange.
  await page.evaluate((host) => {
    const sel = document.getElementById('backup.Host') as HTMLSelectElement;
    sel.add(new Option(host, host));
    sel.value = host;
  }, HOST);
  await page.selectOption('#backup\\.Direction', 'TOREMOTE');

  await expect(copy).toBeDisabled();
  storage.release();
  await expect(page.locator('#backup\\.RemoteStorage')).toHaveValue('sda1', { timeout: 15_000 });
  await expect(copy).toBeEnabled({ timeout: 15_000 });
  // Give a stray list request time to show up before saying there was none.
  await page.waitForTimeout(1_000);
  expect(listed, 'folders were listed for a copy to a remote').toEqual([]);
});

test("a remote host that can't be reached doesn't keep the previous host's folders", async ({ page }) => {
  await common(page);
  await page.route((u) => u.pathname.endsWith('/api/backups/devices') && !u.searchParams.has('ip'),
    (route) => route.fulfill({ json: [] }));
  await page.route((u) => u.pathname.endsWith('/api/backups/devices') && u.searchParams.get('ip') === HOST,
    (route) => route.fulfill({ status: 502, body: 'unreachable' }));
  await page.route((u) => u.pathname.includes('/api/backups/list'), (route) => route.fulfill({ json: ['/', 'otherHostBackup'] }));

  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  await page.selectOption('#backup\\.Direction', 'FROMREMOTE');
  // The control: the previous host's folders are showing.
  await page.evaluate(() => {
    const sel = document.getElementById('backup.PathSelect') as HTMLSelectElement;
    sel.add(new Option('otherHostBackup', 'otherHostBackup'));
  });
  await expect(page.locator('#backup\\.PathSelect option')).not.toHaveCount(0);

  await page.evaluate((host) => {
    const sel = document.getElementById('backup.Host') as HTMLSelectElement;
    sel.add(new Option(host, host));
  }, HOST);
  await page.selectOption('#backup\\.Host', HOST);
  await expect(page.locator('#backup\\.PathSelect option')).toHaveCount(0, { timeout: 15_000 });
});
