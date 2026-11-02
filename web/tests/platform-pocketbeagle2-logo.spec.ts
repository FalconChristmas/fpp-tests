import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// config.php picks the header logo of a PocketBeagle2 by whether the board is
// the Industrial one.  The player is a container, so the tree's own config.php
// is run in it with the board's files pointed at files the test writes (see
// platform-detection.spec.ts), including /dev/mmcblk0, the eMMC.

test.skip(!container, "runs the tree's PHP inside the run-web.sh container");

const DIR = '/tmp/fpp-tests-pb2';
const DRIVER = '/tmp/fpp-tests-pb2.php';
const COPY = '/opt/fpp/www/fpp-tests-pb2-config.php';
const DRIVER_SRC = `<?php
$src = file_get_contents('/opt/fpp/www/config.php');
foreach (array('/etc/fpp/platform' => 'platform', '/etc/fpp/container' => 'container',
    '/etc/fpp/desktop' => 'desktop', '/.dockerenv' => 'dockerenv', '/dev/mmcblk0' => 'mmcblk0',
    '/sys/firmware/devicetree/base/model' => 'model', '/proc/device-tree/model' => 'dtmodel') as $from => $to) {
    $src = str_replace('"' . $from . '"', '"${DIR}/' . $to . '"', $src);
}
$src = preg_replace('/^function (\\w+)/m', 'function fppTestsCopy_$1', $src);
file_put_contents('${COPY}', $src);
chdir('/opt/fpp/www');
$skipJSsettings = 1;
ob_start();
require '${COPY}';
ob_end_clean();
unlink('${COPY}');
echo json_encode(array('Platform' => $settings['Platform'], 'Variant' => $settings['Variant'],
    'Logo' => $settings['Logo'] ?? ''));
`;

function board(files: Record<string, string>) {
  inPlayer('sh', '-c', `rm -rf ${DIR}; mkdir -p ${DIR}`);
  for (const [name, content] of Object.entries(files)) putFile(`${DIR}/${name}`, content);
  return JSON.parse(inPlayer('php', DRIVER).trim().split('\n').pop()!);
}

test.beforeAll(() => putFile(DRIVER, DRIVER_SRC));
test.afterAll(() => inPlayer('rm', '-rf', DRIVER, DIR, COPY));

test('a PocketBeagle2 Industrial has its own logo, and the plain board its own', async ({ request }) => {
  // Regression: c6cc6e822.  Both PocketBeagle2 boards shared the generic
  // PocketBeagle logo; the Industrial one (eMMC fitted) now has
  // beagle_pocket_2i.svg and the plain one beagle_pocket_2.svg.
  const files = { platform: 'BeagleBone 64\n', dtmodel: 'BeagleBoard.org PocketBeagle2\0' };
  const plain = board(files);
  expect(plain.Variant, 'the control: the board is recognised').toBe('PocketBeagle 2');
  expect(plain.Logo).toBe('beagle_pocket_2.svg');
  const industrial = board({ ...files, mmcblk0: '' });
  expect(industrial.Variant).toBe('PocketBeagle 2 Industrial');
  expect(industrial.Logo).toBe('beagle_pocket_2i.svg');
  // The receiving end: the header's <img src="images/<Logo>"> is served, as SVG.
  for (const logo of [plain.Logo, industrial.Logo]) {
    const r = await request.get(`/images/${logo}`);
    expect(r.status(), logo).toBe(200);
    expect(r.headers()['content-type'], logo).toContain('image/svg+xml');
  }
});
