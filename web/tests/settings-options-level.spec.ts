import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// Feature: eb375efc3 ("add ability for setting options visibility to be UI
// level dependant"). A select setting can give some of its options a UI
// level ("optionsLevel": {value: level}); PrintSettingSelect() leaves those
// out below that level, unless the option is the value already saved, which
// is always shown. No setting in settings.json uses it yet (a plugin's page
// can, through PrintSettingSelect's $sData), so the select is printed here
// by the tree's own common.php, in the player, for a setting that does, at
// each UI level.

test.skip(!container, 'runs the tree\'s PHP inside the run-web.sh container');

const DRIVER = '/tmp/fpp-tests-options-level.php';
const DRIVER_SRC = `<?php
// argv: uiLevel, saved value ('' for none)
chdir('/opt/fpp/www');
$skipJSsettings = 1;
require_once 'config.php';
require_once 'common.php';
$settings['uiLevel'] = intval($argv[1]);
unset($settings['fppTestsOptionsLevel']);
if ($argv[2] !== '') $settings['fppTestsOptionsLevel'] = $argv[2];
$values = array('Basic' => 'basic', 'Advanced' => 'advanced', 'Developer' => 'developer');
$sData = array('optionsLevel' => array('advanced' => 1, 'developer' => 3));
ob_start();
PrintSettingSelect('fpp-tests', 'fppTestsOptionsLevel', 0, 0, 'basic', $values, '', '', '', $sData);
$html = ob_get_clean();
preg_match_all("/<option value='([^']*)'/", $html, $m);
echo json_encode($m[1]);
`;

function offered(uiLevel: number, saved = ''): string[] {
  return JSON.parse(inPlayer('php', DRIVER, String(uiLevel), saved).trim().split('\n').pop()!);
}

test.beforeAll(() => putFile(DRIVER, DRIVER_SRC));
test.afterAll(() => inPlayer('rm', '-f', DRIVER));

test('a select leaves out the options above the UI level, except the saved one', () => {
  expect(offered(0), 'an Advanced option is offered at Basic level').toEqual(['basic']);
  expect(offered(1)).toEqual(['basic', 'advanced']);
  expect(offered(3)).toEqual(['basic', 'advanced', 'developer']);
  // What is saved is always shown, whatever the level.
  expect(offered(0, 'developer'), 'the saved value is hidden').toEqual(['basic', 'developer']);
});
