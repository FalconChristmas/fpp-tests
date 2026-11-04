import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, readFile, setSettingInFile, snapshotSettings } from './settings-file';

// Regression: 67b16fc6e ("Initial Setup UI and outbound Email config
// enhancements").  The outbound mail server was gmail on port 587, whatever
// was wanted; emailserver and emailport now say which, for the smarthost and
// for the login that goes with it.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('the server and port set are the ones the mail config uses', async ({ request }) => {
  const restore = snapshotSettings();
  const staged = `${MEDIA}/exim4`;
  const hadStaged = exists(staged);
  const hadExim = exists('/etc/exim4');
  const hadAliases = exists('/etc/aliases');
  const hadAddresses = exists('/etc/email-addresses');
  inPlayer('mkdir', '-p', staged, '/etc/exim4');
  try {
    setSettingInFile('emailserver', 'mail.fpp-tests.example');
    setSettingInFile('emailport', '2525');
    setSettingInFile('emailuser', 'fpp-tests-user');
    setSettingInFile('emailpass', 'fpp-tests-pass');
    setSettingInFile('emailtoemail', 'fpp-tests@example.com');
    expect((await request.post('/api/email/configure')).ok()).toBe(true);

    const conf = readFile(`${staged}/update-exim4.conf.conf`);
    expect(conf).toContain("dc_smarthost='mail.fpp-tests.example::2525'");
    expect(conf).not.toContain('gmail');
    const passwd = readFile(`${staged}/passwd.client`);
    expect(passwd).toContain('mail.fpp-tests.example:fpp-tests-user:fpp-tests-pass');
    expect(passwd).not.toContain('gmail');
  } finally {
    restore();
    if (!hadStaged) inPlayer('rm', '-rf', staged);
    if (!hadExim) inPlayer('rm', '-rf', '/etc/exim4');
    if (!hadAliases) inPlayer('rm', '-f', '/etc/aliases');
    if (!hadAddresses) inPlayer('rm', '-f', '/etc/email-addresses');
  }
});
