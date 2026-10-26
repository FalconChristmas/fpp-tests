import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';
import { putFile } from './settings-file';
import { denying, preloadDeny, unpreloadDeny } from './fakedeny';

// A setting the player can't write is reported as not saved, and not
// applied.  On a player the way in is a settings file a stray root write left
// root's, which the web user (fpp) can't open for writing; here php-fpm runs
// as root, which no chmod stops, so fakedeny.so (fakedeny.ts) is preloaded
// into it and refuses write opens of the settings file while a test asks.  The
// container has no fpp user, so the fix's ownership repair (sudo chown back
// to fpp, then a retry) has nothing to repair to and isn't exercised: these
// are the refusal half.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SETTINGS = '/home/fpp/media/settings';
const CMDLINE = '/boot/cmdline.txt';
const BASE = 'console=tty1 root=PARTUUID=fpp-tests-03 rootwait';

test.beforeAll(() => preloadDeny());
test.afterAll(() => unpreloadDeny());

async function unwritable<T>(fn: () => Promise<T>): Promise<T> {
  return keepingSettings(() => denying({ write: [SETTINGS] }, fn));
}

test("a setting that can't be written is a 500 with an error, and isn't applied", async ({ request }) => {
  // Regression: e0d37cdf4.  WriteSettingToFile() never checked its fopen():
  // flock() then threw a TypeError, the value was lost, and the reply still
  // looked like a save.  The setting is an HDMI resolution, whose apply
  // edits the boot cmdline.txt (on any platform but a BeagleBone).
  test.skip(inPlayer('sh', '-c', `test -e ${CMDLINE} && echo y || echo n`).trim() === 'y',
    'the player already has a boot cmdline.txt');
  putFile(CMDLINE, `${BASE}\n`);
  try {
    await unwritable(async () => {
      setSettingInFile('ForceHDMIResolution', 'Default');
      const before = inPlayer('cat', SETTINGS);
      const r = await request.put('/api/settings/ForceHDMIResolution', { data: '1920x1080@60' });
      const text = await r.text();
      expect(r.status(), text).toBe(500);
      expect(JSON.parse(text).status, text).toBe('ERROR');
      expect(inPlayer('cat', SETTINGS)).toBe(before);
      expect(inPlayer('cat', CMDLINE).trim(), 'a value that was not saved was applied').toBe(BASE);
    });
    // The control: with the file writable again the same save goes through.
    await keepingSettings(async () => {
      const r = await request.put('/api/settings/ForceHDMIResolution', { data: '1920x1080@60' });
      expect(r.status()).toBe(200);
      expect(inPlayer('cat', CMDLINE)).toContain('video=HDMI-A-1:1920x1080@60');
    });
  } finally {
    inPlayer('rm', '-f', CMDLINE);
  }
});

test("the page says a setting that can't be written was not saved", async ({ page }) => {
  // Regression: e0d37cdf4, the page end: SetSetting()'s success handler took
  // the reply as a save, said "setting saved" and kept the new value.
  await page.goto('/settings.php');
  await page.waitForFunction(() => typeof (window as any).SetSetting === 'function');
  await unwritable(async () => {
    setSettingInFile('HostDescription', 'fpp-tests-before');
    const reply = page.waitForResponse((r) => r.url().endsWith('/api/settings/HostDescription') && r.request().method() === 'PUT');
    await page.evaluate(() => (window as any).SetSetting('HostDescription', 'fpp-tests-lost', 0, 0));
    await reply;
    await expect(page.getByText('Failed to save HostDescription setting.')).toBeVisible();
    await expect(page.getByText('HostDescription setting saved.')).toHaveCount(0);
    expect(inPlayer('cat', SETTINGS)).not.toContain('fpp-tests-lost');
  });
});
