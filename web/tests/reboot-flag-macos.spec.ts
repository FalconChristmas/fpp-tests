import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { SETTINGS, setSettingInFile, readFile, putFile, exists } from './settings-file';

// Regression: ecbaa2adb.  A reboot flag is a request to something that runs at
// boot, which never happens on macOS, so a flag already in the settings file
// (from a restore or an upgrade script) stayed raised for good: the banner and
// /api/system/status reported a reboot nothing would perform or clear.
//
// The platform is stood in for by the platform file saying Darwin (with the
// marker that makes the player a Docker one, checked first, moved aside), as
// macos-version-trim.spec.ts does; the settings file is seeded as a restore
// would leave it.

test.skip(!container, 'changes the platform file inside the run-web.sh container');
test.describe.configure({ mode: 'serial' });

const PLATFORM = '/etc/fpp/platform';
const MARKER = '/etc/fpp/container';
let savedPlatform: string | undefined;
let savedSettings = '';

test.beforeEach(() => {
  savedSettings = readFile(SETTINGS);
  savedPlatform = exists(PLATFORM) ? readFile(PLATFORM) : undefined;
});
test.afterEach(() => {
  inPlayer('sh', '-c', `[ ! -e ${MARKER}.saved ] || mv ${MARKER}.saved ${MARKER}`);
  putFile(SETTINGS, savedSettings);
  if (savedPlatform === undefined) inPlayer('rm', '-f', PLATFORM);
  else putFile(PLATFORM, savedPlatform);
});

const statusFlag = async (request: any) => (await (await request.get('/api/system/status')).json()).rebootFlag;

test('a reboot flag left in the settings is not reported on macOS', async ({ page, request }) => {
  setSettingInFile('rebootFlag', '1');
  // The control: on the player's own platform the same file does ask for a reboot.
  expect(await statusFlag(request), 'the seeded flag was not reported').toBe(1);
  await page.goto('/index.php');
  await expect(page.locator('#rebootFlag'), 'no alert for a real flag').toBeAttached();

  inPlayer('sh', '-c', `mv ${MARKER} ${MARKER}.saved; printf Darwin > ${PLATFORM}`);
  expect(await statusFlag(request), 'macOS reports a reboot nothing can perform').toBe(0);
  await page.goto('/index.php?mac=1');
  await expect(page.locator('#menuBar, #fppMenu').first()).toBeAttached();
  await expect(page.locator('#rebootFlag'), 'the Reboot Required banner (and its Reboot button) is on the page').toHaveCount(0);
});
