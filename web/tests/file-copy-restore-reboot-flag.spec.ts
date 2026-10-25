import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, SETTINGS, settingInFile } from './settings-file';

// Regression: 2344bfefc ("Implement reboot flag for configuration
// restoration"). A File Copy restore of "Configuration" replaces the settings
// file and the config directory, which only a reboot fully applies, but
// copystorage.php asked for none: the player carried on with the old setup
// and no page said so. Since the fix a File Copy FROM anywhere with the
// Configuration flag sets rebootFlag; a copy TO storage, or one of other
// things, does not.
//
// The receiving ends are what reads the flag: /api/system/status, and the
// "Reboot Required" alert every page shows from it.
//
// (The image has no rsync, so the copy itself moves nothing; what is checked
// is what copystorage.php marks afterwards, which does not depend on it.)

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const FOLDER = 'fpp-tests-reboot-flag';
// A restore sets these whatever it copied; put them back.
const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; /^pluginReinstallNeededAfterOS\\s*=/d; ` +
  `s/^rebootFlag\\s*=.*/rebootFlag = "0"/' ${SETTINGS}`;

test.beforeEach(() => {
  inPlayer('sh', '-c', `${CLEAR}; mkdir -p ${MEDIA}/backups/${FOLDER}/config`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `${CLEAR}; rm -rf ${MEDIA}/backups/${FOLDER}`);
});

async function fileCopy(request: APIRequestContext, direction: string, flags: string) {
  const r = await request.get(`/copystorage.php?wrapped=1&direction=${direction}&path=${FOLDER}` +
    `&flags=${encodeURIComponent(flags)}&storageLocation=none&remoteStorage=none`, { timeout: 120_000 });
  const out = await r.text();
  expect(r.ok(), out.slice(-1500)).toBe(true);
  // The control: the copy ran, past the path checks.
  expect(out).toContain('copy_settings_to_storage.sh');
  expect(out).not.toContain('Invalid');
  return out;
}

const statusFlag = async (request: APIRequestContext) => (await (await request.get('/api/system/status')).json()).rebootFlag;

test('a File Copy restore of Configuration asks for a reboot', async ({ page, request }) => {
  expect(await statusFlag(request)).toBe(0);
  await fileCopy(request, 'FROMLOCAL', 'Configuration');
  expect(settingInFile('rebootFlag'), 'the restore did not set rebootFlag').toBe('1');
  expect(await statusFlag(request), '/api/system/status does not report the reboot').toBe(1);
  await page.goto('/index.php');
  await expect(page.locator('#rebootFlag'), 'the page shows no Reboot Required alert').toBeVisible({ timeout: 15_000 });
});

test('a File Copy of other things, or to storage, does not ask for a reboot', async ({ request }) => {
  await fileCopy(request, 'FROMLOCAL', 'Sequences Images');
  expect(settingInFile('rebootFlag') ?? '0', 'a restore of only media set rebootFlag').toBe('0');
  await fileCopy(request, 'TOLOCAL', 'Configuration');
  expect(settingInFile('rebootFlag') ?? '0', 'a backup TO storage set rebootFlag').toBe('0');
  expect(await statusFlag(request)).toBe(0);
});
