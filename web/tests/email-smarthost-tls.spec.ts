import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, setSettingInFile, snapshotSettings } from './settings-file';

// Regression: fc0218b32 ("Exim4 smarthost implicit-TLS on port 465", #2922).
// Debian Trixie's split exim config no longer turns "::465" into implicit TLS
// by itself: the smarthost transport only uses smtps when
// REMOTE_SMTP_SMARTHOST_PROTOCOL is defined, so mail through a port-465 relay
// never connected. FPP now writes that macro into a file of its own for 465,
// and removes it for any other port, leaving the user's macros alone.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MAIN = '/etc/exim4/conf.d/main';
const MACRO = `${MAIN}/99_fpp_smarthost`;
const USER_MACROS = `${MAIN}/00_local_macros`;

test('port 465 gets the smtps macro, and another port has it removed', async ({ request }) => {
  const restore = snapshotSettings();
  const hadMain = exists(MAIN);
  // FPP's own copy of the mail config, which a player's image creates.
  const staged = `${MEDIA}/exim4`;
  const hadStaged = exists(staged);
  inPlayer('mkdir', '-p', MAIN, staged);
  putFile(USER_MACROS, 'FPP_TESTS_USER_MACRO=1\n');
  try {
    setSettingInFile('emailserver', 'smtp.example.com');
    setSettingInFile('emailuser', 'fpp-tests@example.com');
    setSettingInFile('emailtoemail', 'fpp-tests@example.com');

    setSettingInFile('emailport', '465');
    expect((await request.post('/api/email/configure')).ok()).toBe(true);
    expect(exists(MACRO), 'no smtps macro for port 465').toBe(true);
    expect(readFile(MACRO)).toContain('REMOTE_SMTP_SMARTHOST_PROTOCOL=smtps');

    setSettingInFile('emailport', '587');
    expect((await request.post('/api/email/configure')).ok()).toBe(true);
    expect(exists(MACRO), 'the smtps macro stayed for port 587').toBe(false);
    expect(readFile(USER_MACROS)).toBe('FPP_TESTS_USER_MACRO=1\n');
  } finally {
    restore();
    if (hadMain) inPlayer('rm', '-f', MACRO, USER_MACROS);
    else inPlayer('rm', '-rf', '/etc/exim4');
    if (!hadStaged) inPlayer('rm', '-rf', staged);
  }
});
