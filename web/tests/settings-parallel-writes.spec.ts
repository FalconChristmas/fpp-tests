import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile, snapshotSettings } from './settings-file';

// Changing a setting rewrites the whole settings file from what it read, so
// the read has to happen under the same exclusive lock as the write: two
// changes at once (two pages saving, a plugin and the UI, xLights setting a
// few in a row) must both land.
//
// Regression: ff1947233 ("Use exclusive locking for the settings file when
// changing a setting").  WriteSettingToFile() read the file unlocked and only
// then locked it to write, so a change that was read before another one was
// written put the file back without it.

test.skip(!container, 'reads the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

const N = 20;
const key = (i: number) => `fppTestsParallel${String(i).padStart(2, '0')}`;

test('twenty different settings changed at once all land in the settings file', async ({ request }) => {
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    request.put(`/api/settings/${key(i)}`, { data: `v${i}`, timeout: 30_000 })));
  // The control: every request was answered as done.
  expect(results.map((r) => r.status())).toEqual(Array(N).fill(200));
  const missing = Array.from({ length: N }, (_, i) => i).filter((i) => settingInFile(key(i)) !== `v${i}`).map(key);
  expect(missing, 'changes lost to a concurrent write').toEqual([]);
});
