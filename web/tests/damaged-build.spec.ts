import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// A power loss before a fresh build is written back can leave fppd, fppinit
// or libfpp zero-filled: still executable by mode, but every start fails with
// "Exec format error".  Nothing noticed: the update check reported the build
// as current and the health check passed.  Fixed in fpp da7431d15
// ("fix(update): detect a zero-filled fppd build and offer a rebuild"), which
// checks each binary's executable header.
//
// fppinit stands for the rest: it is not running, unlike fppd and libfpp.so,
// which the test player's fppd has mapped.

const BIN = '/opt/fpp/src/fppinit';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a zero-filled binary is reported as a damaged build', async ({ request }) => {
  test.setTimeout(120_000);
  inPlayer('cp', '-p', BIN, '/tmp/fpp-tests-fppinit.bak');
  try {
    // The control: the intact build is not reported as damaged.
    expect(inPlayer('sh', '-c', '/opt/fpp/scripts/healthCheck 2>&1 || true')).not.toContain('damaged');

    inPlayer('dd', 'if=/dev/zero', `of=${BIN}`, 'bs=4', 'count=1', 'conv=notrunc', 'status=none');
    const status = await (await request.get('/api/system/updateStatus', { timeout: 90_000 })).json();
    expect(status.versionUnknown, JSON.stringify(status)).toBe(true);
    expect(inPlayer('sh', '-c', '/opt/fpp/scripts/healthCheck 2>&1 || true')).toContain('FPPD executable is damaged');
  } finally {
    inPlayer('cp', '-p', '/tmp/fpp-tests-fppinit.bak', BIN);
    inPlayer('rm', '-f', '/tmp/fpp-tests-fppinit.bak');
  }
});
