import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

test.skip(!container, 'seeds the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('the system info carries the sub-platform, header colour and logo', async ({ request }) => {
  // Regression: 98c98b222.  Other FPPs and tools read /api/system/info (the
  // status a remote's page shows) for how a box looks: the header colour and
  // logo are what the multisync page draws a row with.  The reply held
  // neither, nor the sub-platform name.
  setSettingInFile('SubPlatform', 'fpp-tests sub');
  setSettingInFile('backgroundColor', 'ff8800');
  setSettingInFile('Logo', 'fpp-tests-logo.png');
  const info = await (await request.get('/api/system/info')).json();
  expect(info.SubPlatform).toBe('fpp-tests sub');
  expect(info.backgroundColor).toBe('ff8800');
  expect(info.Logo).toBe('fpp-tests-logo.png');
  // The control: it is still the box's own platform and mode beside them.
  expect(info.Mode).toBe('player');
  expect(info).toHaveProperty('Platform');
});
