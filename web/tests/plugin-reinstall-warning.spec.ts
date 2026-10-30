import { test, expect } from './fixtures';
import { container } from './container';
import { snapshotSettings, setSettingInFile } from './settings-file';

// After an FPPOS upgrade with plugins kept, pluginReinstallNeededAfterOS is
// set and fppd raises "Plugins must be reinstalled" with a Fix link; the
// warnings banner on every page shows that link as a button that opens the
// Plugin Manager's Reinstall All.  Feature: 4fab04355.  (fppinit setting the
// flag and fppd raising and dropping the warning:
// test_plugin_reinstall_after_os.py.)

test.skip(!container, "edits run-web.sh's player's settings file");

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test("the reinstall warning's Fix button opens the Plugin Manager's Reinstall All", async ({ page, request }) => {
  setSettingInFile('pluginReinstallNeededAfterOS', '1');
  try {
    // The receiving end: the player's fppd raised the warning.
    await expect.poll(async () => {
      const status = await (await request.get('/api/system/status')).json();
      return (status.warningInfo ?? []).some((w: any) => w.id == 57);
    }, { timeout: 15_000 }).toBe(true);
    await page.goto('/index.php');
    const fix = page.locator('#warningsDiv a.warning-fix-btn');
    await expect(fix).toHaveCount(1, { timeout: 15_000 });
    await expect(fix).toContainText('Reinstall All Plugins');
    expect(await fix.getAttribute('href')).toBe('plugins.php?action=reinstallAll');
  } finally {
    setSettingInFile('pluginReinstallNeededAfterOS', ''); // as the Plugin Manager clears it
  }
  await expect.poll(async () => {
    const status = await (await request.get('/api/system/status')).json();
    return (status.warningInfo ?? []).some((w: any) => w.id == 57);
  }, { timeout: 15_000, message: 'the warning went once the setting was cleared' }).toBe(false);
});
