import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// get_server_cpu_usage() (common.php, behind api/system/info's
// Utilization.CPU) works the CPU use out from two samples of /proc/stat's
// cpu line: the one it saved last time in /tmp/cpustats.txt and the one now.

test.skip(!container, 'runs common.php inside the run-web.sh container');

// The tree's own get_cpu_stats() and get_server_cpu_usage(), taken out of
// common.php and run in a namespace of their own, where /proc/stat reads as
// the test's line and /tmp/cpustats.txt is a file of the test's: the
// unqualified file calls in them resolve to the namespace's functions first.
const DRIVER = String.raw`<?php
namespace FppTests;
const STAT = "cpu  1000 20 300 40000 50 6 7 0 0 0\ncpu0 1000 20 300 40000 50 6 7 0 0 0\n";
const SAVED = '/tmp/fpp-tests-cpustats.txt';
function path($f) { return $f === '/tmp/cpustats.txt' ? SAVED : $f; }
function file_get_contents($f, ...$a) { return $f === '/proc/stat' ? STAT : \file_get_contents(path($f), ...$a); }
function file_put_contents($f, ...$a) { return \file_put_contents(path($f), ...$a); }
function file_exists($f) { return \file_exists(path($f)); }
$settings = array('Platform' => 'Linux');
$src = \file_get_contents('/opt/fpp/www/common.php');
foreach (array('get_cpu_stats', 'get_server_cpu_usage') as $fn) {
    if (!preg_match('/^function ' . $fn . '\(\).*?^}/ms', $src, $m)) {
        fwrite(STDERR, "$fn() not found in common.php\n");
        exit(2);
    }
    eval('namespace FppTests; ' . $m[0]);
}
echo json_encode(get_server_cpu_usage());
`;

test('the CPU use of an interval with no ticks in it is a number, not a division by zero', async () => {
  // Regression: 0e13adeaf ("Fix Division by zero").  Two samples taken in
  // the same tick (two status requests at once) differ by nothing, and the
  // idle share was divided by that zero total: PHP 8 throws, and the request
  // died with a fatal error.
  inPlayer('rm', '-f', '/tmp/fpp-tests-cpustats.txt');
  putFile('/tmp/fpp-tests-cpu.php', DRIVER);
  try {
    // No saved sample: it takes one, and then the same one again.
    const first = inPlayer('sh', '-c', 'php /tmp/fpp-tests-cpu.php 2>&1; echo " rc=$?"');
    expect(first, 'with no saved sample').toMatch(/^-?[0-9.]+ rc=0\n?$/);
    // A saved sample the same as the one now.
    const second = inPlayer('sh', '-c', 'php /tmp/fpp-tests-cpu.php 2>&1; echo " rc=$?"');
    expect(second, 'with the same saved sample').toMatch(/^-?[0-9.]+ rc=0\n?$/);
    // The control: a real interval is worked out (100 idle of 200 ticks).
    putFile('/tmp/fpp-tests-cpustats.txt', '900 20 300 39900 50 6 7');
    const real = inPlayer('sh', '-c', 'php /tmp/fpp-tests-cpu.php 2>&1; echo " rc=$?"');
    expect(real).toMatch(/^50(\.0+)? rc=0\n?$/);
  } finally {
    inPlayer('rm', '-f', '/tmp/fpp-tests-cpu.php', '/tmp/fpp-tests-cpustats.txt');
  }
});
