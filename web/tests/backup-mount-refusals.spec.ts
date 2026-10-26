import { test, expect } from './fixtures';
import { container, playerAddress } from './container';
import { mounts, removeStandIns, standInMounts, umountCalls } from './fake-mounts';

// What the backup API says when it won't mount, list or unmount a drive, and
// who it leaves alone.  The drives are a fake mount table (fake-mounts.ts),
// as the player has none and can't mount.  The "remote" in the File Copy
// checks is this player at its own address, as in
// file-copy-unmountable.spec.ts.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test.afterEach(() => removeStandIns());

test("a drive whose folders can't be listed says why, as one entry", async ({ request }) => {
  // Regression: ac5afba34.  GetAvailableBackupsOnDevice encoded
  // DriveMountHelper's refusal, already JSON, a second time: the list came
  // back as one JSON string, which the dialog listed a character per row.
  standInMounts(['/dev/sdz8 /media/fpp-tests-elsewhere']);
  const r = await request.get('/api/backups/list/sdz8');
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual(['ERROR: Partition is mounted on: /media/fpp-tests-elsewhere']);
});

test("the File Copy folder list shows a drive's refusal as one row", async ({ page }) => {
  // Regression: ac5afba34, the page end: the folder select a restore from
  // that drive offers.  This player's drive list is answered by the test (it
  // has no drives); the folder list is the player's own.
  standInMounts(['/dev/sdz8 /media/fpp-tests-elsewhere']);
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.pathname.endsWith('/api/backups/devices') && !u.searchParams.has('ip'),
    (route) => route.fulfill({ json: [{ name: 'sdz8', vendor: 'fpp-tests', model: 'USB', size: 8 }] }));
  const listed = page.waitForResponse((r) => r.url().includes('/api/backups/list/sdz8'));
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  await page.selectOption('#backup\\.Direction', 'FROMUSB');
  await listed;
  const rows = page.locator('#backup\\.PathSelect option');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveText('ERROR: Partition is mounted on: /media/fpp-tests-elsewhere');
});

test('a mount refused because the drive is mounted elsewhere says why', async ({ request }) => {
  // Regression: 927dfa220.  DriveMountHelper's refusal came back as JSON text
  // where MountDevice expected an array, array_key_exists() threw a
  // TypeError, and the caller got a bare 500.
  standInMounts(['/dev/sdz8 /media/fpp-tests-elsewhere']);
  const r = await request.post('/api/backups/devices/mount/sdz8/fpp-tests-mnt');
  expect(r.status(), await r.text()).toBe(200);
  const body = await r.json();
  expect(body.Status).toBe('Error');
  expect(body.Message).toContain('Partition is mounted on: /media/fpp-tests-elsewhere');
});

test("a File Copy to a remote drive that's mounted elsewhere reports the remote's reason", async ({ request }) => {
  // Regression: 927dfa220, the receiving end: copy_settings_to_storage.sh
  // prints the remote's Message, and a 500 has none.
  standInMounts(['/dev/sdz8 /media/fpp-tests-elsewhere']);
  const ip = playerAddress().ip;
  const r = await request.get(`/copystorage.php?direction=TOREMOTE&storageLocation=${ip}` +
    '&remoteStorage=sdz8&path=fpp-tests-mnt&flags=Configuration&delete=no&compress=no', { timeout: 180_000 });
  // The script printed the reply's JSON escapes (\/) until it was taught not to.
  const out = (await r.text()).replace(/\\\//g, '/');
  expect(out).toContain(`Remote Host: ${ip} reported`);
  expect(out, "the remote's reply had no reason in it").toContain('Partition is mounted on: /media/fpp-tests-elsewhere');
});

test('unmounting a mount point that holds nothing is a quiet OK', async ({ request }) => {
  // Regression: 41165c87e.  UnmountDevice ran umount regardless, and an empty
  // mount point (the backup script had already unmounted it) was an error.
  standInMounts([]);
  const r = await request.post('/api/backups/devices/unmount/sdz7/fpp-tests-um');
  const body = await r.json();
  expect(body.Status, JSON.stringify(body)).toBe('OK');
  expect(body.Message).toContain('Nothing mounted');
  expect(umountCalls()).toEqual([]);
});

test("unmounting leaves another device's mount alone", async ({ request }) => {
  // Regression: 41165c87e.  Whatever was mounted at the mount point was
  // unmounted, even a different device someone else had mounted there since.
  standInMounts(['/dev/sdy3 /mnt/fpp-tests-um']);
  const r = await request.post('/api/backups/devices/unmount/sdz7/fpp-tests-um');
  const body = await r.json();
  expect(body.Status, JSON.stringify(body)).toBe('Error');
  expect(body.Message).toContain('it holds /dev/sdy3');
  expect(mounts(), "the other device's mount was taken down").toEqual(['/dev/sdy3 /mnt/fpp-tests-um']);
  expect(umountCalls().filter((c) => c.includes('/mnt/fpp-tests-um'))).toEqual([]);

  // The control: the device asked for is unmounted.
  standInMounts(['/dev/sdz7 /mnt/fpp-tests-um']);
  const ok = await (await request.post('/api/backups/devices/unmount/sdz7/fpp-tests-um')).json();
  expect(ok.Status, JSON.stringify(ok)).toBe('OK');
  expect(mounts()).toEqual([]);
});

test("closing a finished File Copy doesn't ask the remote to unmount again", async ({ page }) => {
  // Regression: 41165c87e, the page half: closing the dialog posted an
  // unmount to the remote after the backup script had already finished
  // with the drive.
  test.setTimeout(180_000);
  standInMounts([]);
  const ip = playerAddress().ip;
  await page.route((u) => u.pathname.includes('/api/settings/'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  const unmounts: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/backups/devices/unmount/')) unmounts.push(r.url());
  });
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  await page.waitForLoadState('networkidle');
  await page.evaluate((host) => {
    const sel = document.getElementById('backup.Host') as HTMLSelectElement;
    sel.add(new Option(host, host));
    sel.value = host;
  }, ip);
  const storage = page.waitForResponse((r) => r.url().includes('/api/backups/devices?ip='));
  await page.selectOption('#backup\\.Direction', 'TOREMOTE');
  await storage;
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const sel = document.getElementById('backup.RemoteStorage') as HTMLSelectElement;
    sel.add(new Option('sdz7', 'sdz7'));
    sel.value = 'sdz7';
    (document.getElementById('backup.Path') as HTMLInputElement).value = 'fpp-tests-um';
    for (const box of document.querySelectorAll<HTMLInputElement>('#tab-fileCopy input[type=checkbox][id^="backup."]')) {
      box.checked = box.id === 'backup.Configuration';
    }
  });
  await page.click('#tab-fileCopy input[type=button][value="Copy"]');
  const close = page.locator('#copyPopup_ModalCloseButton');
  await expect(close).toBeEnabled({ timeout: 150_000 });
  // The control: the copy ran against the remote drive, which didn't mount.
  await expect(page.locator('#copyPopup_Modal #copyText')).toHaveValue(/could not mount sdz7/);
  await close.click();
  await page.waitForTimeout(2_000);
  expect(unmounts, 'the dialog asked the remote to unmount again').toEqual([]);
});
