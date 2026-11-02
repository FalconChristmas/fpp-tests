import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, readFile, setSettingInFile, snapshotSettings } from './settings-file';

// Regression: 8d33ca97e (#1057).  ApplyEmailConfig() returned without writing
// anything unless the user name and password were both set, so a relay that
// takes mail without logging in (a local one) was never configured: no
// smarthost, no aliases.  It now needs only the address to send to, and
// writes a password file with no login line when there is none.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a mail relay with no user name or password is still configured', async ({ request }) => {
  const restore = snapshotSettings();
  const staged = `${MEDIA}/exim4`;
  const hadStaged = exists(staged);
  const hadExim = exists('/etc/exim4');
  const hadAliases = exists('/etc/aliases');
  const hadAddresses = exists('/etc/email-addresses');
  inPlayer('mkdir', '-p', staged, '/etc/exim4');
  try {
    setSettingInFile('emailserver', 'relay.example.com');
    setSettingInFile('emailport', '25');
    setSettingInFile('emailuser', '');
    setSettingInFile('emailpass', '');
    setSettingInFile('emailtoemail', 'fpp-tests@example.com');
    expect((await request.post('/api/email/configure')).ok()).toBe(true);

    // What FPP generated, and what the mail system got copied from it.
    expect(readFile(`${staged}/update-exim4.conf.conf`)).toContain("dc_smarthost='relay.example.com::25'");
    expect(readFile(`${staged}/aliases`)).toContain('fpp: fpp-tests@example.com');
    const passwd = readFile(`${staged}/passwd.client`);
    expect(passwd, 'the password file is written').toContain('# password file used when');
    expect(passwd, 'with no login in it').not.toContain('relay.example.com');
    expect(readFile('/etc/exim4/update-exim4.conf.conf')).toContain("dc_smarthost='relay.example.com::25'");
    expect(readFile('/etc/aliases')).toContain('pi: fpp-tests@example.com');
    expect(readFile('/etc/exim4/passwd.client')).not.toContain('relay.example.com');
  } finally {
    restore();
    if (!hadStaged) inPlayer('rm', '-rf', staged);
    if (!hadExim) inPlayer('rm', '-rf', '/etc/exim4');
    if (!hadAliases) inPlayer('rm', '-f', '/etc/aliases');
    if (!hadAddresses) inPlayer('rm', '-f', '/etc/email-addresses');
  }
});
