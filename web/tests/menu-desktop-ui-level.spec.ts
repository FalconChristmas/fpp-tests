import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// On a desktop install (config.php: /etc/fpp/desktop exists) the machine's
// network and time belong to the desktop, so FPP hides its Network menu entry
// and Localization settings tab, except at the Developer UI level.

test.skip(!container, 'adds /etc/fpp/desktop and seeds the settings file inside the run-web.sh container');

const MARKER = '/etc/fpp/desktop';
let restoreSettings: () => void;
let hadMarker: boolean;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  hadMarker = inPlayer('sh', '-c', `test -e ${MARKER} && echo yes || echo no`).trim() === 'yes';
});
test.afterEach(() => {
  restoreSettings();
  if (!hadMarker) inPlayer('rm', '-f', MARKER);
});

test('a desktop install hides the Network entry and Localization tab until the Developer UI level', async ({ page }) => {
  // Regression: cac4dbd5c.  The Network menu entry and the Settings tab for
  // time were hidden on every desktop install, whatever the UI level, so
  // the Developer level (3) could not reach them either.
  const network = page.locator('a.dropdown-item[href="networkconfig.php"]');
  const localization = page.locator('#settings-localization-tab');
  const look = async (level: string) => {
    setSettingInFile('uiLevel', level);
    await page.goto(`/settings.php?level=${level}`);
    await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
  };

  // The control: not a desktop, both are there at a low level.
  inPlayer('rm', '-f', MARKER);
  await look('1');
  await expect(network).toHaveCount(1);
  await expect(localization).toHaveCount(1);

  inPlayer('sh', '-c', `touch ${MARKER}`);
  await look('2');
  await expect(network, 'desktop, Advanced+').toHaveCount(0);
  await expect(localization).toHaveCount(0);
  await look('3');
  await expect(network, 'desktop, Developer').toHaveCount(1);
  await expect(localization).toHaveCount(1);
});
