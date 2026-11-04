import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The video output lists on a system with no /sys/class/drm: FPP's own Docker
// platform, a headless VM, a board with no DRM driver.  The hosts this runs on
// have one, and a container can't unmount it, so a PHP of its own is kept away
// from it with open_basedir: scandir() fails there exactly as on a missing
// directory.

test('the video output list is built when /sys/class/drm cannot be read', () => {
  // Regression: 0cb9e35ac.  scandir() returned false, and array_diff() threw a
  // TypeError on it, so the API died with no list.  The function, not the route: open_basedir
  // can only be set on a PHP of its own.
  test.skip(!container, 'runs PHP in the run-web.sh container');
  const out = inPlayer('php', '-d', 'open_basedir=/opt/fpp/www:/tmp', '-d', 'display_errors=1', '-d', 'html_errors=0', '-r',
    'function json($x) { return json_encode($x); } ' +
    '$settings = array(); require "/opt/fpp/www/api/controllers/options.php"; ' +
    'echo "LIST:" . GetOptions_VideoOutput(true);');
  const m = /LIST:(\{.*\})/.exec(out);
  expect(m, out).toBeTruthy();
  expect(JSON.parse(m![1])).toMatchObject({ '--Default--': '--Default--', Disabled: 'Disabled' });
});
