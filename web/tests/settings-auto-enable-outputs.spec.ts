import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile, setSettingInFile, snapshotSettings } from './settings-file';

// Regression: aeff3152e.  AutoEnableOutputs, the setting that lets fppd switch
// a controller's port power on and off as it starts and stops output, was
// added to Settings > Output as an Advanced checkbox that is on by default.
// fppd reads it from the settings file (OutputMonitor::AutoEnableOutputs()),
// which is what the checkbox writes.  Also aeff3152e: the Outputs On and Outputs
// Off commands answered with an error result (HTTP 500) for a successful run;
// test_port_status.py runs both and fails on that.

test.skip(!container, 'reads and seeds the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('Settings > Output has an Auto Enable Outputs checkbox, on by default, that saves', async ({ page, request }) => {
  setSettingInFile('AutoEnableOutputs', undefined);
  setSettingInFile('uiLevel', '1');
  try {
    await page.goto('/settings.php?tab=Output');
    const box = page.locator('#AutoEnableOutputs');
    await expect(box).toBeVisible({ timeout: 15_000 });
    await expect(box).toBeChecked();

    await box.uncheck();
    // The control: the save went through to the file fppd reads.
    await expect.poll(() => settingInFile('AutoEnableOutputs'), { timeout: 15_000 }).toBe('0');
    // The receiving end: the settings API fppd's PHP side serves says off.
    const got = await (await request.get('/api/settings/AutoEnableOutputs')).json();
    expect(String(got.value)).toBe('0');

    await box.check();
    await expect.poll(() => settingInFile('AutoEnableOutputs'), { timeout: 15_000 }).toBe('1');
  } finally {
    await request.put('/api/settings/AutoEnableOutputs', { data: '1' });
  }
});
