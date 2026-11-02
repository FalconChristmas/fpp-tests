import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { php } from './privacy-helpers';

// Three small helpers in www/common.php, run in the player as the pages and
// the API run them: the wifi strength lookup's platform test, the setting
// widgets' change callbacks, and which settings a platform shows.

test.skip(!container, 'runs PHP inside the run-web.sh container');

test.describe('wifi strength', () => {
  const AIRPORT = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
  const MARKER = '/tmp/fpp-tests-airport-ran';
  test.beforeEach(() => {
    // The macOS tool the lookup runs on a Mac, stood in for by one that
    // leaves a marker when run.
    inPlayer('sh', '-c', `mkdir -p "$(dirname ${AIRPORT})"; rm -f ${MARKER}
printf '#!/bin/sh\\ntouch ${MARKER}\\necho "agrCtlRSSI: -40"\\n' > ${AIRPORT}; chmod +x ${AIRPORT}`);
  });
  test.afterEach(() => {
    inPlayer('sh', '-c', `rm -rf /System ${MARKER}`);
  });

  test('looking up the wifi strength on Linux does not turn the platform into a Mac', () => {
    // Regression: 63fc07d8a.  The test was `$settings["Platform"] = "MacOS"`,
    // an assignment: every call ran the Mac's airport tool and left the
    // platform as MacOS for the rest of the request.
    const out = JSON.parse(php(`
$settings['Platform'] = 'Linux';
$wifi = network_wifi_strength_obj();
echo json_encode(array('platform' => $settings['Platform'], 'wifi' => $wifi));
`));
    expect(out.platform).toBe('Linux');
    // The receiving end: the Mac's tool was never run, and nothing in the
    // answer came from it.
    expect(inPlayer('sh', '-c', `test -e ${MARKER} && echo ran || echo no`).trim()).toBe('no');
    expect(JSON.stringify(out.wifi)).not.toContain('excellent');

    // The control: on a Mac it is run, and its answer is the lookup's.
    const mac = JSON.parse(php(`
$settings['Platform'] = 'MacOS';
echo json_encode(network_wifi_strength_obj());
`));
    expect(inPlayer('sh', '-c', `test -e ${MARKER} && echo ran || echo no`).trim()).toBe('ran');
    expect(mac[0].desc).toBe('excellent');
  });
});

test.describe('setting callbacks', () => {
  test("a callback that is already a call is used as written, not called a second time", () => {
    // Regression: 67cfb834b.  A callback given as `fn(1)` got `('setting');`
    // added, so the page ran `fn(1)('setting');` -- a call of what fn(1)
    // returned.  The checkbox, select, saved text and Save widgets all test
    // for the closing parenthesis.
    const out = php(`
PrintSettingCheckbox('T', 'fppTestsCb', 0, 0, 1, 0, '', 'fppTestsCallback(1)');
echo "\\n---\\n";
PrintSettingSelect('T', 'fppTestsSel', 0, 0, 'a', array('A' => 'a'), '', 'fppTestsCallback(1)');
echo "\\n---\\n";
PrintSettingTextSaved('fppTestsText', 0, 0, 32, 32, '', '', 'fppTestsCallback(1)');
echo "\\n---\\n";
PrintSettingSave('T', 'fppTestsSave', 0, 0, '', 'fppTestsCallback(1)');
echo "\\n---\\n";
PrintSettingSelect('T', 'fppTestsPlain', 0, 0, 'a', array('A' => 'a'), '', 'fppTestsCallback');
`);
    const [checkbox, select, text, save, plain] = out.split('\n---\n');
    for (const [name, html] of Object.entries({ checkbox, select, text, save })) {
      expect(html, name).toMatch(/fppTestsCallback\(1\)(?!\()/);
      expect(html, `${name} called the result of the callback`).not.toMatch(/fppTestsCallback\(1\)\(/);
    }
    // The control: a bare function name is still called with the setting.
    expect(plain).toContain("fppTestsCallback('fppTestsPlain');");
  });
});

test.describe('settings by platform', () => {
  test('a setting that only excludes platforms is shown on every other platform', () => {
    // Regression: 6c07380af.  The platforms list was tested with in_array(),
    // so a list holding only exclusions ("!BeagleBone Black") hid the setting
    // everywhere, the platforms it was meant for included.
    const shown = JSON.parse(php(`
$cases = array(
    'only an exclusion, other platform' => array('Raspberry Pi', array('!BeagleBone Black')),
    'only an exclusion, that platform'  => array('BeagleBone Black', array('!BeagleBone Black')),
    'ALL'                               => array('Raspberry Pi', array('ALL')),
    'ALL but one, that one'             => array('Raspberry Pi', array('ALL', '!Raspberry Pi')),
    'named platform'                    => array('Raspberry Pi', array('Raspberry Pi', 'BeagleBone Black')),
    'other platforms named'             => array('Raspberry Pi', array('BeagleBone Black')),
    'named and excluded'                => array('BeagleBone Black', array('BeagleBone Black', '!Raspberry Pi')),
);
$settings['uiLevel'] = 3;
$out = array();
foreach ($cases as $name => $c) {
    $settings['Platform'] = $c[0];
    $out[$name] = ShouldPrintSetting(array('platforms' => $c[1]));
}
echo json_encode($out);
`));
    expect(shown).toEqual({
      'only an exclusion, other platform': true,
      'only an exclusion, that platform': false,
      'ALL': true,
      'ALL but one, that one': false,
      'named platform': true,
      'other platforms named': false,
      'named and excluded': true,
    });
  });
});
