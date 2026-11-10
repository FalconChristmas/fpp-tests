import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// How the web UI reads values older FPPs left in the settings file
// (config.php's parser): the retired player modes "master" and "bridge" are
// read as player, master with MultiSync on as it implied, and a *Directory
// setting is given the trailing slash every path built on it expects.

test.skip(!container, "edits the player's settings file by hand");

let restore: () => void = () => {};
test.beforeEach(() => {
  restore = snapshotSettings();
});
test.afterEach(() => {
  restore();
});

const value = async (request: any, name: string) => (await (await request.get(`/api/settings/${name}`)).json()).value;

test('a settings file from when FPP had master and bridge modes is read as player mode', async ({ request }) => {
  setSettingInFile('MultiSyncEnabled', '0');
  setSettingInFile('fppMode', 'master');
  expect(await value(request, 'fppMode')).toBe('player');
  // A master sent MultiSync: a player does that only with it on.
  expect(await value(request, 'MultiSyncEnabled')).toBe('1');

  setSettingInFile('MultiSyncEnabled', '0');
  setSettingInFile('fppMode', 'bridge');
  expect(await value(request, 'fppMode')).toBe('player');
  expect(await value(request, 'MultiSyncEnabled')).toBe('0');

  // The modes there are now are read as they are.
  setSettingInFile('fppMode', 'remote');
  expect(await value(request, 'fppMode')).toBe('remote');
});

test('a directory setting is given its trailing slash', async ({ request }) => {
  // Any key ending in Directory (docsDirectory and the like are set from the
  // install afterwards, so one of the test's own).
  setSettingInFile('fppTestsDirectory', '/home/fpp/media/fpp-tests');
  expect(await value(request, 'fppTestsDirectory')).toBe('/home/fpp/media/fpp-tests/');
  setSettingInFile('fppTestsDirectory', '/home/fpp/media/fpp-tests/');
  expect(await value(request, 'fppTestsDirectory')).toBe('/home/fpp/media/fpp-tests/');
  // The control: another key is read as it is.
  setSettingInFile('fppTestsPath', '/home/fpp/media/fpp-tests');
  expect(await value(request, 'fppTestsPath')).toBe('/home/fpp/media/fpp-tests');
});
