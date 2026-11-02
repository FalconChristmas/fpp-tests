import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// Regression: 6193c553c ("Add cape selection input back to Initial Setup
// page").  4bc63f34a had taken InstalledCape out of the initialSetup group,
// so a Pi or BeagleBone with a cape that has no EEPROM could not say which
// cape it had while being set up.  The setting is for those boards only and
// is hidden once a cape is detected (cape-info.json exists).

test.skip(!container, 'runs the tree\'s PHP inside the run-web.sh container');

const DRIVER = '/tmp/fpp-tests-initial-setup-cape.php';
const DRIVER_SRC = `<?php
// argv: platform.  Whether the initialSetup group lists InstalledCape, and
// whether ShouldPrintSetting() draws it on that board.
chdir('/opt/fpp/www');
$skipJSsettings = 1;
require_once 'config.php';
require_once 'common.php';
LoadSettingInfos();
$settings['Platform'] = $argv[1];
$settings['Variant'] = $argv[1];
$settings['uiLevel'] = 0;
echo json_encode(array(
  'inGroup' => in_array('InstalledCape', $settingGroups['initialSetup']['settings']),
  'shown' => ShouldPrintSetting($settingInfos['InstalledCape']),
));
`;

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';

function ask(platform: string): { inGroup: boolean; shown: boolean } {
  return JSON.parse(inPlayer('php', DRIVER, platform).trim().split('\n').pop()!);
}

let savedCapeInfo: string | null = null;
test.beforeAll(() => {
  putFile(DRIVER, DRIVER_SRC);
  const out = inPlayer('sh', '-c', `if [ -e ${CAPE_INFO} ]; then echo yes; cat ${CAPE_INFO}; else echo no; fi`);
  savedCapeInfo = out.startsWith('yes\n') ? out.slice(4) : null;
  inPlayer('rm', '-f', CAPE_INFO);
});
test.afterAll(() => {
  inPlayer('rm', '-f', DRIVER);
  if (savedCapeInfo !== null) putFile(CAPE_INFO, savedCapeInfo);
});

test('a Pi with no detected cape is asked for its cape during initial setup', () => {
  const pi = ask('Raspberry Pi');
  expect(pi.inGroup, 'InstalledCape is in the initialSetup group').toBe(true);
  expect(pi.shown, 'drawn on a Pi with no cape-info.json').toBe(true);
  // The control: it is a Pi/BeagleBone setting; this player's own kind of
  // board is not asked.
  expect(ask('Debian').shown).toBe(false);
});
