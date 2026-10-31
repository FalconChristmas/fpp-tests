import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// config.php works out the board from files only a real board has
// (/etc/fpp/platform, the device tree's model).  The player is a container,
// so the tree's own config.php is run in it with just those paths pointed at
// files the test writes, and the result read back: the Platform, Variant,
// SubPlatform and Logo every page is drawn with, and any PHP warning.

test.skip(!container, "runs the tree's PHP inside the run-web.sh container");

const DIR = '/tmp/fpp-tests-platform';
const DRIVER = '/tmp/fpp-tests-platform.php';
const COPY = '/opt/fpp/www/fpp-tests-platform-config.php';
const DRIVER_SRC = `<?php
// config.php with the board's files replaced by ${DIR}/<name>; a name with no
// file there is a file the board doesn't have.
$src = file_get_contents('/opt/fpp/www/config.php');
foreach (array('/etc/fpp/platform' => 'platform', '/etc/fpp/container' => 'container',
    '/etc/fpp/desktop' => 'desktop', '/.dockerenv' => 'dockerenv',
    '/sys/firmware/devicetree/base/model' => 'model', '/proc/device-tree/model' => 'dtmodel') as $from => $to) {
    $src = str_replace('"' . $from . '"', '"${DIR}/' . $to . '"', $src);
}
// common.php, which config.php includes, includes the real config.php, which
// defines the same functions: the copy's are renamed out of the way.
$src = preg_replace('/^function (\\w+)/m', 'function fppTestsCopy_$1', $src);
file_put_contents('${COPY}', $src);
$warnings = array();
set_error_handler(function ($no, $str, $file, $line) use (&$warnings) {
    // (The copy defining config.php's constants again is the copy's doing.)
    if (basename($file) === basename('${COPY}') && strpos($str, 'already defined') === false) {
        $warnings[] = $str;
    }
    return true;
});
chdir('/opt/fpp/www');
$skipJSsettings = 1;
ob_start();
require '${COPY}';
ob_end_clean();
unlink('${COPY}');
echo json_encode(array('Platform' => $settings['Platform'], 'Variant' => $settings['Variant'],
    'SubPlatform' => $settings['SubPlatform'], 'Logo' => $settings['Logo'] ?? '', 'warnings' => $warnings));
`;

// files: name -> content for the board files that exist.
function board(files: Record<string, string>) {
  inPlayer('sh', '-c', `rm -rf ${DIR}; mkdir -p ${DIR}`);
  for (const [name, content] of Object.entries(files)) putFile(`${DIR}/${name}`, content);
  const out = inPlayer('php', DRIVER).trim().split('\n').pop()!;
  return JSON.parse(out);
}

test.beforeAll(() => putFile(DRIVER, DRIVER_SRC));
test.afterAll(() => inPlayer('rm', '-rf', DRIVER, DIR, COPY));

test('a Compute Module 5 is a Pi 5, with the Pi 5 logo', async ({ request }) => {
  // Regression: 5cd25ca4f.  Only "Pi 5" in the model was matched, and a CM5's
  // model is "Raspberry Pi Compute Module 5 ...", so it got no variant and
  // no logo.  Also 6d091224f: a Pi 5 is given its own variant and logo.
  const pi5 = board({ platform: 'Raspberry Pi\n', model: 'Raspberry Pi 5 Model B Rev 1.0\0' });
  expect(pi5.Variant, 'the control: a Pi 5 is recognised').toBe('Pi 5');
  const cm5 = board({ platform: 'Raspberry Pi\n', model: 'Raspberry Pi Compute Module 5 Rev 1.0\0' });
  expect(cm5.Platform).toBe('Raspberry Pi');
  expect(cm5.Variant).toBe('Pi 5');
  expect(cm5.Logo).toBe(pi5.Logo);
  // The receiving end: the header's <img src="images/<Logo>"> is served.
  expect((await request.get(`/images/${cm5.Logo}`)).status(), `images/${cm5.Logo}`).toBe(200);
});

test('a Debian box without a device tree model is detected without a warning', () => {
  // Regression: de7c79a2d.  On Debian (not in a container) config.php read
  // /proc/device-tree/model whether or not it existed, so a PC or VM without
  // a device tree logged a file_get_contents() warning on every page.
  const debian = board({ platform: 'Debian\n' });
  expect(debian.Platform).toBe('Debian');
  expect(debian.warnings).toEqual([]);
  // The control: a board that has one gets its model.
  const opi = board({ platform: 'Debian\n', dtmodel: 'Xunlong Orange Pi 5\0' });
  expect(opi.SubPlatform).toBe('Xunlong Orange Pi 5');
  expect(opi.Logo).toBe('orangepi_logo.png');
});
