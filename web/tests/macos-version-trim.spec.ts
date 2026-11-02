import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// On macOS the player reads the OS version from `sw_vers -productVersion`,
// which ends in a newline.  Stood in for here with a stub on PATH and the
// platform file saying Darwin.

test.skip(!container, 'changes the platform and PATH inside the run-web.sh container');
test.describe.configure({ mode: 'serial' });

const PLATFORM = '/etc/fpp/platform';
const SAVED = '/tmp/fpp-tests-platform.saved';
const STUB = '/usr/local/bin/sw_vers';
// The marker that makes the player a Docker one is checked before Darwin.
const MARKER = '/etc/fpp/container';

test.beforeEach(() => {
  inPlayer('sh', '-c', `mkdir -p /etc/fpp /usr/local/bin
    if [ -e ${PLATFORM} ]; then cp -a ${PLATFORM} ${SAVED}; else rm -f ${SAVED}; fi
    printf Darwin > ${PLATFORM}
    mv ${MARKER} ${MARKER}.saved
    printf '#!/bin/sh\\necho 15.1\\n' > ${STUB}; chmod +x ${STUB}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `mv ${MARKER}.saved ${MARKER}; rm -f ${STUB}; if [ -e ${SAVED} ]; then mv ${SAVED} ${PLATFORM}; else rm -f ${PLATFORM}; fi`);
});

test('the macOS version reported by the player has no trailing newline', async ({ request }) => {
  // Regression: 5162a9ec2.  The command's newline stayed on the variant and
  // the OS release, so the version the player reports carried a line break.
  const r = await request.get('/api/system/info');
  expect(r.ok(), await r.text()).toBe(true);
  const info = await r.json();
  expect(info.Platform, JSON.stringify(info)).toBe('MacOS');
  expect(info.Variant).toBe('15.1');
  expect(info.OSRelease).toBe('15.1');
  expect(info.OSVersion).toBe('15.1');
});
