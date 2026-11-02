import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, SETTINGS, exists, putFile } from './settings-file';

// Regression: 7d003795f.  ReadSettingFromFile() checked that the main
// settings file existed before it switched to the plugin's own file, so on a
// player that has not written a settings file yet (a fresh install) every
// plugin setting read came back false, though the plugin's file was there.

test.skip(!container, 'moves the player settings file aside');

const PLUGIN = 'fpp-tests-plugin';
const FILE = `${MEDIA}/config/plugin.${PLUGIN}`;

test("a plugin's settings are read when the main settings file does not exist", async ({ request }) => {
  const hadFile = exists(FILE);
  expect(hadFile).toBe(false);
  putFile(FILE, 'greeting = "hello"\nlevel = 7\n');
  const aside = `${SETTINGS}.fpp-tests-aside`;
  try {
    const get = async (name: string) => (await (await request.get(`/api/plugin/${PLUGIN}/settings/${name}`)).json())[name];
    expect(await get('greeting'), 'the control: with the settings file').toBe('hello');

    inPlayer('mv', SETTINGS, aside);
    expect(exists(SETTINGS)).toBe(false);
    expect(await get('greeting')).toBe('hello');
    expect(await get('level')).toBe('7');
    expect(await get('nothere'), 'a setting the plugin does not have').toBe(false);
  } finally {
    inPlayer('sh', '-c', `[ -e '${aside}' ] && mv '${aside}' '${SETTINGS}'; rm -f '${FILE}'; true`);
  }
});
