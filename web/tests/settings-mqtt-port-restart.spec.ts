import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Changing the MQTT Broker Port on the Settings page's MQTT tab.

test.skip(!container, 'reads and seeds the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(async ({ request }) => {
  restoreSettings();
  // fppd keeps the port it was told about, and the restart flag.
  await request.put('/api/settings/MQTTPort', { data: '1883' });
  await request.put('/api/settings/restartFlag', { data: '0' });
});

test('changing the MQTT broker port asks for an fppd restart', async ({ page, request }) => {
  // Regression: cfd3ca809.  fppd connects to the broker at start and reads
  // the port only then, but MQTTPort carried no restart in settings.json: a
  // new port was saved and nothing told the user fppd was still using the
  // old one.  It is a restart 2 setting, as the broker host is.
  setSettingInFile('MQTTHost', 'localhost');
  setSettingInFile('MQTTPort', '1883');
  setSettingInFile('restartFlag', '0');
  page.on('dialog', (d) => d.accept());
  await page.goto('/settings.php?tab=MQTT');
  const port = page.locator('#MQTTPort');
  await expect(port).toHaveValue('1883', { timeout: 15_000 });
  await expect(page.locator('#restartFlag')).toBeHidden();
  const saved = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/settings/MQTTPort'));
  await port.fill('1884');
  await port.blur();
  // The control: the page saved the new port.
  expect((await saved).postData()).toBe('1884');
  await expect.poll(() => settingInFile('MQTTPort')).toBe('1884');

  await expect.poll(() => settingInFile('restartFlag'), { timeout: 10_000 }).toBe('2');
  // The receiving end: the status the header reads asks for the restart,
  // and the page shows it.
  expect(String((await (await request.get('/api/system/status')).json()).restartFlag)).toBe('2');
  await expect(page.locator('#restartFlag')).toBeVisible({ timeout: 15_000 });
});
