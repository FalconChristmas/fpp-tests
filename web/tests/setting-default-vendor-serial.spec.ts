import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// A setting missing from the settings file reads as its settings.json default.

test.skip(!container, 'edits the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('a never-set Send Cape Serial Numbers setting reads as on', async ({ request }) => {
  // Regression: cdaac72b9.  SendVendorSerial's default in settings.json was
  // 0; the commit made it 1.
  setSettingInFile('SendVendorSerial', undefined);
  setSettingInFile('showAllOptions', undefined);
  const serial = await (await request.get('/api/settings/SendVendorSerial')).json();
  expect(String(serial.value), JSON.stringify(serial)).toBe('1');
  // The control: another checkbox with a default of 0 still reads 0.
  const all = await (await request.get('/api/settings/showAllOptions')).json();
  expect(String(all.value), JSON.stringify(all)).toBe('0');
});
